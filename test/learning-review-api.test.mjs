import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const APP_ROOT = path.resolve(import.meta.dirname, "..");

test("learning-state API and local review queue support all-material and one-material scopes", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-learning-review-api-"));
  const port = await availablePort();
  process.env.LISTENING_DATA_DIR = dataRoot;
  const storage = await import(`../lib/storage.mjs?learning-review-api-test=${Date.now()}`);
  let server;

  try {
    await storage.ensureStorage();
    const first = await createSyntheticReviewMaterial(storage, "Synthetic alpha", "alpha");
    const second = await createSyntheticReviewMaterial(storage, "Synthetic beta", "beta");

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
    const origin = `http://127.0.0.1:${port}`;

    const completedResponse = await fetch(`${origin}/api/materials/${first.id}/learning-state`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: true }),
    });
    assert.equal(completedResponse.status, 200);
    const completedPayload = await completedResponse.json();
    assert.equal(completedPayload.material.completed, true);
    assert.equal(Number.isNaN(Date.parse(completedPayload.material.completedAt)), false);

    const materialsResponse = await fetch(`${origin}/api/materials`);
    const materialsPayload = await materialsResponse.json();
    const completedSummary = materialsPayload.materials.find((item) => item.id === first.id);
    assert.equal(completedSummary.completed, true);
    assert.equal(completedSummary.completedAt, completedPayload.material.completedAt);

    const invalidResponse = await fetch(`${origin}/api/materials/${first.id}/learning-state`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: "yes" }),
    });
    assert.equal(invalidResponse.status, 400);

    const allResponse = await fetch(`${origin}/api/review-queue`);
    assert.equal(allResponse.status, 200);
    const allPayload = await allResponse.json();
    assert.deepEqual(allPayload.scope, { type: "all", materialId: null });
    assert.equal(allPayload.total, 2);
    assert.deepEqual(new Set(allPayload.items.map((item) => item.materialId)), new Set([first.id, second.id]));

    const oneResponse = await fetch(`${origin}/api/review-queue?materialId=${first.id}`);
    assert.equal(oneResponse.status, 200);
    const onePayload = await oneResponse.json();
    assert.deepEqual(onePayload.scope, { type: "material", materialId: first.id });
    assert.equal(onePayload.total, 1);
    assert.deepEqual(onePayload.items.map((item) => item.materialId), [first.id]);
    assert.equal(onePayload.items[0].materialCompleted, true);

    const resetResponse = await fetch(`${origin}/api/materials/${first.id}/learning-state`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: false }),
    });
    const resetPayload = await resetResponse.json();
    assert.equal(resetPayload.material.completed, false);
    assert.equal(resetPayload.material.completedAt, null);
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("exit", resolve));
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

async function createSyntheticReviewMaterial(storage, title, suffix) {
  const material = await storage.createMaterial({ title });
  const sentenceId = `sentence-${suffix}`;
  const paragraphId = `paragraph-${suffix}`;
  material.status = "ready";
  material.sentences = [{
    id: sentenceId,
    text: `This is synthetic ${suffix} review content.`,
    start: 0,
    end: 3,
    speaker: "Synthetic Speaker",
  }];
  material.paragraphs = [{
    id: paragraphId,
    sentenceIds: [sentenceId],
    text: `This is synthetic ${suffix} review content.`,
    start: 0,
    end: 3,
    speaker: "Synthetic Speaker",
  }];
  material.reviewItems = [{
    id: `review-${suffix}`,
    kind: "paragraph",
    paragraphId,
    sourceText: material.paragraphs[0].text,
  }];
  await storage.saveMaterial(material);
  return material;
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
