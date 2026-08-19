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

test("a stable strict extended fallback recovers a sentence that begins after the six-second window", () => {
  const sentences = [
    estimatedSentence(
      "synthetic-extended-intro",
      100,
      104,
      "The bronze compass remains beside the folded canvas.",
      "synthetic-extended-block",
    ),
    estimatedSentence(
      "synthetic-extended-target",
      104,
      109.5,
      "After the lantern changes color carry the narrow parcel across the courtyard before closing the gate.",
      "synthetic-extended-block",
    ),
  ];
  const whisperPayload = whisper([
    entry(100.2, 103.7, "The bronze compass remains beside the folded canvas"),
    entry(116.2, 119.4, "After the lantern changes color carry the narrow parcel across the courtyard before closing the gate"),
  ]);

  const result = alignSentencePlaybackRanges(sentences, whisperPayload);
  const target = result.sentences[1];
  assert.equal(result.alignedCount, 2);
  assert.equal(target.playbackTimingQuality, "whisper-aligned");
  assert(target.playbackStart <= 116.2);
  assert(target.playbackStart > 115.9);
  assert(target.playbackEnd >= 119.4);
  assert(target.playbackAlignmentCoverage >= 0.85);
});

test("a strict extended candidate is rejected when it crosses an existing reliable range", () => {
  const target = estimatedSentence(
    "synthetic-extended-collision",
    200,
    209,
    "Place the copper lantern beside the marble arch before carrying the silver folder into storage.",
    "synthetic-collision-target-block",
  );
  const reliable = {
    id: "synthetic-existing-source-range",
    sourceBlockId: "synthetic-existing-source-block",
    speaker: "Speaker B",
    start: 216,
    end: 219,
    text: "A separate source-timed utterance occupies this interval.",
    timingQuality: "estimated",
    playbackStart: 216,
    playbackEnd: 219,
    playbackTimingQuality: "manual",
  };
  const whisperPayload = whisper([
    entry(216.1, 218.6, "Place the copper lantern beside the marble arch before carrying the silver folder into storage"),
  ]);

  const result = alignSentencePlaybackRanges([target, reliable], whisperPayload);
  assert.equal(result.sentences[0].playbackStart, undefined);
  assert.equal(result.sentences[0].playbackEnd, undefined);
  assert.equal(result.sentences[1].start, reliable.start);
  assert.equal(result.sentences[1].end, reliable.end);
});

test("a padding-only overlap is trimmed without discarding a stable extended candidate", () => {
  const reliable = {
    ...estimatedSentence(
      "synthetic-padding-anchor",
      290,
      295,
      "The earlier calibrated sentence finishes first.",
      "synthetic-padding-anchor-block",
    ),
    playbackStart: 310,
    playbackEnd: 315.1,
    playbackTimingQuality: "manual",
  };
  const target = estimatedSentence(
    "synthetic-padding-target",
    300,
    309,
    "Carry the violet notebook through the quiet gallery and leave it underneath the brass clock.",
    "synthetic-padding-target-block",
  );
  const whisperPayload = whisper([
    entry(315, 318.5, "Carry the violet notebook through the quiet gallery and leave it underneath the brass clock"),
  ]);

  const result = alignSentencePlaybackRanges([reliable, target], whisperPayload);
  const recovered = result.sentences[1];
  assert.equal(recovered.playbackTimingQuality, "whisper-aligned");
  assert(recovered.playbackStart >= 314.979);
  assert(reliable.playbackEnd - recovered.playbackStart <= 0.121);
  assert(recovered.playbackStart <= 315);
  assert(recovered.playbackEnd >= 318.5);
});

test("strict extended candidates in different source blocks cannot claim the same Whisper span", () => {
  const sharedText = "Move the amber telescope below the painted bridge before sunrise begins.";
  const sentences = [
    estimatedSentence("synthetic-shared-a", 400, 409, sharedText, "synthetic-shared-block-a"),
    estimatedSentence("synthetic-shared-b", 408, 409, sharedText, "synthetic-shared-block-b"),
  ];
  const whisperPayload = whisper([entry(415.2, 418.7, sharedText)]);

  const result = alignSentencePlaybackRanges(sentences, whisperPayload);
  assert.equal(result.sentences[0].playbackStart, undefined);
  assert.equal(result.sentences[1].playbackStart, undefined);
  assert.equal(result.alignedCount, 0);
  assert.equal(result.skippedCount, 2);
});

test("a phantom sentence remains unplayable even when reliable neighbours surround it", () => {
  const sentences = [
    estimatedSentence(
      "synthetic-phantom-left",
      500,
      504,
      "First place the green ribbon beside the window.",
      "synthetic-phantom-block",
    ),
    estimatedSentence(
      "synthetic-phantom-target",
      504,
      508,
      "The imaginary submarine files a report beneath the staircase.",
      "synthetic-phantom-block",
    ),
    estimatedSentence(
      "synthetic-phantom-right",
      508,
      512,
      "Then carry the blue folder into the archive.",
      "synthetic-phantom-block",
    ),
  ];
  const whisperPayload = whisper([
    entry(500.2, 503.7, "First place the green ribbon beside the window"),
    entry(508.2, 511.4, "Then carry the blue folder into the archive"),
  ]);

  const result = alignSentencePlaybackRanges(sentences, whisperPayload);
  assert.equal(result.sentences[0].playbackTimingQuality, "whisper-aligned");
  assert.equal(result.sentences[1].playbackStart, undefined);
  assert.equal(result.sentences[1].playbackEnd, undefined);
  assert.equal(result.sentences[2].playbackTimingQuality, "whisper-aligned");
});

test("a mismatched final proper noun is recovered without borrowing the following sentence", () => {
  const sentences = [
    estimatedSentence(
      "synthetic-marigold-request",
      300,
      306,
      "Please leave the copper compass beside Marigold.",
      "synthetic-request-block",
    ),
    estimatedSentence(
      "synthetic-following-request",
      306,
      311,
      "Next fold the green banner under the paper bridge.",
      "synthetic-request-block",
    ),
  ];
  const whisperPayload = whisper([
    entry(300.2, 304.8, "Please leave the copper compass beside Merrygold"),
    entry(305.4, 309.8, "Next fold the green banner under the paper bridge"),
  ]);

  const result = alignSentencePlaybackRanges(sentences, whisperPayload);
  const [target, following] = result.sentences;
  assert(target.playbackEnd >= 304.8);
  assert(target.playbackEnd < 305.4);
  assert(following.playbackStart >= 305.2);
  assert.equal(rangeContains(target, following), false);
});

test("an unanchored boundary mismatch cannot absorb a following ten-word utterance", () => {
  const officialWords = Array.from({ length: 40 }, (_, index) => `target${index + 1}`);
  const tokens = [];
  for (let index = 0; index < 30; index += 1) {
    tokens.push(token(
      ` ${officialWords[index]}`,
      400_000 + index * 100,
      400_100 + index * 100,
    ));
  }
  for (let index = 0; index < 10; index += 1) {
    tokens.push(token(
      ` neighbour${index + 1}`,
      403_100 + index * 200,
      403_200 + index * 200,
    ));
  }
  const sentence = estimatedSentence(
    "synthetic-unanchored-boundary",
    400,
    410,
    `${officialWords.join(" ")}.`,
    "synthetic-unanchored-block",
  );

  const result = alignSentencePlaybackRanges([sentence], { transcription: [{ tokens }] });
  const target = result.sentences[0];
  assert.equal(target.playbackAlignmentCoverage, 0.75);
  // With no reliably aligned following sentence, recovery may retain a tiny
  // two-word safety overlap but must not consume the rest of the utterance.
  assert(target.playbackEnd <= 403.601);
  assert(target.playbackEnd < 404.3);
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

test("scattered common words cannot impersonate a compact short sentence", () => {
  const sentence = estimatedSentence(
    "synthetic-amber-telescope",
    500,
    510,
    "Thus they chose the amber telescope.",
    "synthetic-compactness-block",
  );
  const whisperPayload = whisper([
    entry(
      500,
      509,
      "Thus perhaps the chart moves while they later chose another option and the amber marker remains",
    ),
  ]);

  const result = alignSentencePlaybackRanges([sentence], whisperPayload);
  assert.equal(result.alignedCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.sentences[0].playbackStart, undefined);
  assert.equal(result.sentences[0].playbackEnd, undefined);
});

test("force clears a stale Whisper range after a miss but preserves a manual range", () => {
  const stale = {
    ...estimatedSentence("synthetic-stale-range", 600, 606, "The copper kite crosses the silent garden.", "block-stale"),
    playbackStart: 640,
    playbackEnd: 645,
    playbackTimingQuality: "whisper-aligned",
    playbackAlignmentCoverage: 1,
  };
  const manual = {
    ...estimatedSentence("synthetic-manual-range", 610, 616, "The violet bell rests beside the window.", "block-manual"),
    playbackStart: 610.4,
    playbackEnd: 615.6,
    playbackTimingQuality: "manual",
  };
  const whisperPayload = whisper([
    entry(599, 617, "Entirely unrelated synthetic audio occupies this interval without either target utterance"),
  ]);

  const result = alignSentencePlaybackRanges([stale, manual], whisperPayload, { force: true });
  assert.equal(result.alignedCount, 0);
  assert.equal(result.clearedCount, 1);
  assert.equal(result.sentences[0].playbackStart, undefined);
  assert.equal(result.sentences[0].playbackEnd, undefined);
  assert.equal(result.sentences[0].playbackTimingQuality, undefined);
  assert.equal(result.sentences[0].playbackAlignmentCoverage, undefined);
  assert.equal(result.sentences[1].playbackStart, manual.playbackStart);
  assert.equal(result.sentences[1].playbackEnd, manual.playbackEnd);
  assert.equal(result.sentences[1].playbackTimingQuality, "manual");
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
