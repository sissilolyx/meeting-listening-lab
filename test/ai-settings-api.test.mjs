import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const APP_ROOT = path.resolve(import.meta.dirname, "..");

test("AI settings API validates live models, persists atomically, and tests without business data", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-ai-api-data-"));
  const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-ai-api-bin-"));
  const promptRecord = path.join(fakeBin, "prompt.txt");
  const callCountRecord = path.join(fakeBin, "call-count.txt");
  const port = await availablePort();
  let server;
  try {
    await installFakeCodex(fakeBin, promptRecord, callCountRecord);
    process.env.LISTENING_DATA_DIR = dataRoot;
    const storage = await import(`../lib/storage.mjs?ai-settings-api=${Date.now()}`);
    await storage.ensureStorage();
    server = spawn(process.execPath, ["server.mjs"], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        LISTENING_DATA_DIR: dataRoot,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer(server);

    const endpoint = `http://127.0.0.1:${port}/api/ai-settings`;
    const initial = await jsonRequest(endpoint);
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.payload.settings, { configured: false, provider: "", model: "" });
    assert.deepEqual(initial.payload.providers.codex.models.map((item) => item.id), ["synthetic-a", "synthetic-b"]);

    const testOnly = await jsonRequest(`${endpoint}/test`, {
      method: "POST",
      body: { provider: "codex", model: "synthetic-a" },
    });
    assert.equal(testOnly.status, 200);
    assert.equal(testOnly.payload.result.ok, true);
    assert.match(await fs.readFile(promptRecord, "utf8"), /synthetic data only/);
    await assert.rejects(fs.access(path.join(dataRoot, "settings.json")), /ENOENT/, "connection test does not save settings");
    assert.deepEqual((await fs.readdir(dataRoot)).sort(), ["jobs", "materials", "trash"]);

    const crossSite = await jsonRequest(`${endpoint}/test`, {
      method: "POST",
      body: { provider: "codex", model: "synthetic-a" },
      headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
    });
    assert.equal(crossSite.status, 403);
    const hostRebinding = await jsonRequest(`${endpoint}/test`, {
      method: "POST",
      body: { provider: "codex", model: "synthetic-a" },
      headers: { Host: "attacker.example", Origin: "http://attacker.example" },
    });
    assert.equal(hostRebinding.status, 403);
    const wrongContentType = await jsonRequest(`${endpoint}/test`, {
      method: "POST",
      body: { provider: "codex", model: "synthetic-a" },
      contentType: "text/plain",
    });
    assert.equal(wrongContentType.status, 415);
    assert.equal(Number(await fs.readFile(callCountRecord, "utf8")), 1, "blocked browser requests do not consume an AI call");

    const unknown = await jsonRequest(endpoint, {
      method: "PATCH",
      body: { provider: "codex", model: "invented" },
    });
    assert.equal(unknown.status, 409);

    const secret = await jsonRequest(endpoint, {
      method: "PATCH",
      body: { provider: "codex", model: "synthetic-a", token: "must-not-persist" },
    });
    assert.equal(secret.status, 400);

    const writes = await Promise.all(["synthetic-a", "synthetic-b"].map((model) => jsonRequest(endpoint, {
      method: "PATCH",
      body: { provider: "codex", model },
    })));
    assert.deepEqual(writes.map((item) => item.status), [200, 200]);
    const saved = JSON.parse(await fs.readFile(path.join(dataRoot, "settings.json"), "utf8"));
    assert.equal(saved.provider, "codex");
    assert.ok(["synthetic-a", "synthetic-b"].includes(saved.model));
    assert.deepEqual(Object.keys(saved).sort(), ["model", "provider"]);
    const final = await jsonRequest(endpoint);
    assert.equal(final.payload.settings.configured, true);
    assert.deepEqual(final.payload.settings, { configured: true, ...saved });

    await jsonRequest(endpoint, { method: "PATCH", body: { provider: "codex", model: "synthetic-a" } });
    const material = await storage.createMaterial({ title: "Synthetic provider snapshot" });
    material.status = "ready";
    material.sentences = [{ id: "sentence-snapshot", speaker: "Synthetic", start: 0, text: "A fully synthetic sentence." }];
    await storage.saveMaterial(material);
    const analysisStart = await jsonRequest(`http://127.0.0.1:${port}/api/materials/${material.id}/analyze`, {
      method: "POST",
      body: {},
    });
    assert.equal(analysisStart.status, 202);
    assert.deepEqual(analysisStart.payload.job.aiProvider, { provider: "codex", model: "synthetic-a" });
    await jsonRequest(endpoint, { method: "PATCH", body: { provider: "codex", model: "synthetic-b" } });
    const completedJob = await waitForJob(port, analysisStart.payload.job.id);
    assert.equal(completedJob.status, "completed");
    const analyzed = await storage.readMaterial(material.id);
    assert.deepEqual(analyzed.analysisProvider, { provider: "codex", model: "synthetic-a" });
    assert.equal(analyzed.sentences[0].analysis.translationZh, "合成翻译");
    const artifacts = (await fs.readdir(path.join(dataRoot, "materials", material.id)))
      .filter((name) => name.startsWith("ai-codex-full-") && name.endsWith(".json"));
    assert.equal(artifacts.length, 1);
    const artifact = JSON.parse(await fs.readFile(path.join(dataRoot, "materials", material.id, artifacts[0]), "utf8"));
    assert.deepEqual(artifact.aiProvider, { provider: "codex", model: "synthetic-a" });
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("exit", resolve));
    }
    await Promise.all([
      fs.rm(dataRoot, { recursive: true, force: true }),
      fs.rm(fakeBin, { recursive: true, force: true }),
    ]);
  }
});

async function installFakeCodex(directory, promptRecord, callCountRecord) {
  const target = path.join(directory, "codex");
  const promptRecordLiteral = JSON.stringify(promptRecord);
  const callCountRecordLiteral = JSON.stringify(callCountRecord);
  await fs.writeFile(target, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "login") { console.log("Logged in using synthetic account"); process.exit(0); }
if (args[0] === "debug") {
  console.log(JSON.stringify({ models: [
    { slug: "synthetic-a", display_name: "Synthetic A", visibility: "list" },
    { slug: "synthetic-b", display_name: "Synthetic B", visibility: "list" },
    { slug: "hidden", display_name: "Hidden", visibility: "hidden" }
  ] }));
  process.exit(0);
}
if (args[0] === "exec" && args.includes("--help")) { console.log("Codex exec safety options accepted"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(${promptRecordLiteral}, input);
  const callCount = Number(fs.existsSync(${callCountRecordLiteral}) ? fs.readFileSync(${callCountRecordLiteral}, "utf8") : 0) + 1;
  fs.writeFileSync(${callCountRecordLiteral}, String(callCount));
  const outputIndex = args.indexOf("--output-last-message");
  const schemaIndex = args.indexOf("--output-schema");
  const schema = JSON.parse(fs.readFileSync(args[schemaIndex + 1], "utf8"));
  if (schema.properties?.overview) {
    const marker = input.lastIndexOf("Input:\\n");
    const payload = JSON.parse(input.slice(marker + 7));
    const result = {
      overview: { summaryZh: "合成概览", learningFocusZh: "合成重点" },
      segments: payload.sentences.map((sentence) => ({
        id: sentence.id,
        translationZh: "合成翻译",
        explanationZh: "",
        spokenFormNotes: [],
        phrases: [],
        questionZh: ""
      }))
    };
    setTimeout(() => fs.writeFileSync(args[outputIndex + 1], JSON.stringify(result)), 250);
    return;
  }
  fs.writeFileSync(args[outputIndex + 1], JSON.stringify({ ok: true, message: "connected" }));
});
`, "utf8");
  await fs.chmod(target, 0o755);
}

async function jsonRequest(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = options.contentType || "application/json";
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, payload: await response.json() };
}

async function availablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForJob(port, jobId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await jsonRequest(`http://127.0.0.1:${port}/api/jobs/${jobId}`);
    if (["completed", "failed"].includes(result.payload.job.status)) return result.payload.job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("synthetic analysis job timed out");
}

async function waitForServer(server) {
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  let output = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server start timed out: ${output}`)), 5000);
    const collect = (chunk) => {
      output += chunk;
      if (!output.includes("原声精听已启动")) return;
      clearTimeout(timeout);
      resolve();
    };
    server.stdout.on("data", collect);
    server.stderr.on("data", collect);
    server.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited before start (${code}): ${output}`));
    });
  });
}
