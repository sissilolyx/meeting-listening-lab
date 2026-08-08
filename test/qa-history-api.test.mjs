import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const APP_ROOT = path.resolve(import.meta.dirname, "..");

test("DELETE qa-history removes only the question record and returns 404 when it no longer exists", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-qa-history-api-"));
  const port = await availablePort();
  process.env.LISTENING_DATA_DIR = dataRoot;
  const storage = await import(`../lib/storage.mjs?qa-history-api-test=${Date.now()}`);
  let server;

  try {
    await storage.ensureStorage();
    const material = await storage.createMaterial({ title: "Question history API material" });
    material.sentences = [{
      id: "sentence-1",
      text: "We need a clearer label here.",
      start: 0,
      end: 2,
      speaker: "Speaker A",
    }];
    await storage.saveMaterial(material);
    const savedHistory = await storage.saveQaHistoryItem(material.id, {
      id: "qa-history-delete-me",
      sentenceId: "sentence-1",
      sourceText: "a clearer label",
      question: "这里为什么用 clearer？",
      answerZh: "表示标签需要更清楚。",
      learningSummaryZh: "clearer 是 clear 的比较级。",
    });
    await storage.saveReviewItem(material.id, {
      id: "review-keep-me",
      kind: "qa",
      historyId: savedHistory.historyItem.id,
      sentenceId: "sentence-1",
      sourceText: "a clearer label",
      question: "这里为什么用 clearer？",
      answerZh: "表示标签需要更清楚。",
      learningSummaryZh: "clearer 是 clear 的比较级。",
    });

    server = spawn(process.execPath, ["server.mjs"], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        LISTENING_DATA_DIR: dataRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer(server);

    const endpoint = `http://127.0.0.1:${port}/api/materials/${material.id}/qa-history/${savedHistory.historyItem.id}`;
    const removedResponse = await fetch(endpoint, { method: "DELETE" });
    assert.equal(removedResponse.status, 200);
    const removedPayload = await removedResponse.json();
    assert.deepEqual(removedPayload.material.qaHistory, []);
    assert.equal(removedPayload.material.reviewItems.length, 1);
    assert.equal(removedPayload.material.reviewItems[0].id, "review-keep-me");

    const missingResponse = await fetch(endpoint, { method: "DELETE" });
    assert.equal(missingResponse.status, 404);
    assert.deepEqual(await missingResponse.json(), { error: "没有找到这条问问记录" });
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("exit", resolve));
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

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
