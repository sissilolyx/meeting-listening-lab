import test from "node:test";
import assert from "node:assert/strict";
import { hasTranscriptReconstruction, resolvedLearningSource } from "../public/qa-answer-utils.js";

test("uses the reconstructed spoken sentence as the review target after a likely ASR error", () => {
  const answer = {
    transcriptStatus: "likely_mistranscribed",
    selectedText: "the brighter marker easier follow path",
    likelySpokenEnglish: "The brighter the marker, the easier the path is to follow.",
  };
  assert.equal(hasTranscriptReconstruction(answer), true);
  assert.equal(
    resolvedLearningSource(answer),
    "The brighter the marker, the easier the path is to follow.",
  );
});

test("keeps the selected transcript when no specific reconstruction is supported", () => {
  const answer = {
    transcriptStatus: "credible",
    selectedText: "The sample arrived intact.",
    likelySpokenEnglish: "",
  };
  assert.equal(hasTranscriptReconstruction(answer), false);
  assert.equal(resolvedLearningSource(answer), "The sample arrived intact.");
});
