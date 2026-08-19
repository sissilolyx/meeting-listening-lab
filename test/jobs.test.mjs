import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("startup recovery stops stale jobs and resumes ready material analysis", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-jobs-"));
  process.env.LISTENING_DATA_DIR = dataRoot;
  const storage = await import(`../lib/storage.mjs?jobs-storage-test=${Date.now()}`);
  const jobs = await import(`../lib/jobs.mjs?jobs-test=${Date.now()}`);

  try {
    await storage.ensureStorage();
    const material = await createAnalysisMaterial(storage, {
      title: "Interrupted processing analysis",
      analysisStatus: "processing",
      analysis: null,
    });
    const pendingMaterial = await createAnalysisMaterial(storage, {
      title: "Interrupted pending correction",
      analysisStatus: "pending",
      analysis: null,
    });
    const completeMaterial = await createAnalysisMaterial(storage, {
      title: "Completed sentence analysis",
      analysisStatus: "processing",
      analysis: { translationZh: "Synthetic", spokenFormNotes: [] },
    });
    const skippedMaterial = await createAnalysisMaterial(storage, {
      title: "Intentionally skipped analysis",
      analysisStatus: "skipped",
      analysis: null,
    });
    const readyMaterial = await createAnalysisMaterial(storage, {
      title: "Intentionally ready analysis",
      analysisStatus: "ready",
      analysis: null,
    });

    const staleJob = {
      id: storage.createId("job"),
      kind: "codex-analysis",
      materialId: material.id,
      status: "running",
      stage: "AI 正在生成讲解",
      progress: 0.6,
      error: null,
      aiProvider: { provider: "codex", model: "frozen-job-model" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await storage.saveJob(staleJob);
    const queuedSuccessor = {
      ...staleJob,
      id: storage.createId("job"),
      status: "queued",
      stage: "等待上一轮讲解完成",
      aiProvider: { provider: "cursor", model: "frozen-queued-model" },
      createdAt: new Date(Date.now() + 1000).toISOString(),
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    };
    await storage.saveJob(queuedSuccessor);

    const resumedSelections = [];
    const recovery = await jobs.recoverInterruptedJobs(async (materialId, aiSettings) => {
      resumedSelections.push({ materialId, aiSettings });
      return { id: "replacement-job", materialId };
    });

    assert.equal((await storage.readJob(staleJob.id)).status, "failed");
    assert.deepEqual(resumedSelections.map((item) => item.materialId), [material.id]);
    assert.deepEqual(resumedSelections.find((item) => item.materialId === material.id)?.aiSettings, {
      provider: "cursor",
      model: "frozen-queued-model",
    });
    assert.equal(recovery.resumed.length, 1);
    assert(recovery.resumed.every((job) => job.id === "replacement-job"));
    const recoveredMaterial = await storage.readMaterial(material.id);
    assert.equal(recoveredMaterial.status, "ready");
    assert.equal(recoveredMaterial.analysisStatus, "processing");
    assert.match(recoveredMaterial.stage, /自动恢复/);
    const pendingAfterRecovery = await storage.readMaterial(pendingMaterial.id);
    assert.match(pendingAfterRecovery.stage, /手动重新开始/);
    assert.match(pendingAfterRecovery.warning, /没有保存 AI provider/);
    assert.equal((await storage.readMaterial(completeMaterial.id)).analysisStatus, "ready");
    assert.equal((await storage.readMaterial(skippedMaterial.id)).analysisStatus, "skipped");
    assert.equal((await storage.readMaterial(readyMaterial.id)).analysisStatus, "ready");
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

async function createAnalysisMaterial(storage, { title, analysisStatus, analysis }) {
  const material = await storage.createMaterial({ title });
  material.status = "ready";
  material.analysisStatus = analysisStatus;
  material.analysisProvider = { provider: "codex", model: "frozen-material-model" };
  material.sentences = [{
    id: storage.createId("sentence"),
    text: "A synthetic sentence for recovery.",
    start: 0,
    end: 2,
    analysis,
  }];
  await storage.saveMaterial(material);
  return material;
}

test("createJob deduplicates active jobs for the same material and kind", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-dedup-"));
  process.env.LISTENING_DATA_DIR = dataRoot;
  const storage = await import(`../lib/storage.mjs?dedup-storage-test=${Date.now()}`);
  const jobs = await import(`../lib/jobs.mjs?dedup-jobs-test=${Date.now()}`);

  try {
    await storage.ensureStorage();
    const material = await storage.createMaterial({ title: "Deduplicate" });
    material.status = "ready";
    material.analysisStatus = "processing";
    material.sentences = [{ id: "sentence-1", text: "Only once.", start: 0, end: 1 }];
    await storage.saveMaterial(material);

    let release;
    const wait = new Promise((resolve) => { release = resolve; });
    const runner = async () => wait;
    const first = await jobs.createJob("codex-analysis", material.id, runner, {
      aiSettings: { provider: "codex", model: "frozen-a" },
    });
    const second = await jobs.createJob("codex-analysis", material.id, runner);

    assert.equal(second.id, first.id);
    assert.deepEqual((await storage.readJob(first.id)).aiProvider, { provider: "codex", model: "frozen-a" });
    release();
    await waitForJobStatus(storage, first.id, "completed");
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("queued successor jobs keep the first queued runner and its frozen provider selection", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-queued-provider-"));
  process.env.LISTENING_DATA_DIR = dataRoot;
  const storage = await import(`../lib/storage.mjs?queued-provider-storage=${Date.now()}`);
  const jobs = await import(`../lib/jobs.mjs?queued-provider-jobs=${Date.now()}`);

  try {
    await storage.ensureStorage();
    const material = await storage.createMaterial({ title: "Queued provider snapshot" });
    material.status = "ready";
    material.analysisStatus = "processing";
    material.sentences = [{ id: "sentence-1", text: "Synthetic.", start: 0, end: 1 }];
    await storage.saveMaterial(material);

    let releaseActive;
    const activeWait = new Promise((resolve) => { releaseActive = resolve; });
    const active = await jobs.createJob("codex-analysis", material.id, async () => activeWait, {
      aiSettings: { provider: "codex", model: "model-a" },
    });
    let ran = "";
    const queued = await jobs.createJob("codex-analysis", material.id, async () => { ran = "model-b"; }, {
      enqueueAfterActive: true,
      aiSettings: { provider: "cursor", model: "model-b" },
    });
    const deduplicated = await jobs.createJob("codex-analysis", material.id, async () => { ran = "model-c"; }, {
      enqueueAfterActive: true,
      aiSettings: { provider: "cursor", model: "model-c" },
    });

    assert.equal(deduplicated.id, queued.id);
    assert.deepEqual((await storage.readJob(queued.id)).aiProvider, { provider: "cursor", model: "model-b" });
    releaseActive();
    await waitForJobStatus(storage, active.id, "completed");
    await waitForJobStatus(storage, queued.id, "completed");
    assert.equal(ran, "model-b");
    assert.deepEqual((await storage.readJob(queued.id)).aiProvider, { provider: "cursor", model: "model-b" });
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

async function waitForJobStatus(storage, jobId, status) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((await storage.readJob(jobId)).status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${jobId} did not reach ${status}`);
}
