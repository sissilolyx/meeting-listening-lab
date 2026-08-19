import assert from "node:assert/strict";
import test from "node:test";

import {
  STUDY_MODE_INTENSIVE,
  STUDY_MODE_REVIEW,
  defaultStudyPreferences,
  loadStudyPreferences,
  resetMaterialCompletion,
  saveStudyPreferences,
  shouldCompleteMaterial,
  transitionMaterialCompletion,
  updateStudyPreferences,
} from "../public/study-mode-utils.js";

const paragraphs = [
  { id: "synthetic-paragraph-1" },
  { id: "synthetic-paragraph-2" },
  { id: "synthetic-paragraph-3" },
];

test("global study preferences default to intensive mode and all-material review", () => {
  assert.deepEqual(defaultStudyPreferences(), {
    mode: STUDY_MODE_INTENSIVE,
    reviewScope: { kind: "all" },
  });
  assert.deepEqual(loadStudyPreferences(memoryStorage()), defaultStudyPreferences());
});

test("global last mode and a material review scope survive persistence", () => {
  const storage = memoryStorage();
  let preferences = updateStudyPreferences(defaultStudyPreferences(), {
    type: "set-review-scope",
    scope: { kind: "material", materialId: "synthetic-material-a" },
  });
  preferences = updateStudyPreferences(preferences, { type: "set-mode", mode: STUDY_MODE_REVIEW });
  saveStudyPreferences(storage, preferences);

  assert.deepEqual(loadStudyPreferences(storage), {
    mode: STUDY_MODE_REVIEW,
    reviewScope: { kind: "material", materialId: "synthetic-material-a" },
  });
});

test("switching modes does not discard the remembered review scope", () => {
  const scoped = updateStudyPreferences(defaultStudyPreferences(), {
    type: "set-review-scope",
    scope: { kind: "material", materialId: "synthetic-material-a" },
  });
  const intensive = updateStudyPreferences(scoped, { type: "set-mode", mode: STUDY_MODE_INTENSIVE });
  const review = updateStudyPreferences(intensive, { type: "set-mode", mode: STUDY_MODE_REVIEW });
  assert.deepEqual(review.reviewScope, scoped.reviewScope);
});

test("invalid or inaccessible preference storage safely falls back to defaults", () => {
  const malformed = memoryStorage({ initialValue: "not-json" });
  assert.deepEqual(loadStudyPreferences(malformed), defaultStudyPreferences());
  assert.doesNotThrow(() => saveStudyPreferences({ setItem() { throw new Error("blocked"); } }, {}));
});

test("only a full natural pass of the actual final paragraph completes a material", () => {
  const result = transitionMaterialCompletion(eligibleCompletionEvent(), "2026-08-09T10:30:00.000Z");
  assert.equal(result.transitioned, true);
  assert.deepEqual(result.completion, {
    completed: true,
    completedAt: "2026-08-09T10:30:00.000Z",
    replayRequiredAfter: null,
  });
});

test("review mode and a filtered intensive view cannot complete a material", () => {
  assert.equal(shouldCompleteMaterial(eligibleCompletionEvent({ mode: STUDY_MODE_REVIEW })), false);
  assert.equal(shouldCompleteMaterial(eligibleCompletionEvent({ reviewFilterActive: true })), false);
});

test("the last visible review item is not mistaken for the material's actual final paragraph", () => {
  assert.equal(shouldCompleteMaterial(eligibleCompletionEvent({
    paragraphId: "synthetic-paragraph-2",
  })), false);
});

test("seek, partial progress, TTS, and sentence-speaker playback never complete a material", () => {
  const invalidPasses = [
    { reachedContentEnd: false, completionRatio: 0.9 },
    { endedBySeek: true },
    { mediaKind: "tts" },
    { surface: "sentence-speaker" },
    { startedFromBeginning: false },
  ];
  for (const playbackPass of invalidPasses) {
    assert.equal(shouldCompleteMaterial(eligibleCompletionEvent({ playbackPass })), false);
  }
});

test("completion is an idempotent false-to-true transition", () => {
  const completed = {
    completed: true,
    completedAt: "2026-08-09T09:00:00.000Z",
  };
  const result = transitionMaterialCompletion(eligibleCompletionEvent({ completion: completed }));
  assert.equal(result.transitioned, false);
  assert.equal(result.completion.completedAt, completed.completedAt);
});

test("manual reset cannot re-complete from old progress and requires a new full replay", () => {
  const reset = resetMaterialCompletion({
    completed: true,
    completedAt: "2026-08-09T09:00:00.000Z",
  }, "2026-08-09T10:00:00.000Z");
  assert.equal(reset.transitioned, true);

  const stalePass = eligibleCompletionEvent({
    completion: reset.completion,
    playbackPass: { startedAt: "2026-08-09T09:59:00.000Z" },
  });
  assert.equal(shouldCompleteMaterial(stalePass), false);

  const replay = transitionMaterialCompletion(eligibleCompletionEvent({
    completion: reset.completion,
    playbackPass: { startedAt: "2026-08-09T10:01:00.000Z" },
  }), "2026-08-09T10:02:00.000Z");
  assert.equal(replay.transitioned, true);
  assert.equal(replay.completion.replayRequiredAfter, null);
});

function eligibleCompletionEvent(overrides = {}) {
  const standardPass = {
    surface: "paragraph-player",
    mediaKind: "original",
    startedFromBeginning: true,
    reachedContentEnd: true,
    endedNaturally: true,
    endedBySeek: false,
    startedAt: "2026-08-09T10:15:00.000Z",
  };
  return {
    completion: { completed: false },
    mode: STUDY_MODE_INTENSIVE,
    reviewFilterActive: false,
    paragraphs,
    paragraphId: "synthetic-paragraph-3",
    ...overrides,
    playbackPass: { ...standardPass, ...(overrides.playbackPass || {}) },
  };
}

function memoryStorage({ initialValue = null } = {}) {
  const values = new Map(initialValue === null ? [] : [["meeting-listening-lab.study-preferences.v1", initialValue]]);
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}
