import test from "node:test";
import assert from "node:assert/strict";
import {
  blocksToSentences,
  buildLarkSegments,
  buildSegmentsFromBlocks,
  buildParagraphs,
  attachStandaloneAcknowledgementContexts,
  countWords,
  extractMinuteToken,
  findSparseLarkBlocks,
  formatLarkTranscript,
  mergeDependentSentenceFragments,
  parseLarkTranscript,
  parseWhisperJson,
  shouldPreferRecoveredTranscript,
  stripTranscriptArtifacts,
} from "../lib/transcript.mjs";

test("extractMinuteToken accepts the validated Lark Minutes URL shape", () => {
  const fictionalUrl = ["https://fictional-tenant", "larkoffice", "com/minutes/example_minute_token_0001"].join(".");
  assert.equal(
    extractMinuteToken(fictionalUrl),
    "example_minute_token_0001",
  );
  assert.throws(() => extractMinuteToken("https://example.com/minutes/example_minute_token_0001"));
});

test("Lark transcript becomes natural sentences with continuous timestamps", () => {
  const input = [
    "Speaker A 00:00:00.000",
    "The paper moon hangs above the toy harbor. Three silver boats face north.",
    "",
    "Speaker B 00:00:08.000",
    "Should the smallest lighthouse blink before the bell rings?",
  ].join("\n");
  const blocks = parseLarkTranscript(input, 14);
  const sentences = blocksToSentences(blocks);
  assert.equal(blocks.length, 2);
  assert.equal(sentences.length, 3);
  assert.equal(sentences[0].speaker, "Speaker A");
  assert.equal(sentences[2].speaker, "Speaker B");
  assert.equal(sentences[0].start, 0);
  assert.equal(sentences.at(-1).end, 14);
});

test("an introductory dependent clause stays with the main clause as one natural sentence", () => {
  const sentences = blocksToSentences([{
    id: "synthetic-block-intro",
    speaker: "Speaker A",
    start: 12.25,
    end: 18.75,
    text: "Once the brass turtle reaches the velvet bridge. The miniature parade can begin.",
  }]);

  assert.equal(sentences.length, 1);
  assert.equal(
    sentences[0].text,
    "Once the brass turtle reaches the velvet bridge, the miniature parade can begin.",
  );
  assert.equal(sentences[0].start, 12.25);
  assert.equal(sentences[0].end, 18.75);
  assert.equal(sentences[0].wordCount, 13);
});

test("dependent-clause merging stays conservative around self-corrections and complete clauses", () => {
  assert.deepEqual(mergeDependentSentenceFragments([
    "Once the marionette, after circling the porcelain fountain from.",
    "Then if you mean the striped balloon beside the bronze ladder.",
  ]), [
    "Once the marionette, after circling the porcelain fountain from.",
    "Then if you mean the striped balloon beside the bronze ladder.",
  ]);

  assert.deepEqual(mergeDependentSentenceFragments([
    "When the music box stops, the paper swan will bow.",
    "The lantern keeper records each color separately.",
  ]), [
    "When the music box stops, the paper swan will bow.",
    "The lantern keeper records each color separately.",
  ]);

  assert.deepEqual(mergeDependentSentenceFragments([
    "Because the blue marble vanished.",
    "Splendid.",
  ]), ["Because the blue marble vanished.", "Splendid."]);

  assert.deepEqual(mergeDependentSentenceFragments([
    "If the puppets stack the shells differently than the diagram shows.",
    "I only want to note that, like if the wooden fox skips the red tile, for example.",
  ]), [
    "If the puppets stack the shells differently than the diagram shows.",
    "I only want to note that, like if the wooden fox skips the red tile, for example.",
  ]);

  assert.deepEqual(mergeDependentSentenceFragments([
    "Once was enough.",
    "The mechanical owl turned west.",
  ]), ["Once was enough.", "The mechanical owl turned west."]);
});

test("Lark material keeps the official transcript text instead of a truncated Whisper fragment", () => {
  const input = [
    "Speaker A 00:00:05.000",
    "A clockwork whale rests beside the teacup. Does its copper fin point toward the window? Count the painted gears before winding the key.",
    "",
    "Speaker B 00:00:15.250",
    "One glass bead is missing. I brought a spare.",
    "",
    "Speaker A 00:00:22.500",
    "Excellent. I will arrange the six velvet planets so the puppet audience can choose one.",
  ].join("\n");
  const result = buildLarkSegments(input, 32);
  assert.equal(result.sentences[2].text, "Count the painted gears before winding the key.");
  assert.equal(result.sentences[3].speaker, "Speaker B");
  assert.equal(result.paragraphs[1].text, "One glass bead is missing. I brought a spare.");
  assert.match(result.paragraphs[2].text, /arrange the six velvet planets/);
});

test("sparse English Lark blocks are eligible for local recovery without treating Chinese as empty", () => {
  const blocks = [
    { id: "english-gap", start: 10, end: 30, text: "A violet kite appears." },
    { id: "chinese", start: 30, end: 60, text: "我们先开始吧，然后一起过一下材料。" },
    { id: "normal", start: 60, end: 70, text: "This section already has enough transcript words to be credible." },
  ];
  assert.deepEqual(findSparseLarkBlocks(blocks).map((block) => block.id), ["english-gap"]);
});

test("local recovery is accepted only when it adds substantial transcript content", () => {
  const official = { text: "A violet kite appears." };
  assert.equal(shouldPreferRecoveredTranscript(official, [{ text: "A violet kite appears." }]), false);
  assert.equal(shouldPreferRecoveredTranscript(official, [{ text: "A violet kite appears. Beneath it, seven paper crabs carry a striped basket toward the fountain." }]), true);
});

test("repaired Lark blocks serialize and parse without losing their timestamps", () => {
  const blocks = [
    { id: "synthetic-one", speaker: "Speaker A", start: 73.125, end: 74, text: "A violet kite appears." },
    { id: "synthetic-two", speaker: "Speaker A", start: 76.875, end: 78, text: "Seven paper crabs wave below." },
  ];
  const serialized = formatLarkTranscript(blocks);
  const parsed = parseLarkTranscript(serialized, 78);
  const segments = buildSegmentsFromBlocks(parsed, 100);
  assert.equal(parsed[0].start, 73.125);
  assert.equal(segments.paragraphs[0].text, "A violet kite appears. Seven paper crabs wave below.");
});

test("recovered Lark speech remains one paragraph across a short connection pause", () => {
  const blocks = [
    { id: "synthetic-one", speaker: "Speaker A", start: 50.25, end: 51.1, text: "A violet kite appears." },
    { id: "synthetic-two", speaker: "Speaker A", start: 54.05, end: 55, text: "Seven paper crabs wave below." },
    { id: "synthetic-three", speaker: "Speaker A", start: 57.4, end: 62.4, text: "A clockwork pelican delivers a striped basket to the fountain." },
  ];
  assert.equal(buildSegmentsFromBlocks(blocks, 100).paragraphs.length, 2);
  assert.equal(buildSegmentsFromBlocks(blocks, 100, 4).paragraphs.length, 1);
});

test("paragraphs group consecutive sentences but respect speaker, pause, and 100-word boundaries", () => {
  const sentences = [
    { id: "sentence-1", sourceBlockId: "a", speaker: "Speaker A", start: 0, end: 3, text: "One two three.", wordCount: 3 },
    { id: "sentence-2", sourceBlockId: "b", speaker: "Speaker A", start: 3.4, end: 6, text: "Still the same turn.", wordCount: 4 },
    { id: "sentence-3", sourceBlockId: "c", speaker: "Speaker A", start: 10, end: 13, text: "A new paragraph after a pause.", wordCount: 6 },
    { id: "sentence-4", sourceBlockId: "d", speaker: "Speaker A", start: 13, end: 16, text: `${"word ".repeat(96).trim()}.`, wordCount: 96 },
    { id: "sentence-5", sourceBlockId: "e", speaker: "Speaker B", start: 16, end: 19, text: "A new speaker.", wordCount: 3 },
  ];
  const paragraphs = buildParagraphs(sentences, 100);
  assert.equal(paragraphs.length, 4);
  assert.deepEqual(paragraphs[0].sentenceIds, ["sentence-1", "sentence-2"]);
  assert.deepEqual(paragraphs[0].sourceBlockIds, ["a", "b"]);
  assert.ok(paragraphs.every((item) => item.wordCount <= 100));
  assert.equal(paragraphs[3].speaker, "Speaker B");
});

test("a standalone Okay becomes trailing context instead of its own practice segment", () => {
  const paragraphs = buildParagraphs([
    { id: "sentence-1", sourceBlockId: "a-1", speaker: "Speaker A", start: 0, end: 4, text: "The poster goes on the center board.", wordCount: 7 },
    { id: "sentence-2", sourceBlockId: "b-1", speaker: "Speaker B", start: 4.8, end: 5.4, text: "Okay.", wordCount: 1 },
    { id: "sentence-3", sourceBlockId: "a-2", speaker: "Speaker A", start: 5.4, end: 9, text: "Then the team adds the blue labels.", wordCount: 7 },
  ]);

  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0].id, "paragraph-1");
  assert.equal(paragraphs[1].id, "paragraph-3");
  assert.deepEqual(paragraphs[0].sentenceIds, ["sentence-1"]);
  assert.deepEqual(paragraphs[0].trailingContextSentenceIds, ["sentence-2"]);
  assert.deepEqual(paragraphs[0].mergedFromParagraphIds, ["paragraph-1", "paragraph-2"]);
  assert.equal(paragraphs[0].end, 4);
  assert.equal(paragraphs[0].playbackEnd, 5.4);
  assert.equal(paragraphs[0].speaker, "Speaker A");
  assert.equal(paragraphs[0].text, "The poster goes on the center board.");
});

test("acknowledgement folding stays strict around meaningful or uncertain short turns", () => {
  const makeParagraphs = (text, { duration = 0.6, followingSpeaker = "Speaker A" } = {}) => [
    { id: "paragraph-1", speaker: "Speaker A", start: 0, end: 4, text: "First answer.", wordCount: 2, sentenceIds: ["sentence-1"] },
    { id: "paragraph-2", speaker: "Speaker B", start: 4.2, end: 4.2 + duration, text, wordCount: countWords(text), sentenceIds: ["sentence-2"] },
    { id: "paragraph-3", speaker: followingSpeaker, start: 4.2 + duration, end: 8, text: "Next answer.", wordCount: 2, sentenceIds: ["sentence-3"] },
  ];

  for (const [text, options] of [
    ["Okay?", {}],
    ["Okay, but we need approval.", {}],
    ["Yes.", {}],
    ["Okay.", { duration: 3 }],
    ["Okay.", { followingSpeaker: "Speaker B" }],
  ]) {
    assert.equal(
      attachStandaloneAcknowledgementContexts(makeParagraphs(text, options)).length,
      3,
      `${text} should remain a substantive practice turn`,
    );
  }
});

test("parseWhisperJson accepts whisper.cpp full JSON timestamps", () => {
  const blocks = parseWhisperJson({
    transcription: [
      {
        offsets: { from: 1000, to: 4500 },
        timestamps: { from: "00:00:01,000", to: "00:00:04,500" },
        text: " This is a test.",
        tokens: [
          { text: " This", offsets: { from: 1000, to: 1800 } },
          { text: " is", offsets: { from: 1800, to: 2300 } },
          { text: " a", offsets: { from: 2300, to: 2800 } },
          { text: " test", offsets: { from: 2800, to: 4300 } },
          { text: ".", offsets: { from: 4300, to: 4500 } },
        ],
      },
    ],
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].start, 1);
  assert.equal(blocks[0].end, 4.5);
  assert.equal(countWords(blocks[0].text), 4);
});

test("Whisper timestamp artifacts are removed from inline and standalone text", () => {
  assert.equal(stripTranscriptArtifacts("The poster includes,[_TT_205] three colors."), "The poster includes, three colors.");
  assert.equal(stripTranscriptArtifacts("_TT_1307]"), "");
  assert.equal(stripTranscriptArtifacts("[ _TT_ 309 ]"), "");
  assert.equal(stripTranscriptArtifacts("[_BEG_] We can start."), "We can start.");
  assert.equal(stripTranscriptArtifacts("[speaking Chinese] We can start."), "[speaking Chinese] We can start.");
});

test("sentence building drops timestamp-only blocks and cleans inline artifacts", () => {
  const sentences = blocksToSentences([
    { id: "synthetic-control-only", speaker: "Speaker A", start: 0, end: 1, text: "_TT_901]" },
    { id: "synthetic-spoken", speaker: "Speaker A", start: 1, end: 3, text: "Place the label[_TT_309] beside the frame." },
  ]);

  assert.equal(sentences.length, 1);
  assert.equal(sentences[0].text, "Place the label beside the frame.");
  assert.equal(sentences[0].id, "sentence-1");
});

test("Whisper fallback entries do not keep timestamp artifacts", () => {
  const blocks = parseWhisperJson({
    transcription: [
      { text: "_TT_901]", offsets: { from: 0, to: 1000 } },
      { text: "We can start[_TT_205] now.", offsets: { from: 1000, to: 3000 } },
    ],
  });

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "We can start now.");
});
