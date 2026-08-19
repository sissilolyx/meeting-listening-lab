import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertProviderSelectionAvailable,
  getAiProviderStatuses,
  parseCodexModels,
  parseCursorModels,
  runStructured,
  validateStructuredValue,
} from "../lib/ai-providers.mjs";

const probeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "message"],
  properties: {
    ok: { type: "boolean" },
    message: { type: "string", minLength: 1 },
  },
};

test("dynamic model parsers keep only public Codex models and tolerate Cursor catalogs", () => {
  assert.deepEqual(parseCodexModels(JSON.stringify({ models: [
    { slug: "visible", display_name: "Visible", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
  ] })), [{ id: "visible", label: "Visible", reasoningLevels: ["low"] }]);
  assert.deepEqual(parseCursorModels(JSON.stringify({ models: [
    { id: "cursor-fast", name: "Cursor Fast" },
    "cursor-auto",
  ] })), [
    { id: "cursor-fast", label: "Cursor Fast" },
    { id: "cursor-auto", label: "cursor-auto" },
  ]);
  assert.deepEqual(parseCursorModels([
    "Available models",
    "",
    "cursor-balanced - Cursor Balanced (current)",
    "cursor-auto (default)",
    "Tip: use --model <id> to select a model",
  ].join("\n")), [
    { id: "cursor-balanced", label: "Cursor Balanced" },
    { id: "cursor-auto", label: "cursor-auto" },
  ]);
});

test("local schema validation is strict about required and additional fields", () => {
  assert.equal(validateStructuredValue({ ok: true, message: "connected" }, probeSchema), true);
  assert.throws(() => validateStructuredValue({ ok: true }, probeSchema), /message.*缺失/);
  assert.throws(() => validateStructuredValue({ ok: true, message: "connected", token: "secret" }, probeSchema), /未允许字段/);
});

test("fake Codex and Cursor CLIs run only in empty temporary cwd with stdin prompts", async () => {
  const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-provider-bin-"));
  const recordPath = path.join(fakeBin, "records.jsonl");
  const counterPath = path.join(fakeBin, "cursor-count.txt");
  const previousPath = process.env.PATH;
  const previousSyntheticSecret = process.env.MEETING_LISTENING_SYNTHETIC_SECRET;
  try {
    await installFakeProviders(fakeBin, recordPath, counterPath);
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
    process.env.MEETING_LISTENING_SYNTHETIC_SECRET = "must-not-reach-provider";

    const providers = await getAiProviderStatuses();
    assert.equal(providers.codex.authenticated, true);
    assert.deepEqual(providers.codex.models.map((item) => item.id), ["codex-synthetic"]);
    assert.equal(providers.cursor.authenticated, true);
    assert.deepEqual(providers.cursor.models.map((item) => item.id), ["cursor-synthetic"]);
    assert.deepEqual(assertProviderSelectionAvailable(
      { provider: "cursor", model: "cursor-synthetic" },
      providers,
    ), { provider: "cursor", model: "cursor-synthetic" });
    assert.throws(() => assertProviderSelectionAvailable(
      { provider: "cursor", model: "invented" },
      providers,
    ), /动态模型目录/);

    const codexResult = await runStructured({
      provider: "codex",
      model: "codex-synthetic",
      prompt: "synthetic codex probe",
      schema: probeSchema,
      timeoutMs: 10_000,
    });
    assert.deepEqual(codexResult, { ok: true, message: "connected" });

    const cursorResult = await runStructured({
      provider: "cursor",
      model: "cursor-synthetic",
      prompt: "synthetic cursor probe",
      schema: probeSchema,
      timeoutMs: 10_000,
    });
    assert.deepEqual(cursorResult, { ok: true, message: "connected" });
    assert.equal(Number(await fs.readFile(counterPath, "utf8")), 2, "Cursor format failures retry exactly once");

    const records = (await fs.readFile(recordPath, "utf8")).trim().split("\n").map(JSON.parse);
    const generationRecords = records.filter((item) => item.kind === "codex-exec" || item.kind === "cursor-print");
    assert.equal(generationRecords.length, 3);
    for (const record of generationRecords) {
      assert.match(record.cwd, /meeting-listening-ai-/);
      assert.deepEqual(record.entries.sort(), record.kind === "cursor-print" ? [".cursor", "schema.json"] : ["schema.json"]);
      assert.match(record.input, /synthetic/);
      assert.equal(record.secretPresent, false, "unrelated parent environment variables are not inherited");
      assert.equal(record.args.join(" ").includes("synthetic codex probe"), false, "prompt text never enters argv");
      assert.equal(record.args.join(" ").includes("synthetic cursor probe"), false, "prompt text never enters argv");
      await assert.rejects(fs.access(record.cwd), /ENOENT/, "temporary provider cwd is removed after the call");
    }
    for (const record of generationRecords.filter((item) => item.kind === "cursor-print")) {
      assert.match(record.permissions, /Shell\(\*\)/);
      assert.match(record.permissions, /Read\(\/\*\*\)/);
      assert.deepEqual(record.args.slice(0, 8), [
        "--mode", "ask",
        "--sandbox", "enabled",
        "--exclude-workspace-context",
        "--trust",
        "--allowed-tools", "reflect_tool_call",
      ]);
      assert.equal(record.args.includes("--exclude-tools"), true);
      assert.match(record.args[record.args.indexOf("--exclude-tools") + 1], /web_search_tool_call/);
      assert.match(record.args[record.args.indexOf("--exclude-tools") + 1], /mcp_tool_call/);
      assert.equal(record.args.includes("--force"), false);
    }
    const codexRecord = generationRecords.find((item) => item.kind === "codex-exec");
    assert.equal(codexRecord.args.includes("--disable"), true);
    assert.match(codexRecord.args.join(" "), /--disable shell_tool/);
    assert.match(codexRecord.args.join(" "), /--disable browser_use/);
    assert.equal(records.some((item) => item.binary === "agent"), false, "cursor-agent is preferred over generic agent");
  } finally {
    process.env.PATH = previousPath;
    if (previousSyntheticSecret === undefined) delete process.env.MEETING_LISTENING_SYNTHETIC_SECRET;
    else process.env.MEETING_LISTENING_SYNTHETIC_SECRET = previousSyntheticSecret;
    await fs.rm(fakeBin, { recursive: true, force: true });
  }
});

test("providers fail closed before authentication or generation when safety flags are unsupported", async () => {
  const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-unsafe-provider-bin-"));
  const unexpectedRecord = path.join(fakeBin, "unexpected.txt");
  const previousPath = process.env.PATH;
  try {
    await installIncompatibleProviders(fakeBin, unexpectedRecord);
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
    const providers = await getAiProviderStatuses();
    assert.equal(providers.codex.installed, true);
    assert.equal(providers.codex.authenticated, false);
    assert.deepEqual(providers.codex.models, []);
    assert.match(providers.codex.error, /安全隔离参数/);
    assert.equal(providers.cursor.installed, true);
    assert.equal(providers.cursor.authenticated, false);
    assert.deepEqual(providers.cursor.models, []);
    assert.match(providers.cursor.error, /安全隔离参数/);
    await assert.rejects(fs.access(unexpectedRecord), /ENOENT/, "no login, model discovery, or generation runs after the safety preflight fails");
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(fakeBin, { recursive: true, force: true });
  }
});

test("Cursor error envelopes fail once without a paid format retry", async () => {
  const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-cursor-error-bin-"));
  const counterPath = path.join(fakeBin, "cursor-count.txt");
  const previousPath = process.env.PATH;
  try {
    await installCursorErrorProvider(fakeBin, counterPath);
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
    const providers = await getAiProviderStatuses();
    assert.equal(providers.cursor.authenticated, true);
    assert.deepEqual(providers.cursor.models.map((item) => item.id), ["cursor-error-synthetic"]);

    await assert.rejects(runStructured({
      provider: "cursor",
      model: "cursor-error-synthetic",
      prompt: "synthetic error envelope probe",
      schema: probeSchema,
      timeoutMs: 10_000,
    }), /Cursor.*失败状态.*未再次消耗额度重试/);
    assert.equal(Number(await fs.readFile(counterPath, "utf8")), 1);
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(fakeBin, { recursive: true, force: true });
  }
});

async function installFakeProviders(directory, recordPath, counterPath) {
  const recordLiteral = JSON.stringify(recordPath);
  const counterLiteral = JSON.stringify(counterPath);
  await writeExecutable(path.join(directory, "codex"), `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "login") { console.log("Logged in using synthetic account"); process.exit(0); }
if (args[0] === "debug") {
  console.log(JSON.stringify({ models: [{ slug: "codex-synthetic", display_name: "Codex Synthetic", visibility: "list" }] }));
  process.exit(0);
}

if (args[0] === "exec" && args.includes("--help")) { console.log("Codex exec safety options accepted"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const outputIndex = args.indexOf("--output-last-message");
  fs.appendFileSync(${recordLiteral}, JSON.stringify({ binary: "codex", kind: "codex-exec", cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), input, args, secretPresent: Boolean(process.env.MEETING_LISTENING_SYNTHETIC_SECRET) }) + "\\n");
  fs.writeFileSync(args[outputIndex + 1], JSON.stringify({ ok: true, message: "connected" }));
});
`);
  await writeExecutable(path.join(directory, "cursor-agent"), `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--help")) { console.log("Cursor Agent CLI --mode <mode> --sandbox <setting>"); process.exit(0); }
if (args[0] === "status") { console.log("Logged in"); process.exit(0); }
if (args[0] === "models") { console.log(JSON.stringify({ models: [{ id: "cursor-synthetic", name: "Cursor Synthetic" }] })); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const count = Number(fs.existsSync(${counterLiteral}) ? fs.readFileSync(${counterLiteral}, "utf8") : 0) + 1;
  fs.writeFileSync(${counterLiteral}, String(count));
  fs.appendFileSync(${recordLiteral}, JSON.stringify({ binary: "cursor-agent", kind: "cursor-print", cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), permissions: fs.readFileSync(".cursor/cli.json", "utf8"), input, args, secretPresent: Boolean(process.env.MEETING_LISTENING_SYNTHETIC_SECRET) }) + "\\n");
  const result = count === 1 ? "not-json" : JSON.stringify({ ok: true, message: "connected" });
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result }));
});
`);
  await writeExecutable(path.join(directory, "agent"), `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${recordLiteral}, JSON.stringify({ binary: "agent", args: process.argv.slice(2) }) + "\\n");
console.log("unrelated generic agent");
process.exit(1);
`);
}

async function installIncompatibleProviders(directory, unexpectedRecord) {
  const unexpectedLiteral = JSON.stringify(unexpectedRecord);
  await writeExecutable(path.join(directory, "codex"), `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "exec" && args.includes("--help")) process.exit(2);
fs.writeFileSync(${unexpectedLiteral}, "codex advanced past safety preflight");
process.exit(1);
`);
  await writeExecutable(path.join(directory, "cursor-agent"), `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") { console.log("Cursor Agent CLI --mode <mode> --sandbox <setting>"); process.exit(0); }
if (args.includes("--help") && args.includes("--allowed-tools")) process.exit(2);
fs.writeFileSync(${unexpectedLiteral}, "cursor advanced past safety preflight");
process.exit(1);
`);
}

async function installCursorErrorProvider(directory, counterPath) {
  const counterLiteral = JSON.stringify(counterPath);
  await writeExecutable(path.join(directory, "codex"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "exec" && args.includes("--help")) process.exit(2);
process.exit(1);
`);
  await writeExecutable(path.join(directory, "cursor-agent"), `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--help")) { console.log("Cursor Agent CLI --mode <mode> --sandbox <setting>"); process.exit(0); }
if (args[0] === "status") { console.log("Logged in"); process.exit(0); }
if (args[0] === "models") { console.log(JSON.stringify({ models: [{ id: "cursor-error-synthetic", name: "Cursor Error Synthetic" }] })); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const count = Number(fs.existsSync(${counterLiteral}) ? fs.readFileSync(${counterLiteral}, "utf8") : 0) + 1;
  fs.writeFileSync(${counterLiteral}, String(count));
  console.log(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: JSON.stringify({ ok: true, message: "must not pass" }) }));
});
`);
}

async function writeExecutable(target, contents) {
  await fs.writeFile(target, contents, "utf8");
  await fs.chmod(target, 0o755);
}
