import test from "node:test";
import assert from "node:assert/strict";
import { repairSparseLarkTranscriptFromBlocks } from "../lib/lark-transcript-repair.mjs";
import {
  reconcileTranscriptParagraphs,
  reconcileTranscriptSentences,
} from "../lib/transcript-reconciliation.mjs";

test("an already-local Whisper transcript fills a sparse Lark window without borrowing neighbouring speech", () => {
  const official = [
    { id: "block-before", speaker: "Speaker A", start: 0, end: 4, text: "The paper boat is ready." },
    { id: "block-gap", speaker: "Speaker B", start: 4, end: 24, text: "Got it." },
    { id: "block-after", speaker: "Speaker A", start: 24, end: 29, text: "The brass lantern is next." },
  ];
  const whisper = [
    { id: "whisper-before", start: 2, end: 3.8, text: "The paper boat is ready." },
    { id: "whisper-one", start: 4.05, end: 5, text: "Got it." },
    { id: "whisper-two", start: 5, end: 12, text: "First we arrange the seven wooden stars beside the velvet bridge." },
    { id: "whisper-three", start: 12, end: 23.8, text: "Then the clockwork fox carries every silver envelope to the lighthouse keeper." },
    { id: "whisper-after", start: 24.1, end: 27, text: "The brass lantern is next." },
  ];

  const result = repairSparseLarkTranscriptFromBlocks(official, whisper);
  assert.equal(result.repairs.length, 1);
  assert.equal(result.blocks[0].id, "block-before");
  assert.equal(result.blocks.at(-1).id, "block-after");
  assert.deepEqual(result.blocks.slice(1, -1).map((item) => item.text), [
    "Got it.",
    "First we arrange the seven wooden stars beside the velvet bridge.",
    "Then the clockwork fox carries every silver envelope to the lighthouse keeper.",
  ]);
  assert.ok(result.blocks.slice(1, -1).every((item) => item.speaker === "Speaker B"));
});

test("repair reconciliation preserves a known utterance and the best matching old paragraph identity", () => {
  const previousSentences = [
    {
      id: "sentence-known",
      speaker: "Speaker B",
      sourceBlockId: "block-gap",
      start: 4,
      end: 24,
      text: "Got it.",
      analysis: { translationZh: "synthetic" },
      playbackStart: 4.12,
      playbackEnd: 5.08,
      playbackTimingQuality: "whisper-aligned",
      playbackAlignmentCoverage: 1,
    },
    { id: "sentence-existing-a", speaker: "Speaker B", start: 24, end: 28, text: "The next toy moves." },
    { id: "sentence-existing-b", speaker: "Speaker B", start: 28, end: 32, text: "The final bell rings." },
  ];
  let sentenceCounter = 0;
  const sentences = reconcileTranscriptSentences(previousSentences, [
    { speaker: "Speaker B", sourceBlockId: "block-gap", start: 4.05, end: 5, text: "Got it." },
    { speaker: "Speaker B", start: 5, end: 12, text: "A newly recovered synthetic sentence." },
    { speaker: "Speaker B", start: 24, end: 28, text: "The next toy moves." },
    { speaker: "Speaker B", start: 28, end: 32, text: "The final bell rings." },
  ], () => `sentence-new-${++sentenceCounter}`);

  assert.equal(sentences[0].id, "sentence-known");
  assert.deepEqual(sentences[0].analysis, { translationZh: "synthetic" });
  assert.equal(sentences[0].playbackStart, 4.12);
  assert.equal(sentences[0].playbackEnd, 5.08);
  assert.equal(sentences[0].playbackTimingQuality, "whisper-aligned");
  assert.equal(sentences[0].playbackAlignmentCoverage, 1);
  assert.equal(sentences[1].id, "sentence-new-1");

  let paragraphCounter = 0;
  const paragraphs = reconcileTranscriptParagraphs([{
    id: "paragraph-existing",
    speaker: "Speaker B",
    start: 4,
    end: 32,
    sentenceIds: ["sentence-known", "sentence-existing-a", "sentence-existing-b"],
  }], [
    { speaker: "Speaker B", start: 4.05, end: 12, sentenceIds: ["sentence-known", "sentence-new-1"] },
    { speaker: "Speaker B", start: 24, end: 32, sentenceIds: ["sentence-existing-a", "sentence-existing-b"] },
  ], () => `paragraph-new-${++paragraphCounter}`);

  assert.equal(paragraphs[0].id, "paragraph-new-1");
  assert.equal(paragraphs[1].id, "paragraph-existing");
});

test("reconciliation drops inherited playback when the rebuilt sentence changes source block", () => {
  const [sentence] = reconcileTranscriptSentences([{
    id: "sentence-existing",
    sourceBlockId: "block-before",
    speaker: "Speaker B",
    start: 8,
    end: 10,
    text: "The synthetic bell rings.",
    analysis: { translationZh: "synthetic" },
    playbackStart: 8.1,
    playbackEnd: 9.8,
    playbackTimingQuality: "whisper-aligned",
    playbackAlignmentCoverage: 1,
  }], [{
    sourceBlockId: "block-after",
    speaker: "Speaker B",
    start: 8,
    end: 10,
    text: "The synthetic bell rings.",
  }], () => "sentence-new");

  assert.equal(sentence.id, "sentence-existing");
  assert.deepEqual(sentence.analysis, { translationZh: "synthetic" });
  assert.equal(sentence.playbackStart, undefined);
  assert.equal(sentence.playbackEnd, undefined);
  assert.equal(sentence.playbackTimingQuality, undefined);
  assert.equal(sentence.playbackAlignmentCoverage, undefined);
});

test("reconciliation drops stale aligned playback outside the rebuilt sentence window", () => {
  const [sentence] = reconcileTranscriptSentences([{
    id: "sentence-existing",
    sourceBlockId: "block-shared",
    speaker: "Speaker B",
    start: 20,
    end: 22,
    text: "The synthetic bell rings.",
    playbackStart: 12.1,
    playbackEnd: 13.8,
    playbackTimingQuality: "whisper-aligned",
    playbackAlignmentCoverage: 0.9,
  }], [{
    sourceBlockId: "block-shared",
    speaker: "Speaker B",
    start: 20,
    end: 22,
    text: "The synthetic bell rings.",
  }], () => "sentence-new");

  assert.equal(sentence.id, "sentence-existing");
  assert.equal(sentence.playbackStart, undefined);
  assert.equal(sentence.playbackEnd, undefined);
  assert.equal(sentence.playbackTimingQuality, undefined);
  assert.equal(sentence.playbackAlignmentCoverage, undefined);
});

test("reconciliation preserves valid manual playback within the same source block", () => {
  const [sentence] = reconcileTranscriptSentences([{
    id: "sentence-existing",
    sourceBlockId: "block-shared",
    speaker: "Speaker B",
    start: 20,
    end: 22,
    text: "The synthetic bell rings.",
    playbackStart: 12.1,
    playbackEnd: 13.8,
    playbackTimingQuality: "manual",
  }], [{
    sourceBlockId: "block-shared",
    speaker: "Speaker B",
    start: 20,
    end: 22,
    text: "The synthetic bell rings.",
  }], () => "sentence-new");

  assert.equal(sentence.id, "sentence-existing");
  assert.equal(sentence.playbackStart, 12.1);
  assert.equal(sentence.playbackEnd, 13.8);
  assert.equal(sentence.playbackTimingQuality, "manual");
});

test("manual playback never crosses source-block boundaries during reconciliation", () => {
  const [sentence] = reconcileTranscriptSentences([{
    id: "sentence-existing",
    sourceBlockId: "block-before",
    speaker: "Speaker B",
    start: 20,
    end: 22,
    text: "The synthetic bell rings.",
    playbackStart: 12.1,
    playbackEnd: 13.8,
    playbackTimingQuality: "manual",
  }], [{
    sourceBlockId: "block-after",
    speaker: "Speaker B",
    start: 20,
    end: 22,
    text: "The synthetic bell rings.",
  }], () => "sentence-new");

  assert.equal(sentence.id, "sentence-existing");
  assert.equal(sentence.playbackStart, undefined);
  assert.equal(sentence.playbackEnd, undefined);
  assert.equal(sentence.playbackTimingQuality, undefined);
});

test("reconciliation rejects invalid manual playback bounds", () => {
  const [sentence] = reconcileTranscriptSentences([{
    id: "sentence-existing",
    sourceBlockId: "block-shared",
    speaker: "Speaker B",
    start: 20,
    end: 22,
    text: "The synthetic bell rings.",
    playbackStart: 13.8,
    playbackEnd: 12.1,
    playbackTimingQuality: "manual",
  }], [{
    sourceBlockId: "block-shared",
    speaker: "Speaker B",
    start: 20,
    end: 22,
    text: "The synthetic bell rings.",
  }], () => "sentence-new");

  assert.equal(sentence.id, "sentence-existing");
  assert.equal(sentence.playbackStart, undefined);
  assert.equal(sentence.playbackEnd, undefined);
  assert.equal(sentence.playbackTimingQuality, undefined);
});
