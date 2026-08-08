import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("question history persists independently from review items and remains backward compatible", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-qa-history-"));
  process.env.LISTENING_DATA_DIR = dataRoot;
  const storage = await import(`../lib/storage.mjs?qa-history-storage-test=${Date.now()}`);

  try {
    await storage.ensureStorage();
    const material = await storage.createMaterial({ title: "Question history material" });
    material.sentences = [{
      id: "sentence-1",
      text: "The blue label is more visible on the sample poster.",
      start: 12,
      end: 17,
      speaker: "Speaker A",
    }];
    await storage.saveMaterial(material);

    const first = await storage.saveQaHistoryItem(material.id, {
      sentenceId: "sentence-1",
      sentenceText: material.sentences[0].text,
      sourceText: "more visible",
      learningTargetText: "more visible",
      question: "这里为什么用 more visible？",
      answerZh: "这里表示蓝色标签更醒目。",
      learningSummaryZh: "more visible 表示更容易被看到。",
      grammarPointZh: "more + 形容词构成比较级。",
      transcriptStatus: "credible",
      likelySpokenEnglish: "",
      intendedMeaningZh: "",
    });
    const second = await storage.saveQaHistoryItem(material.id, {
      sentenceId: "sentence-1",
      sentenceText: material.sentences[0].text,
      sourceText: "more visible",
      learningTargetText: "more visible",
      question: "这句话还有别的说法吗？",
      answerZh: "也可以说 The blue label stands out more.",
      learningSummaryZh: "stands out more 表达更醒目。",
      grammarPointZh: "",
      transcriptStatus: "credible",
      likelySpokenEnglish: "",
      intendedMeaningZh: "",
    });

    const reloaded = await storage.readMaterial(material.id);
    assert.equal(reloaded.qaHistory.length, 2);
    assert.equal(reloaded.qaHistory[0].id, first.historyItem.id);
    assert.equal(reloaded.qaHistory[1].id, second.historyItem.id);
    assert.equal(reloaded.reviewItems.length, 0, "asking must not implicitly add a review item");

    await storage.saveReviewItem(material.id, {
      kind: "qa",
      historyId: first.historyItem.id,
      sentenceId: "sentence-1",
      sourceText: "more visible",
      question: "这里为什么用 more visible？",
      answerZh: "这里表示蓝色标签更醒目。",
      learningSummaryZh: "more visible 表示更容易被看到。",
    });
    await storage.removeQaHistoryItem(material.id, first.historyItem.id);
    const afterRemoval = await storage.readMaterial(material.id);
    assert.deepEqual(afterRemoval.qaHistory.map((item) => item.id), [second.historyItem.id]);
    assert.equal(afterRemoval.reviewItems.length, 1, "deleting history must preserve linked review content");
    assert.equal(afterRemoval.reviewItems[0].historyId, first.historyItem.id);

    await assert.rejects(
      storage.removeQaHistoryItem(material.id, "qa-history-missing"),
      (error) => error.code === "QA_HISTORY_NOT_FOUND",
    );
    const afterMissingRemoval = await storage.readMaterial(material.id);
    assert.deepEqual(afterMissingRemoval.qaHistory.map((item) => item.id), [second.historyItem.id]);

    delete afterMissingRemoval.qaHistory;
    await storage.saveMaterial(afterMissingRemoval);
    const legacyReload = await storage.readMaterial(material.id);
    assert.deepEqual(legacyReload.qaHistory, [], "older materials without qaHistory should still load");
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});
