import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-sentence-edit-"));
process.env.LISTENING_DATA_DIR = dataRoot;
const storage = await import(`../lib/storage.mjs?sentence-edit-storage=${Date.now()}`);
const { mergeSentenceAnalysis } = await import(`../lib/importers.mjs?sentence-edit-importers=${Date.now()}`);
const jobs = await import(`../lib/jobs.mjs?sentence-edit-jobs=${Date.now()}`);

test.after(async () => {
  await fs.rm(dataRoot, { recursive: true, force: true });
});

test("manual sentence correction updates only canonical transcript fields and invalidates its analysis", async () => {
  await storage.ensureStorage();
  const material = await createSyntheticMaterial("Direct edit");
  const originalProgress = structuredClone(material.progress);
  const originalHistory = structuredClone(material.qaHistory);
  const originalReviewItems = structuredClone(material.reviewItems);
  const originalOtherSentence = structuredClone(material.sentences[1]);

  const result = await storage.updateSentenceText(
    material.id,
    "sentence-alpha",
    "The corrected synthetic sentence describes a blue telescope.",
    { expectedText: "The synthetic sentence mentions an abbreviation." },
  );

  assert.equal(result.changed, true);
  assert.equal(result.sentence.wordCount, 8);
  assert.equal(result.sentence.analysis, null);
  assert.deepEqual(result.material.sentences[1], originalOtherSentence);
  assert.equal(
    result.material.paragraphs[0].text,
    "The corrected synthetic sentence describes a blue telescope. Another synthetic sentence remains unchanged.",
  );
  assert.equal(result.material.paragraphs[0].wordCount, 13);
  assert.equal(result.material.analysisStatus, "pending");
  assert.deepEqual(result.material.progress, originalProgress);
  assert.deepEqual(result.material.qaHistory, originalHistory);
  assert.deepEqual(result.material.reviewItems, originalReviewItems);

  await assert.rejects(
    storage.updateSentenceText(material.id, "sentence-alpha", "A competing correction.", {
      expectedText: "The synthetic sentence mentions an abbreviation.",
    }),
    (error) => error.code === "SENTENCE_EDIT_CONFLICT"
      && error.currentText === "The corrected synthetic sentence describes a blue telescope.",
  );
  assert.equal(
    (await storage.readMaterial(material.id)).sentences[0].text,
    "The corrected synthetic sentence describes a blue telescope.",
  );
});

test("analysis merge ignores stale output produced for pre-correction text", () => {
  const current = [{
    id: "sentence-synthetic",
    text: "The corrected synthetic sentence.",
    analysis: null,
  }];
  const stale = [{
    id: "sentence-synthetic",
    text: "The old synthetic sentence.",
    analysis: { translationZh: "stale" },
  }];
  const currentOutput = [{
    id: "sentence-synthetic",
    text: "The corrected synthetic sentence.",
    analysis: { translationZh: "current" },
  }];

  assert.equal(mergeSentenceAnalysis(current, stale)[0].analysis, null);
  assert.equal(mergeSentenceAnalysis(current, currentOutput)[0].analysis.translationZh, "current");
});

test("queued job runs after an active job instead of being deduplicated away", async () => {
  const material = await createSyntheticMaterial("Queued edit analysis");
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const order = [];
  const first = await jobs.createJob("synthetic-analysis", material.id, async () => {
    order.push("first-start");
    await firstGate;
    order.push("first-end");
  });
  const queued = await jobs.createJob("synthetic-analysis", material.id, async () => {
    order.push("queued-run");
  }, { enqueueAfterActive: true });

  assert.notEqual(queued.id, first.id);
  assert.equal(queued.status, "queued");
  releaseFirst();
  await waitFor(async () => (await storage.readJob(queued.id)).status === "completed");
  assert.deepEqual(order, ["first-start", "first-end", "queued-run"]);
});

test("sentence correction API requires an expected snapshot and reports conflicts", async () => {
  const material = await createSyntheticMaterial("API edit");
  const port = await availablePort();
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      LISTENING_DATA_DIR: dataRoot,
      SKIP_CODEX_ANALYSIS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(server);
    const origin = `http://127.0.0.1:${port}`;
    const missingSnapshot = await patchSentence(origin, material.id, {
      text: "A corrected API sentence.",
    });
    assert.equal(missingSnapshot.status, 400);

    const conflict = await patchSentence(origin, material.id, {
      text: "A corrected API sentence.",
      expectedText: "A stale synthetic sentence.",
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.payload.currentText, "The synthetic sentence mentions an abbreviation.");

    const saved = await patchSentence(origin, material.id, {
      text: "A corrected API sentence.",
      expectedText: "The synthetic sentence mentions an abbreviation.",
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.payload.material.sentences[0].text, "A corrected API sentence.");
    assert.equal(saved.payload.material.sentences[0].analysis, null);
    assert.equal(saved.payload.job.kind, "codex-analysis");
  } finally {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("exit", resolve));
    }
  }
});

async function createSyntheticMaterial(title) {
  const material = await storage.createMaterial({ title });
  material.status = "ready";
  material.analysisStatus = "ready";
  material.sentences = [{
    id: "sentence-alpha",
    text: "The synthetic sentence mentions an abbreviation.",
    wordCount: 6,
    start: 1,
    end: 4,
    speaker: "Synthetic Speaker",
    analysis: { translationZh: "synthetic", spokenFormNotes: [] },
  }, {
    id: "sentence-beta",
    text: "Another synthetic sentence remains unchanged.",
    wordCount: 5,
    start: 4,
    end: 7,
    speaker: "Synthetic Speaker",
    analysis: { translationZh: "synthetic", spokenFormNotes: [] },
  }];
  material.paragraphs = [{
    id: "paragraph-synthetic",
    sentenceIds: ["sentence-alpha", "sentence-beta"],
    text: "The synthetic sentence mentions an abbreviation. Another synthetic sentence remains unchanged.",
    wordCount: 11,
    start: 1,
    end: 7,
    speaker: "Synthetic Speaker",
  }];
  material.progress = { "paragraph-synthetic": { heard: true, dictation: "synthetic note" } };
  material.qaHistory = [{
    id: "qa-synthetic",
    sentenceId: "sentence-alpha",
    sentenceText: material.sentences[0].text,
    sourceText: "abbreviation",
    question: "Synthetic question?",
  }];
  material.reviewItems = [{
    id: "review-synthetic",
    kind: "phrase",
    sentenceId: "sentence-alpha",
    sourceText: "abbreviation",
  }];
  await storage.saveMaterial(material);
  return material;
}

async function patchSentence(origin, materialId, body) {
  const response = await fetch(`${origin}/api/materials/${materialId}/sentences/sentence-alpha`, {
    method: "PATCH",
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

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}
