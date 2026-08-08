import assert from "node:assert/strict";
import test from "node:test";
import { calculateMaterialStudyProgress } from "../lib/progress.mjs";
import { normalizeProgress } from "../lib/storage.mjs";

test("legacy mastery becomes heard without keeping a mastery state", () => {
  assert.deepEqual(normalizeProgress({
    "sentence-1": { status: "mastered", dictation: "hello" },
    "sentence-2": { status: "unrated" },
    "sentence-3": { status: "review" },
  }), {
    "sentence-1": { heard: true, dictation: "hello" },
    "sentence-2": {},
    "sentence-3": { status: "review" },
  });
});

test("study progress counts only fully heard paragraphs", () => {
  const material = {
    sentences: [
      { id: "sentence-1" },
      { id: "sentence-2" },
      { id: "sentence-3" },
      { id: "sentence-4" },
    ],
    paragraphs: [
      { id: "paragraph-1", sentenceIds: ["sentence-1", "sentence-2"] },
      { id: "paragraph-2", sentenceIds: ["sentence-3", "sentence-4"] },
    ],
    progress: {
      "sentence-1": { heard: true },
      "sentence-2": { heard: true },
      "sentence-3": { heard: true },
    },
  };

  assert.deepEqual(calculateMaterialStudyProgress(material), {
    heardUnitCount: 1,
    totalUnitCount: 2,
    progressPercent: 50,
    progressUnit: "段",
  });
});

test("review markers do not count as completed listening", () => {
  const material = {
    sentences: [{ id: "sentence-1" }, { id: "sentence-2" }],
    paragraphs: [],
    progress: { "sentence-1": { status: "review" } },
  };

  assert.deepEqual(calculateMaterialStudyProgress(material), {
    heardUnitCount: 0,
    totalUnitCount: 2,
    progressPercent: 0,
    progressUnit: "句",
  });
});

test("trailing acknowledgement context does not become a progress requirement", () => {
  const material = {
    sentences: [
      { id: "sentence-main" },
      { id: "sentence-okay" },
      { id: "sentence-next" },
    ],
    paragraphs: [
      {
        id: "paragraph-main",
        sentenceIds: ["sentence-main"],
        trailingContextSentenceIds: ["sentence-okay"],
        playbackEnd: 5.4,
      },
      { id: "paragraph-next", sentenceIds: ["sentence-next"] },
    ],
    progress: {
      "sentence-main": { heard: true },
    },
  };

  assert.deepEqual(calculateMaterialStudyProgress(material), {
    heardUnitCount: 1,
    totalUnitCount: 2,
    progressPercent: 50,
    progressUnit: "段",
  });
});
