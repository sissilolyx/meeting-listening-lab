import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addDeterministicSpokenFormNotes, analyzeMaterial, buildLearningQuestionPrompt, needsSpokenFormAnalysis } from "../lib/analysis.mjs";

test("follow-up questions treat incoherent ASR as a reconstruction task rather than grammar polishing", () => {
  const prompt = buildLearningQuestionPrompt({
    context: { current: "the painted calendar folder delayed the route" },
    selectedText: "calendar",
    questionZh: "这里实际说的是什么？",
  });
  assert.match(prompt, /fallible ASR, not ground truth/);
  assert.match(prompt, /speaker most likely actually said/);
  assert.match(prompt, /do not merely polish the broken ASR text/);
  assert.match(prompt, /use likelySpokenEnglish as the learning target/);
  assert.match(prompt, /grammarPointZh/);
  assert.match(prompt, /Never describe an ASR error as the speaker's grammar mistake/);
});

test("new and legacy sentences require spoken-form analysis", () => {
  assert.equal(needsSpokenFormAnalysis({ id: "sentence-1" }), true);
  assert.equal(needsSpokenFormAnalysis({
    id: "sentence-2",
    analysis: { translationZh: "旧讲解" },
  }), true);
});

test("an empty spoken-form list marks a sentence as up to date", () => {
  assert.equal(needsSpokenFormAnalysis({
    id: "sentence-3",
    analysis: { spokenFormNotes: [] },
  }), false);
});

test("an obvious repeated word is preserved as a separate disfluency note", () => {
  const notes = addDeterministicSpokenFormNotes("the frame frame each bracket need labels", [{
    sourceText: "each bracket need labels",
    kind: "grammar",
    explanationZh: "单数主语需要第三人称单数动词。",
    correctedEnglish: "Each bracket needs labels.",
  }]);

  assert.deepEqual(notes[0], {
    sourceText: "frame frame",
    kind: "disfluency",
    explanationZh: "“frame”是说话时的重复或重启，本身不增加新的含义。",
    correctedEnglish: "",
  });
  assert.equal(notes[1].kind, "grammar");
});

test("a repeated word without another grammar issue gets a cleaned full sentence", () => {
  const notes = addDeterministicSpokenFormNotes("We we chose this layout.");
  assert.equal(notes[0].correctedEnglish, "We chose this layout.");
});

test("analysis publishes a material snapshot after every completed batch", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "listening-analysis-"));
  const previousBatchSize = process.env.CODEX_ANALYSIS_BATCH_SIZE;
  process.env.CODEX_ANALYSIS_BATCH_SIZE = "1";
  const sentences = [
    { id: "sentence-1", speaker: "Speaker A", start: 0, text: "First sentence." },
    { id: "sentence-2", speaker: "Speaker B", start: 2, text: "Second sentence." },
  ];

  try {
    for (const [index, sentence] of sentences.entries()) {
      const batch = [sentence];
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ version: "provider-v1-spoken-form-v3", provider: "codex", model: "synthetic-model", kind: "full", batch }))
        .digest("hex")
        .slice(0, 12);
      const result = {
        overview: { summaryZh: `第${index + 1}批`, learningFocusZh: "精听" },
        segments: [{
          id: sentence.id,
          translationZh: `翻译${index + 1}`,
          explanationZh: "",
          phrases: [],
          questionZh: "",
          spokenFormNotes: [],
        }],
      };
      await fs.writeFile(
        path.join(directory, `ai-codex-full-${String(index + 1).padStart(3, "0")}-${fingerprint}.json`),
        JSON.stringify(result),
      );
    }

    const snapshots = [];
    const result = await analyzeMaterial({ title: "Test", sentences }, directory, {
      aiSettings: { provider: "codex", model: "synthetic-model" },
      onBatch: (snapshot) => snapshots.push(snapshot),
    });

    assert.deepEqual(snapshots.map((item) => item.completedBatches), [1, 2]);
    assert.equal(snapshots[0].sentences.filter((sentence) => sentence.analysis).length, 1);
    assert.equal(snapshots[1].sentences.filter((sentence) => sentence.analysis).length, 2);
    assert.equal(result.sentences.filter((sentence) => sentence.analysis).length, 2);
  } finally {
    if (previousBatchSize === undefined) delete process.env.CODEX_ANALYSIS_BATCH_SIZE;
    else process.env.CODEX_ANALYSIS_BATCH_SIZE = previousBatchSize;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
