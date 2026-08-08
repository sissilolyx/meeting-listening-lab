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
    const material = await storage.createMaterial({ title: "Interrupted analysis" });
    material.status = "ready";
    material.analysisStatus = "processing";
    material.sentences = [{ id: "sentence-1", text: "Ready to explain.", start: 0, end: 2 }];
    await storage.saveMaterial(material);

    const staleJob = {
      id: storage.createId("job"),
      kind: "codex-analysis",
      materialId: material.id,
      status: "running",
      stage: "Codex 正在生成讲解",
      progress: 0.6,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await storage.saveJob(staleJob);

    let resumedMaterialId = null;
    const recovery = await jobs.recoverInterruptedJobs(async (materialId) => {
      resumedMaterialId = materialId;
      return { id: "replacement-job", materialId };
    });

    assert.equal((await storage.readJob(staleJob.id)).status, "failed");
    assert.equal(resumedMaterialId, material.id);
    assert.equal(recovery.resumed[0].id, "replacement-job");
    const recoveredMaterial = await storage.readMaterial(material.id);
    assert.equal(recoveredMaterial.status, "ready");
    assert.equal(recoveredMaterial.analysisStatus, "processing");
    assert.match(recoveredMaterial.stage, /自动恢复/);
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

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
    const first = await jobs.createJob("codex-analysis", material.id, runner);
    const second = await jobs.createJob("codex-analysis", material.id, runner);

    assert.equal(second.id, first.id);
    release();
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});
