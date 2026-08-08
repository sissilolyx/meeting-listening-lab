import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildLearnerDifficultyProfile,
  normalizeKnowledgeText,
  readLearnerProfile,
  removeTooSimpleKnowledge,
  saveTooSimpleKnowledge,
} from "../lib/learner-profile.mjs";

test("too-simple feedback persists globally and deduplicates equivalent expressions", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "listening-profile-"));
  const filePath = path.join(directory, "learner-profile.json");
  try {
    const first = await saveTooSimpleKnowledge({
      text: "Thank you",
      meaningZh: "谢谢",
      context: { materialId: "material-one", sentenceId: "sentence-one" },
    }, { filePath });
    const second = await saveTooSimpleKnowledge({
      text: "thank-you",
      meaningZh: "礼貌致谢",
      context: { materialId: "material-two", sentenceId: "sentence-two" },
    }, { filePath });

    assert.equal(normalizeKnowledgeText("Thank-you!"), "thank you");
    assert.equal(first.tooSimple.length, 1);
    assert.equal(second.tooSimple.length, 1);
    assert.equal(second.tooSimple[0].contexts.length, 2);

    const difficulty = buildLearnerDifficultyProfile(await readLearnerProfile({ filePath }));
    assert.equal(difficulty.explicitTooSimpleCount, 1);
    assert.deepEqual(difficulty.tooSimpleExamples.map((item) => item.text), ["thank-you"]);

    const cleared = await removeTooSimpleKnowledge(second.tooSimple[0].id, { filePath });
    assert.equal(cleared.tooSimple.length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
