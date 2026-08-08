import assert from "node:assert/strict";
import test from "node:test";

import {
  playbackLeadInRatio,
  playbackTargetCompletion,
  resolveParagraphLeadIn,
  resolveParagraphPlaybackRange,
  resolveSentencePlaybackRange,
} from "../public/playback-range-utils.js";

test("Whisper-aligned playback bounds cover the target without expanding to adjacent sentences", () => {
  const sentences = [
    sentence("synthetic-sentence-before", 10, 14, "synthetic-block-alpha"),
    {
      ...sentence("synthetic-sentence-target", 14, 20, "synthetic-block-alpha"),
      playbackStart: 14.35,
      playbackEnd: 19.72,
      playbackTimingQuality: "whisper-aligned",
    },
    sentence("synthetic-sentence-after", 20, 27, "synthetic-block-alpha"),
  ];

  assert.deepEqual(resolveSentencePlaybackRange({ sentence: sentences[1], sentences, mediaDuration: 30 }), {
    start: 14.35,
    contentStart: 14.35,
    contentEnd: 19.72,
    end: 19.72,
    expanded: false,
    previousSentenceId: null,
    nextSentenceId: null,
  });
  assert(resolveSentencePlaybackRange({ sentence: sentences[1], sentences }).end > 19.5);
  assert(resolveSentencePlaybackRange({ sentence: sentences[1], sentences }).end < sentences[2].end);
});

test("an unaligned estimated sentence stays inside its own display window", () => {
  const sentences = [
    sentence("sentence-1", 5, 10, "block-1"),
    sentence("sentence-2", 10, 15, "block-1"),
    sentence("sentence-3", 15, 20, "block-1"),
  ];
  assert.deepEqual(resolveSentencePlaybackRange({ sentence: sentences[1], sentences }), {
    start: 10,
    contentStart: 10,
    contentEnd: 15,
    end: 15,
    expanded: false,
    previousSentenceId: null,
    nextSentenceId: null,
  });
});

test("precise sentence timing stays precise", () => {
  const precise = sentence("sentence-2", 10, 12.5, "block-1", "source");
  assert.deepEqual(resolveSentencePlaybackRange({ sentence: precise, sentences: [precise] }), {
    start: 10,
    contentStart: 10,
    contentEnd: 12.5,
    end: 12.5,
    expanded: false,
    previousSentenceId: null,
    nextSentenceId: null,
  });
});

test("sentence playback never seeks past the actual media duration", () => {
  const aligned = {
    ...sentence("sentence-2", 10, 15, "block-1"),
    playbackStart: 11,
    playbackEnd: 16,
  };
  assert.deepEqual(resolveSentencePlaybackRange({ sentence: aligned, sentences: [aligned], mediaDuration: 12.5 }), {
    start: 11,
    contentStart: 11,
    contentEnd: 12.5,
    end: 12.5,
    expanded: false,
    previousSentenceId: null,
    nextSentenceId: null,
  });
});

test("estimated playback does not borrow time from another speaker or source block", () => {
  const target = sentence("sentence-2", 10, 15, "block-2");
  const sentences = [
    sentence("sentence-1", 5, 10, "block-1"),
    target,
    sentence("sentence-3", 15, 20, "block-2", "estimated", "Speaker B"),
  ];
  assert.deepEqual(resolveSentencePlaybackRange({ sentence: target, sentences }), {
    start: 10,
    contentStart: 10,
    contentEnd: 15,
    end: 15,
    expanded: false,
    previousSentenceId: null,
    nextSentenceId: null,
  });
});

test("a paragraph follows the precise first and last sentence audio bounds", () => {
  const sentences = [
    {
      ...sentence("synthetic-opening", 100, 104, "synthetic-block"),
      playbackStart: 101.2,
      playbackEnd: 104.1,
    },
    sentence("synthetic-middle", 104, 108, "synthetic-block"),
    {
      ...sentence("synthetic-closing", 108, 112, "synthetic-block"),
      playbackStart: 112.7,
      playbackEnd: 117.4,
    },
  ];
  const unit = {
    id: "synthetic-paragraph",
    start: 100,
    end: 112,
    sentenceIds: sentences.map((item) => item.id),
  };

  assert.deepEqual(resolveParagraphPlaybackRange({ unit, sentences }), {
    start: 101.2,
    contentStart: 101.2,
    contentEnd: 117.4,
    end: 117.4,
    alignedStart: true,
    alignedEnd: true,
  });
});

test("a precise paragraph ending can remove an overly long display tail while retaining trailing context", () => {
  const sentences = [{
    ...sentence("synthetic-closing", 30, 40, "synthetic-block"),
    playbackStart: 31,
    playbackEnd: 37.5,
  }];
  const unit = {
    id: "synthetic-paragraph",
    start: 30,
    end: 40,
    playbackEnd: 38.2,
    sentenceIds: [sentences[0].id],
  };

  assert.equal(resolveParagraphPlaybackRange({ unit, sentences }).contentEnd, 37.5);
  assert.equal(resolveParagraphPlaybackRange({ unit, sentences }).end, 38.2);
});

test("a contiguous word-limit split in the same speaker block receives a three-second lead-in", () => {
  const paragraphs = [
    paragraph("paragraph-1", 0, 10, "Speaker A", ["block-1"]),
    paragraph("paragraph-2", 10, 20, "Speaker A", ["block-1"]),
  ];

  assert.deepEqual(resolveParagraphLeadIn({ unit: paragraphs[1], paragraphs }), {
    start: 7,
    seconds: 3,
    previousParagraphId: "paragraph-1",
  });
});

test("lead-in never reaches earlier than the previous short paragraph", () => {
  const paragraphs = [
    paragraph("paragraph-1", 8.4, 10, "Speaker A", ["block-1"]),
    paragraph("paragraph-2", 10, 20, "Speaker A", ["block-1"]),
  ];

  assert.deepEqual(resolveParagraphLeadIn({ unit: paragraphs[1], paragraphs }), {
    start: 8.4,
    seconds: 1.6,
    previousParagraphId: "paragraph-1",
  });
});

test("speaker, source-block, and pause boundaries do not receive a lead-in", () => {
  const previous = paragraph("paragraph-1", 0, 10, "Speaker A", ["block-1"]);
  const variants = [
    paragraph("paragraph-2", 10, 20, "Speaker B", ["block-1"]),
    paragraph("paragraph-2", 10, 20, "Speaker A", ["block-2"]),
    paragraph("paragraph-2", 10.6, 20, "Speaker A", ["block-1"]),
  ];

  for (const unit of variants) {
    assert.equal(resolveParagraphLeadIn({ unit, paragraphs: [previous, unit] }).seconds, 0);
  }
});

test("progress can show the full playback window while completion counts only the target passage", () => {
  const range = { start: 7, contentStart: 10, contentEnd: 20, end: 20 };
  assert.equal(playbackTargetCompletion(range, 9.9), 0);
  assert.equal(playbackTargetCompletion(range, 15), 0.5);
  assert.equal(playbackTargetCompletion(range, 19), 0.9);
  assert(Math.abs(playbackLeadInRatio(range) - (3 / 13)) < 1e-9);
});

function paragraph(id, start, end, speaker, sourceBlockIds) {
  return {
    id,
    start,
    end,
    speaker,
    sourceBlockId: sourceBlockIds[0],
    sourceBlockIds,
    sentenceIds: [`${id}-sentence`],
  };
}

function sentence(id, start, end, sourceBlockId, timingQuality = "estimated", speaker = "Speaker A") {
  return { id, start, end, sourceBlockId, timingQuality, speaker };
}
