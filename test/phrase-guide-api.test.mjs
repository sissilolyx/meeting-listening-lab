import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const APP_ROOT = path.resolve(import.meta.dirname, "..");

test("phrase guide API returns an exact cache without mutating questions and rejects stale or unknown input", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-phrase-guide-api-"));
  const port = await availablePort();
  process.env.LISTENING_DATA_DIR = dataRoot;
  const storage = await import(`../lib/storage.mjs?phrase-guide-api=${Date.now()}`);
  let server;

  try {
    await storage.ensureStorage();
    const material = await storage.createMaterial({ title: "Synthetic phrase guide API" });
    material.status = "ready";
    material.sentences = [{
      id: "sentence-synthetic",
      text: "We can circle back to the sample draft tomorrow.",
      speaker: "Synthetic Speaker",
      start: 1,
      end: 5,
      analysis: {
        spokenFormNotes: [],
        phrases: [{
          text: "circle back to",
          meaningZh: "稍后再回到某个议题",
          usageZh: "用于表示之后重新讨论某件事。",
        }],
      },
    }];
    material.qaHistory = [{ id: "qa-keep", sentenceId: "sentence-synthetic" }];
    await storage.saveMaterial(material);
    const saved = await storage.savePhraseGuideItem(material.id, {
      sentenceId: "sentence-synthetic",
      phraseText: "circle back to",
      sourceSentenceText: material.sentences[0].text,
      meaningZh: "稍后再回到某个议题",
      usageZh: "表示稍后重新讨论。",
      patternZh: "circle back to + 议题",
      alternatives: [],
      examples: [
        { english: "Let's circle back to the sample plan tomorrow.", meaningZh: "我们明天再回到示例计划。" },
        { english: "Can we circle back to this open item later?", meaningZh: "我们稍后能再讨论这个未结事项吗？" },
        { english: "I will circle back to the draft after lunch.", meaningZh: "午饭后我会再看这份草稿。" },
      ],
    });

    server = spawn(process.execPath, ["server.mjs"], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        LISTENING_DATA_DIR: dataRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer(server);
    const endpoint = `http://127.0.0.1:${port}/api/materials/${material.id}/phrase-guides`;

    const cached = await post(endpoint, {
      sentenceId: "sentence-synthetic",
      phraseText: "circle back to",
      expectedSentenceText: material.sentences[0].text,
    });
    assert.equal(cached.status, 200);
    assert.equal(cached.payload.cached, true);
    assert.equal(cached.payload.phraseGuide.id, saved.phraseGuide.id);
    const afterCache = await storage.readMaterial(material.id);
    assert.deepEqual(afterCache.qaHistory, material.qaHistory);
    assert.equal(afterCache.phraseGuides.length, 1);

    const stale = await post(endpoint, {
      sentenceId: "sentence-synthetic",
      phraseText: "circle back to",
      expectedSentenceText: "A stale synthetic sentence.",
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.payload.currentSentenceText, material.sentences[0].text);

    const nonExactPhrase = await post(endpoint, {
      sentenceId: "sentence-synthetic",
      phraseText: "Circle Back To",
      expectedSentenceText: material.sentences[0].text,
    });
    assert.equal(nonExactPhrase.status, 400);

    const missingSentence = await post(endpoint, {
      sentenceId: "sentence-missing",
      phraseText: "circle back to",
      expectedSentenceText: material.sentences[0].text,
    });
    assert.equal(missingSentence.status, 400);
    assert.deepEqual((await storage.readMaterial(material.id)).qaHistory, material.qaHistory);
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("exit", resolve));
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

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
