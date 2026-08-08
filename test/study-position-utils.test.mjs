import test from "node:test";
import assert from "node:assert/strict";
import { resolveLatestStudyIndex, resolveSavedStudyIndex } from "../public/study-position-utils.js";

const units = [
  { id: "paragraph-1", sentenceIds: ["sentence-1", "sentence-2"] },
  { id: "paragraph-2", sentenceIds: ["sentence-3"] },
  { id: "paragraph-3", sentenceIds: ["sentence-4", "sentence-5"] },
  { id: "paragraph-4", sentenceIds: ["sentence-6"] },
];

test("entry resumes at the furthest heard unit when it is later than the saved position", () => {
  const index = resolveLatestStudyIndex(
    units,
    { "sentence-5": { heard: true } },
    { unitId: "paragraph-2", index: 1 },
  );
  assert.equal(index, 2);
});

test("entry keeps a later saved position when heard progress is earlier", () => {
  const index = resolveLatestStudyIndex(
    units,
    { "sentence-2": { heard: true } },
    { unitId: "paragraph-4", index: 3 },
  );
  assert.equal(index, 3);
});

test("entry starts at the first unit when there is no prior listening activity", () => {
  assert.equal(resolveLatestStudyIndex(units, {}, null), 0);
});

test("stale saved ids fall back to a bounded saved index", () => {
  assert.equal(resolveLatestStudyIndex(units, {}, { unitId: "removed", index: 99 }), 3);
});

test("a saved sentence removed by a merge resumes on the merged sentence", () => {
  const sentenceUnits = [
    { id: "synthetic-sentence-before" },
    { id: "synthetic-sentence-canonical", mergedFromSentenceIds: ["synthetic-sentence-canonical", "synthetic-sentence-retired"] },
    { id: "synthetic-sentence-after" },
  ];
  assert.equal(
    resolveSavedStudyIndex(sentenceUnits, { unitId: "synthetic-sentence-retired", index: 2 }),
    1,
  );
  assert.equal(
    resolveLatestStudyIndex(sentenceUnits, {}, { unitId: "synthetic-sentence-retired", index: 2 }),
    1,
  );
});

test("a saved acknowledgement paragraph resumes on its substantive parent segment", () => {
  const paragraphUnits = [
    { id: "synthetic-paragraph-before" },
    { id: "synthetic-paragraph-canonical", mergedFromParagraphIds: ["synthetic-paragraph-canonical", "synthetic-paragraph-retired"] },
    { id: "synthetic-paragraph-after" },
  ];
  assert.equal(
    resolveSavedStudyIndex(paragraphUnits, { unitId: "synthetic-paragraph-retired", index: 2 }),
    1,
  );
  assert.equal(
    resolveLatestStudyIndex(paragraphUnits, {}, { unitId: "synthetic-paragraph-retired", index: 2 }),
    1,
  );
});
