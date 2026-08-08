import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("same-material updates are serialized without losing questions, reviews, or progress", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-storage-concurrency-"));
  process.env.LISTENING_DATA_DIR = dataRoot;
  const storage = await import(`../lib/storage.mjs?storage-concurrency-test=${Date.now()}`);

  try {
    await storage.ensureStorage();
    const material = await storage.createMaterial({ title: "Concurrent learning state" });
    material.sentences = [{
      id: "sentence-1",
      text: "The more context we keep, the clearer the sentence becomes.",
      start: 0,
      end: 4,
      speaker: "Speaker A",
    }];
    await storage.saveMaterial(material);
    await storage.saveQaHistoryItem(material.id, {
      id: "qa-history-to-delete",
      sentenceId: "sentence-1",
      sourceText: "old question target",
      question: "old question",
      answerZh: "old answer",
      learningSummaryZh: "old summary",
    });

    const questionCount = 18;
    const reviewCount = 11;
    const progressCount = 14;
    await Promise.all([
      ...Array.from({ length: questionCount }, (_, index) => storage.saveQaHistoryItem(material.id, {
        id: `qa-history-${index}`,
        sentenceId: "sentence-1",
        sourceText: `question target ${index}`,
        question: `question ${index}`,
        answerZh: `answer ${index}`,
        learningSummaryZh: `summary ${index}`,
      })),
      ...Array.from({ length: reviewCount }, (_, index) => storage.saveReviewItem(material.id, {
        id: `review-${index}`,
        kind: "phrase",
        sentenceId: "sentence-1",
        sourceText: `review target ${index}`,
      })),
      ...Array.from({ length: progressCount }, (_, index) => storage.updateProgress(
        material.id,
        [`segment-${index}`],
        { heard: true },
      )),
      storage.removeQaHistoryItem(material.id, "qa-history-to-delete"),
    ]);

    const reloaded = await storage.readMaterial(material.id);
    assert.equal(reloaded.qaHistory.length, questionCount);
    assert.equal(reloaded.reviewItems.length, reviewCount);
    assert.equal(Object.keys(reloaded.progress).length, progressCount);
    assert(reloaded.qaHistory.every((item) => item.id.startsWith("qa-history-")));
    assert(reloaded.reviewItems.every((item) => item.id.startsWith("review-")));

    await assert.rejects(
      storage.updateMaterial(material.id, () => { throw new Error("expected mutation failure"); }),
      /expected mutation failure/,
    );
    await storage.updateProgress(material.id, ["after-failure"], { heard: true });
    const afterFailure = await storage.readMaterial(material.id);
    assert.equal(afterFailure.progress["after-failure"].heard, true, "a failed update must not block later saves");

    const materialFiles = await fs.readdir(storage.materialDir(material.id));
    assert.equal(materialFiles.some((name) => name.includes(".tmp")), false, "atomic writes must clean temporary files");
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});
