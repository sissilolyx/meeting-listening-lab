import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("trash keeps materials recoverable for 30 days and permanently purges expired entries", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-delete-"));
  process.env.LISTENING_DATA_DIR = dataRoot;
  const storage = await import(`../lib/storage.mjs?delete-storage-test=${Date.now()}`);

  try {
    await storage.ensureStorage();
    const material = await storage.createMaterial({ title: "Recoverable material" });
    const mediaPath = path.join(storage.materialDir(material.id), "source.m4a");
    await fs.writeFile(mediaPath, "temporary media");

    const deleted = await storage.deleteMaterial(material.id);

    assert.equal(deleted.id, material.id);
    assert.equal(deleted.title, "Recoverable material");
    assert.equal(Date.parse(deleted.expiresAt) - Date.parse(deleted.deletedAt), storage.TRASH_RETENTION_MS);
    await assert.rejects(storage.readMaterial(material.id), { code: "ENOENT" });
    await assert.rejects(storage.saveMaterial(material), /Material was deleted/);
    await assert.rejects(fs.stat(storage.materialDir(material.id)), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(storage.trashDir(material.id), "source.m4a"), "utf8"), "temporary media");
    assert.deepEqual((await storage.listTrash()).map((entry) => entry.id), [material.id]);

    const restored = await storage.restoreMaterial(material.id);
    assert.equal(restored.material.title, "Recoverable material");
    assert.equal(await fs.readFile(mediaPath, "utf8"), "temporary media");
    assert.deepEqual(await storage.listTrash(), []);
    await storage.saveMaterial(restored.material);

    const expiredMaterial = await storage.createMaterial({ title: "Expired material" });
    await fs.writeFile(path.join(storage.materialDir(expiredMaterial.id), "source.wav"), "expired media");
    const expiredEntry = await storage.deleteMaterial(expiredMaterial.id);
    const afterRetention = Date.parse(expiredEntry.expiresAt) + 1;

    assert.deepEqual(await storage.listTrash({ now: afterRetention }), []);
    await assert.rejects(fs.stat(storage.trashDir(expiredMaterial.id)), { code: "ENOENT" });
    await assert.rejects(storage.restoreMaterial(expiredMaterial.id, { now: afterRetention }), { code: "ENOENT" });
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});
