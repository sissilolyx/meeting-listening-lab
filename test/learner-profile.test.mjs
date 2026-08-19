import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildLearnerDifficultyProfile,
  buildLearnerDifficultyPromptProfile,
  normalizeKnowledgeText,
  readLearnerProfile,
  recordPhraseSignal,
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

test("implicit difficulty requires three contexts and two sessions while deduplicating repeated exposure", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "listening-profile-signals-"));
  const filePath = path.join(directory, "learner-profile.json");
  const phrase = {
    text: "synthetic alignment pattern",
    meaningZh: "合成对齐表达",
    usageZh: "仅用于测试难度学习。",
  };
  try {
    const first = await recordPhraseSignal({
      event: "exposed",
      sessionId: "session-a",
      ...phrase,
      context: { materialId: "material-one", sentenceId: "sentence-one" },
    }, { filePath });
    const duplicate = await recordPhraseSignal({
      event: "exposed",
      sessionId: "session-a",
      ...phrase,
      context: { materialId: "material-one", sentenceId: "sentence-one" },
    }, { filePath });
    assert.equal(first.signal.contextCount, 1);
    assert.equal(duplicate.signal.exposures.length, 1);
    assert.equal(duplicate.signal.implicitEasy, false);

    const secondSessionSameContext = await recordPhraseSignal({
      event: "exposed",
      sessionId: "session-b",
      ...phrase,
      context: { materialId: "material-one", sentenceId: "sentence-one" },
    }, { filePath });
    assert.equal(secondSessionSameContext.signal.contextCount, 1);
    assert.equal(secondSessionSameContext.signal.sessionCount, 2);
    assert.equal(secondSessionSameContext.signal.implicitEasy, false);

    await recordPhraseSignal({
      event: "exposed",
      sessionId: "session-a",
      ...phrase,
      context: { materialId: "material-one", sentenceId: "sentence-two" },
    }, { filePath });
    const inferred = await recordPhraseSignal({
      event: "exposed",
      sessionId: "session-a",
      ...phrase,
      context: { materialId: "material-two", sentenceId: "sentence-three" },
    }, { filePath });
    assert.equal(inferred.signal.contextCount, 3);
    assert.equal(inferred.signal.sessionCount, 2);
    assert.equal(inferred.signal.implicitEasy, true);

    const difficulty = buildLearnerDifficultyProfile(inferred.profile);
    assert.equal(difficulty.explicitTooSimpleCount, 0);
    assert.equal(difficulty.implicitTooSimpleCount, 1);
    assert.deepEqual(difficulty.tooSimpleExamples, [phrase]);

    const promptProfile = buildLearnerDifficultyPromptProfile(inferred.profile);
    assert.deepEqual(promptProfile, [phrase]);
    assert.deepEqual(Object.keys(promptProfile[0]).sort(), ["meaningZh", "text", "usageZh"]);
    assert.doesNotMatch(JSON.stringify(promptProfile), /material-|sentence-|session-|implicitEasyAt|hash/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("review, guide, and question evidence permanently block or revoke implicit-easy inference", async (t) => {
  for (const event of ["review_added", "guide_opened", "asked"]) {
    await t.test(event, async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), `listening-profile-${event}-`));
      const filePath = path.join(directory, "learner-profile.json");
      const phrase = {
        text: `synthetic ${event} phrase`,
        meaningZh: "合成表达",
        usageZh: "仅用于测试反证。",
      };
      try {
        await Promise.all([
          recordPhraseSignal({
            event: "exposed",
            sessionId: "session-a",
            ...phrase,
            context: { materialId: "material-a", sentenceId: "sentence-a" },
          }, { filePath }),
          recordPhraseSignal({
            event: "exposed",
            sessionId: "session-a",
            ...phrase,
            context: { materialId: "material-a", sentenceId: "sentence-b" },
          }, { filePath }),
          recordPhraseSignal({
            event: "exposed",
            sessionId: "session-b",
            ...phrase,
            context: { materialId: "material-b", sentenceId: "sentence-c" },
          }, { filePath }),
        ]);
        const before = await readLearnerProfile({ filePath });
        assert.equal(buildLearnerDifficultyProfile(before).implicitTooSimpleCount, 1);

        const blocked = await recordPhraseSignal({
          event,
          ...phrase,
          context: { materialId: "material-a", sentenceId: "sentence-a" },
        }, { filePath });
        assert.equal(blocked.signal.blocked, true);
        assert.equal(blocked.signal.implicitEasy, false);
        assert.equal(blocked.signal.implicitEasyAt, null);
        assert.equal(Number.isNaN(Date.parse(blocked.signal.lastRevokedAt)), false);
        assert.equal(buildLearnerDifficultyProfile(blocked.profile).implicitTooSimpleCount, 0);

        await recordPhraseSignal({
          event: "exposed",
          sessionId: "session-c",
          ...phrase,
          context: { materialId: "material-c", sentenceId: "sentence-d" },
        }, { filePath });
        const afterMoreExposure = await readLearnerProfile({ filePath });
        assert.equal(buildLearnerDifficultyProfile(afterMoreExposure).implicitTooSimpleCount, 0);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("version-one learner profiles remain readable and gain an empty phraseSignals collection", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "listening-profile-legacy-"));
  const filePath = path.join(directory, "learner-profile.json");
  try {
    await fs.writeFile(filePath, JSON.stringify({
      version: 1,
      updatedAt: "2026-08-01T00:00:00.000Z",
      tooSimple: [{
        id: "simple-legacy",
        text: "Legacy synthetic phrase",
        meaningZh: "旧版合成表达",
        usageZh: "旧版用法",
        firstMarkedAt: "2026-08-01T00:00:00.000Z",
        lastMarkedAt: "2026-08-01T00:00:00.000Z",
      }],
    }));
    const profile = await readLearnerProfile({ filePath });
    assert.equal(profile.version, 2);
    assert.deepEqual(profile.phraseSignals, []);
    assert.equal(buildLearnerDifficultyProfile(profile).explicitTooSimpleCount, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
