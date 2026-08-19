import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("phrase guides upsert by sentence and normalized phrase, then invalidate on sentence correction", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-phrase-guide-storage-"));
  process.env.LISTENING_DATA_DIR = dataRoot;
  const storage = await import(`../lib/storage.mjs?phrase-guide-storage=${Date.now()}`);

  try {
    await storage.ensureStorage();
    const material = await storage.createMaterial({ title: "Synthetic phrase guide storage" });
    material.status = "ready";
    material.sentences = [syntheticSentence()];
    material.paragraphs = [{
      id: "paragraph-synthetic",
      sentenceIds: ["sentence-synthetic"],
      text: material.sentences[0].text,
      wordCount: 8,
    }];
    material.qaHistory = [{ id: "qa-synthetic", sentenceId: "sentence-synthetic" }];
    material.reviewItems = [{ id: "review-synthetic", sentenceId: "sentence-synthetic" }];
    await storage.saveMaterial(material);

    const first = await storage.savePhraseGuideItem(material.id, syntheticGuide({
      usageZh: "第一版用法。",
      patternZh: "follow up on + 事项",
    }));
    const second = await storage.savePhraseGuideItem(material.id, syntheticGuide({
      usageZh: "更新后的用法。",
      patternZh: "follow up on + 名词",
    }));

    assert.equal(first.phraseGuide.id, second.phraseGuide.id);
    assert.equal(first.phraseGuide.createdAt, second.phraseGuide.createdAt);
    assert.equal(second.material.phraseGuides.length, 1);
    assert.equal(second.phraseGuide.key, "sentence-synthetic|follow up on");
    assert.equal(second.phraseGuide.usageZh, "更新后的用法。");
    assert.equal(second.material.qaHistory.length, 1);
    assert.equal(second.material.reviewItems.length, 1);

    await assert.rejects(
      storage.savePhraseGuideItem(material.id, syntheticGuide({
        sourceSentenceText: "A stale synthetic sentence.",
      })),
      (error) => error.code === "PHRASE_GUIDE_SENTENCE_CONFLICT",
    );
    assert.equal((await storage.readMaterial(material.id)).phraseGuides.length, 1);

    const corrected = await storage.updateSentenceText(
      material.id,
      "sentence-synthetic",
      "We should follow up on the revised synthetic checklist tomorrow.",
      { expectedText: syntheticSentence().text },
    );
    assert.deepEqual(corrected.material.phraseGuides, []);
    assert.equal(corrected.material.qaHistory.length, 1);
    assert.equal(corrected.material.reviewItems.length, 1);

    const rawPath = path.join(storage.materialDir(material.id), "material.json");
    const legacy = JSON.parse(await fs.readFile(rawPath, "utf8"));
    delete legacy.phraseGuides;
    await fs.writeFile(rawPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    assert.deepEqual((await storage.readMaterial(material.id)).phraseGuides, []);
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

function syntheticSentence() {
  return {
    id: "sentence-synthetic",
    text: "We should follow up on the synthetic checklist tomorrow.",
    wordCount: 8,
    start: 1,
    end: 5,
    speaker: "Synthetic Speaker",
    analysis: {
      translationZh: "我们明天应跟进这份合成清单。",
      spokenFormNotes: [],
      phrases: [{
        text: "follow up on",
        meaningZh: "跟进某件事",
        usageZh: "用于说明继续处理某项任务。",
      }],
    },
  };
}

function syntheticGuide(overrides = {}) {
  return {
    sentenceId: "sentence-synthetic",
    phraseText: "follow up on",
    sourceSentenceText: syntheticSentence().text,
    meaningZh: "跟进某件事",
    usageZh: "用于说明继续处理某项任务。",
    patternZh: "follow up on + 名词",
    alternatives: [{ text: "check in on", differenceZh: "语气更轻一些。" }],
    examples: [
      { english: "I will follow up on the draft tomorrow.", meaningZh: "我明天会跟进草稿。" },
      { english: "Could you follow up on the sample request?", meaningZh: "你能跟进这项示例请求吗？" },
      { english: "We need to follow up on the open item.", meaningZh: "我们需要跟进未结事项。" },
    ],
    ...overrides,
  };
}
