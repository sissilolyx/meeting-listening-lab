import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const APP_ROOT = path.resolve(import.meta.dirname, "..");

test("POST ask persists bounded exact text anchors and remains compatible with legacy questions", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-qa-anchor-api-"));
  const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-fake-codex-"));
  const port = await availablePort();
  process.env.LISTENING_DATA_DIR = dataRoot;
  const storage = await import(`../lib/storage.mjs?qa-anchor-api=${Date.now()}`);
  let server;

  try {
    await installFakeCodex(fakeBin);
    await storage.ensureStorage();
    await fs.writeFile(path.join(dataRoot, "settings.json"), JSON.stringify({ provider: "codex", model: "synthetic-model" }));
    const material = await storage.createMaterial({ title: "Synthetic question anchor API" });
    material.status = "ready";
    material.sentences = [{
      id: "sentence-anchor",
      text: "The museum displays a blue lantern in this example.",
      speaker: "Synthetic Speaker",
      start: 1,
      end: 5,
      analysis: null,
    }];
    await storage.saveMaterial(material);

    server = spawn(process.execPath, ["server.mjs"], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        LISTENING_DATA_DIR: dataRoot,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer(server);
    const endpoint = `http://127.0.0.1:${port}/api/materials/${material.id}/ask`;
    const surfaceText = material.sentences[0].text;
    const anchored = await post(endpoint, {
      sentenceId: "sentence-anchor",
      selectedText: "blue lantern",
      question: "这个表达在这里是什么意思？",
      anchorSurface: "original",
      anchorSurfaceText: surfaceText,
      anchorStart: 22,
      anchorEnd: 34,
      anchorExact: "blue lantern",
      prefix: "p".repeat(400),
      suffix: " in this",
    });
    assert.equal(anchored.status, 200);
    assert.deepEqual(pickAnchor(anchored.payload.historyItem), {
      anchorSurface: "original",
      anchorSurfaceText: surfaceText,
      anchorStart: 22,
      anchorEnd: 34,
      anchorExact: "blue lantern",
      prefix: "p".repeat(256),
      suffix: " in this",
    });

    const legacy = await post(endpoint, {
      sentenceId: "sentence-anchor",
      selectedText: "this example",
      question: "这里是什么意思？",
    });
    assert.equal(legacy.status, 200);
    assert.deepEqual(pickAnchor(legacy.payload.historyItem), {});

    const invalidSurface = await post(endpoint, {
      sentenceId: "sentence-anchor",
      selectedText: "blue lantern",
      question: "非法区域不应落盘",
      anchorSurface: "unsafe-surface",
      anchorExact: "blue lantern",
    });
    assert.equal(invalidSurface.status, 400);

    const invalidOffset = await post(endpoint, {
      sentenceId: "sentence-anchor",
      selectedText: "blue lantern",
      question: "非法位置不应落盘",
      anchorSurface: "original",
      anchorSurfaceText: surfaceText,
      anchorStart: -1,
      anchorEnd: 34,
      anchorExact: "blue lantern",
    });
    assert.equal(invalidOffset.status, 400);

    const saved = await storage.readMaterial(material.id);
    assert.equal(saved.qaHistory.length, 2);
    assert.deepEqual(pickAnchor(saved.qaHistory[0]), pickAnchor(anchored.payload.historyItem));
    assert.deepEqual(pickAnchor(saved.qaHistory[1]), {});
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

function pickAnchor(item) {
  return Object.fromEntries([
    "anchorSurface",
    "anchorSurfaceText",
    "anchorStart",
    "anchorEnd",
    "anchorExact",
    "prefix",
    "suffix",
  ].filter((key) => item[key] !== undefined).map((key) => [key, item[key]]));
}

async function installFakeCodex(directory) {
  const target = path.join(directory, "codex");
  await fs.writeFile(target, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(args[outputIndex + 1], JSON.stringify({
    answerZh: "这是合成测试回答。",
    learningSummaryZh: "这是合成测试总结。",
    grammarPointZh: "",
    transcriptStatus: "credible",
    likelySpokenEnglish: "",
    intendedMeaningZh: ""
  }));
});
`, "utf8");
  await fs.chmod(target, 0o755);
}

async function post(endpoint, body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
