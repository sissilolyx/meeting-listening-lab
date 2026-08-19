import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("material completion is explicit, backward compatible, idempotent, and concurrency safe", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-learning-state-"));
  process.env.LISTENING_DATA_DIR = dataRoot;
  const storage = await import(`../lib/storage.mjs?learning-state-storage-test=${Date.now()}`);

  try {
    await storage.ensureStorage();
    const material = await storage.createMaterial({ title: "Synthetic learning state" });
    assert.equal(material.completed, false);
    assert.equal(material.completedAt, null);

    const firstCompletionAt = "2026-08-09T01:02:03.000Z";
    await Promise.all([
      storage.updateMaterialLearningState(material.id, { completed: true }, { now: firstCompletionAt }),
      storage.updateProgress(material.id, ["sentence-synthetic"], { heard: true }),
    ]);
    let reloaded = await storage.readMaterial(material.id);
    assert.equal(reloaded.completed, true);
    assert.equal(reloaded.completedAt, firstCompletionAt);
    assert.equal(reloaded.progress["sentence-synthetic"].heard, true);

    await storage.updateMaterialLearningState(
      material.id,
      { completed: true },
      { now: "2026-08-10T01:02:03.000Z" },
    );
    reloaded = await storage.readMaterial(material.id);
    assert.equal(reloaded.completedAt, firstCompletionAt, "repeated completion must keep the original completion time");

    await storage.updateMaterialLearningState(material.id, { completed: false });
    reloaded = await storage.readMaterial(material.id);
    assert.equal(reloaded.completed, false);
    assert.equal(reloaded.completedAt, null);
    assert.equal(reloaded.progress["sentence-synthetic"].heard, true, "manual reset must not erase listening progress");

    const materialPath = path.join(storage.materialDir(material.id), "material.json");
    const legacy = JSON.parse(await fs.readFile(materialPath, "utf8"));
    delete legacy.completed;
    delete legacy.completedAt;
    await fs.writeFile(materialPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    reloaded = await storage.readMaterial(material.id);
    assert.equal(reloaded.completed, false);
    assert.equal(reloaded.completedAt, null);

    await assert.rejects(
      storage.updateMaterialLearningState(material.id, { completed: "yes" }),
      { code: "INVALID_LEARNING_STATE" },
    );
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});
