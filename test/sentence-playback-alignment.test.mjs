import assert from "node:assert/strict";
import test from "node:test";

import {
  alignSentencePlaybackRanges,
  extractWhisperTimedWords,
} from "../lib/sentence-playback-alignment.mjs";

test("a synthetic Whisper fixture preserves official text and adds tight playback bounds", () => {
  const sentences = [
    estimatedSentence(
      "synthetic-lantern-cue",
      10,
      18,
      "During the lantern rehearsal, the cardboard comet passes the silver arch before the tiny drum sounds.",
    ),
    estimatedSentence(
      "synthetic-puppet-cue",
      18,
      28,
      "Afterward the puppeteer rotates the violet wheel twice and places a paper star inside the wooden box.",
    ),
  ];
  const whisperPayload = whisper([
    entry(9.8, 12.2, "During the lantern rehearsal the cardboard comet"),
    entry(12.2, 16.4, "passes the silver arch before the tiny drum sounds"),
    entry(17.1, 21.4, "Afterward the puppeteer rotates the violet wheel twice"),
    entry(21.4, 26, "and places a paper star inside the wooden box"),
  ]);

  const result = alignSentencePlaybackRanges(sentences, whisperPayload);
  assert.equal(result.alignedCount, 2);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.sentences[0].text, sentences[0].text);
  assert.equal(result.sentences[0].start, 10);
  assert.equal(result.sentences[0].end, 18);
  assert(result.sentences[0].playbackStart <= 9.8);
  assert(result.sentences[0].playbackEnd >= 16.4);
  assert(result.sentences[0].playbackEnd < 17.2);
  assert(result.sentences[1].playbackStart > 16.9);
  assert(result.sentences[1].playbackEnd >= 26);
  assert(result.sentences[1].playbackEnd < 26.3);
  assert(result.sentences[0].playbackEnd - result.sentences[1].playbackStart <= 0.121);
  assert.equal(result.sentences[1].playbackTimingQuality, "whisper-aligned");
});

test("alignment reaches a verified final word without borrowing the next full sentence", () => {
  const sentences = [
    estimatedSentence("synthetic-owl-intro", 40, 44, "Before the museum opens, count the ceramic owls.", "synthetic-museum-block"),
    estimatedSentence(
      "synthetic-midnight-display",
      44,
      52,
      "For the midnight display place four copper triangles beside the striped umbrella and lock the glass drawer afterward.",
      "synthetic-museum-block",
    ),
    estimatedSentence(
      "synthetic-pedestal-followup",
      52,
      60,
      "Then sketch the empty pedestal and label every shadow with a lowercase letter.",
      "synthetic-museum-block",
    ),
  ];
  const whisperPayload = whisper([
    entry(40.2, 43.8, "Before the museum opens count the ceramic owls"),
    entry(44.4, 47.6, "For the midnight display place four copper triangles"),
    entry(47.6, 51.3, "beside the striped umbrella and lock the glass drawer afterward"),
    entry(51.8, 55.2, "Then sketch the empty pedestal"),
    entry(55.2, 58.7, "and label every shadow with a lowercase letter"),
  ]);

  const result = alignSentencePlaybackRanges(sentences, whisperPayload);
  const target = result.sentences[1];
  assert(target.playbackStart > 44.1 && target.playbackStart <= 44.4);
  assert(target.playbackEnd >= 51.3);
  assert(target.playbackEnd < 51.9);
});

test("a strict fallback window recovers a sentence after an early source-block boundary", () => {
  const sentences = [
    estimatedSentence(
      "synthetic-courtyard-intro",
      200,
      204,
      "The blue lantern swings above the velvet staircase.",
      "synthetic-late-block",
    ),
    estimatedSentence(
      "synthetic-courtyard-target",
      204,
      209,
      "After the bell rings carry the wooden telescope across the courtyard and place it beside the painted fountain.",
      "synthetic-late-block",
    ),
  ];
  const whisperPayload = whisper([
    entry(200.1, 203.7, "The blue lantern swings above the velvet staircase"),
    entry(209.2, 214.8, "After the bell rings carry the wooden telescope across the courtyard and place it beside the painted fountain"),
  ]);

  const primaryOnly = alignSentencePlaybackRanges(sentences, whisperPayload, {
    fallbackBlockWindowPaddingSeconds: 1.5,
  });
  assert.equal(primaryOnly.sentences[1].playbackEnd, undefined);

  const recovered = alignSentencePlaybackRanges(sentences, whisperPayload);
  assert.equal(recovered.sentences[0].playbackStart, primaryOnly.sentences[0].playbackStart);
  assert.equal(recovered.sentences[0].playbackEnd, primaryOnly.sentences[0].playbackEnd);
  assert(recovered.sentences[1].playbackStart <= 209.2);
  assert(recovered.sentences[1].playbackEnd >= 214.8);
  assert(recovered.sentences[1].playbackEnd < 215.1);
  assert(recovered.sentences[1].playbackAlignmentCoverage >= 0.8);
});

test("a zero-duration acknowledgement is not swallowed by the following sentence", () => {
  const sentences = [
    estimatedSentence("synthetic-acknowledgement", 70, 70.4, "Splendid.", "synthetic-transition-block"),
    estimatedSentence(
      "synthetic-next-step",
      70.4,
      75.5,
      "Next we fold the orange ribbon beneath the clockwork bird.",
      "synthetic-transition-block",
    ),
  ];
  const whisperPayload = {
    transcription: [{
      tokens: [
        token(" Splendid", 70050, 70050),
        token(" next", 70050, 70050),
        token(" we", 70050, 70600),
        token(" fold", 70600, 71800),
        token(" the", 71800, 71950),
        token(" orange", 71950, 72200),
        token(" ribbon", 72200, 72600),
        token(" beneath", 72600, 73500),
        token(" the", 73500, 73900),
        token(" clockwork", 73900, 74200),
        token(" bird", 74200, 74500),
      ],
    }],
  };

  const result = alignSentencePlaybackRanges(sentences, whisperPayload);
  const [acknowledgement, following] = result.sentences;
  assert.equal(result.alignedCount, 2);
  assert(acknowledgement.playbackEnd - following.playbackStart <= 0.121);
  assert(following.playbackStart > acknowledgement.playbackStart);
  assert(acknowledgement.playbackEnd < following.playbackEnd);
  assert.equal(rangeContains(following, acknowledgement), false);
});

test("existing precise bounds remain untouched unless force is requested", () => {
  const sentence = {
    ...estimatedSentence("sentence-1", 10, 15, "A complete sentence."),
    playbackStart: 10.2,
    playbackEnd: 14.8,
    playbackTimingQuality: "manual",
  };
  const result = alignSentencePlaybackRanges([sentence], whisper([entry(10, 15, "A complete sentence")]));
  assert.deepEqual(result.sentences[0], sentence);
  assert.equal(result.alignedCount, 0);
});

test("low-confidence transcript text does not create misleading playback bounds", () => {
  const sentence = estimatedSentence("sentence-1", 10, 15, "The official sentence has a specific meaning.");
  const result = alignSentencePlaybackRanges([sentence], whisper([entry(10, 15, "entirely unrelated audio words here")]));
  assert.equal(result.alignedCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.sentences[0].playbackStart, undefined);
  assert.equal(result.sentences[0].playbackEnd, undefined);
});

test("Whisper token pieces are recombined into one timed word", () => {
  const payload = {
    transcription: [{
      tokens: [
        token(" receiv", 1000, 1200),
        token("ing", 1200, 1400),
        token(" notice", 1400, 1800),
        token("[_TT_100]", 1800, 1800),
      ],
    }],
  };
  assert.deepEqual(extractWhisperTimedWords(payload), [
    { text: "receiving", normalized: "receiving", start: 1, end: 1.4 },
    { text: "notice", normalized: "notice", start: 1.4, end: 1.8 },
  ]);
});

function estimatedSentence(id, start, end, text, sourceBlockId = "block-12") {
  return { id, sourceBlockId, speaker: "Speaker A", start, end, text, timingQuality: "estimated" };
}

function whisper(entries) {
  return { transcription: entries };
}

function entry(start, end, text) {
  const words = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [];
  const duration = (end - start) / Math.max(1, words.length);
  return {
    tokens: words.map((word, index) => token(
      ` ${word}`,
      Math.round((start + duration * index) * 1000),
      Math.round((start + duration * (index + 1)) * 1000),
    )),
  };
}

function token(text, from, to) {
  return { text, offsets: { from, to } };
}

function rangeContains(container, candidate) {
  return container.playbackStart <= candidate.playbackStart
    && container.playbackEnd >= candidate.playbackEnd;
}
