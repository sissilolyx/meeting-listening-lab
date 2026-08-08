import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ANALYSIS_SCHEMA_PATH, QA_SCHEMA_PATH, SPOKEN_FORM_SCHEMA_PATH } from "./config.mjs";
import { runCommand } from "./commands.mjs";
import { buildLearnerDifficultyProfile } from "./learner-profile.mjs";

const DEFAULT_BATCH_SIZE = 60;
const ANALYSIS_VERSION = "spoken-form-v3";

export function needsSpokenFormAnalysis(sentence) {
  return !sentence.analysis || !Array.isArray(sentence.analysis.spokenFormNotes);
}

export function addDeterministicSpokenFormNotes(text, notes = []) {
  const result = [...notes];
  const repeatPattern = /\b([A-Za-z]+(?:['’][A-Za-z]+)?)\s+\1\b/giu;
  for (const match of String(text).matchAll(repeatPattern)) {
    const sourceText = match[0];
    const existingIndex = result.findIndex((note) => (
      note.kind === "disfluency" && normalizeNoteText(note.sourceText) === normalizeNoteText(sourceText)
    ));
    const hasGrammarCorrection = result.some((note) => note.kind === "grammar" && note.correctedEnglish);
    const correctedEnglish = hasGrammarCorrection
      ? ""
      : String(text).replace(sourceText, match[1]);
    const repeatNote = {
      sourceText,
      kind: "disfluency",
      explanationZh: `“${match[1]}”是说话时的重复或重启，本身不增加新的含义。`,
      correctedEnglish,
    };
    if (existingIndex >= 0) result.splice(existingIndex, 1);
    result.unshift(repeatNote);
  }
  return result;
}

export async function analyzeMaterial(material, directory, options = {}) {
  if (process.env.SKIP_CODEX_ANALYSIS === "1") {
    return { overview: null, sentences: material.sentences, skipped: true };
  }

  const preparedSentences = material.sentences.map((sentence) => {
    if (!Array.isArray(sentence.analysis?.spokenFormNotes)) return sentence;
    return {
      ...sentence,
      analysis: {
        ...sentence.analysis,
        spokenFormNotes: addDeterministicSpokenFormNotes(sentence.text, sentence.analysis.spokenFormNotes),
      },
    };
  });
  const pendingSentences = preparedSentences.filter(needsSpokenFormAnalysis);
  if (!pendingSentences.length) {
    return { overview: material.overview || null, sentences: preparedSentences, skipped: false };
  }

  const batchSize = Math.max(1, Number(process.env.CODEX_ANALYSIS_BATCH_SIZE || DEFAULT_BATCH_SIZE));
  const difficultyProfile = buildLearnerDifficultyProfile(options.learnerProfile);
  const fullBatches = chunk(pendingSentences.filter((sentence) => !sentence.analysis).map(compactSentence), batchSize)
    .map((batch) => ({ kind: "full", batch }));
  const spokenFormBatches = chunk(pendingSentences.filter((sentence) => sentence.analysis).map(compactSentence), batchSize)
    .map((batch) => ({ kind: "spoken-form", batch }));
  const batches = [...fullBatches, ...spokenFormBatches];
  const analysisById = new Map(
    preparedSentences.filter((sentence) => sentence.analysis).map((sentence) => [sentence.id, sentence.analysis]),
  );
  const sentenceById = new Map(preparedSentences.map((sentence) => [sentence.id, sentence]));
  const overviews = [];

  for (const [index, work] of batches.entries()) {
    const { batch, kind } = work;
    const adaptiveFingerprint = kind === "full" && difficultyProfile.explicitTooSimpleCount
      ? { difficultyProfile }
      : {};
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ version: ANALYSIS_VERSION, kind, batch, ...adaptiveFingerprint }))
      .digest("hex")
      .slice(0, 12);
    const outputPath = path.join(directory, `codex-${kind}-${String(index + 1).padStart(3, "0")}-${fingerprint}.json`);
    await options.onStage?.(
      kind === "full"
        ? `Codex 正在生成翻译和职场表达讲解（${index + 1}/${batches.length}）`
        : `Codex 正在补充口语结构和正确表达（${index + 1}/${batches.length}）`,
      0.82 + 0.16 * (index / Math.max(1, batches.length)),
    );
    const result = await loadCachedBatch(outputPath, batch, kind) || await (
      kind === "full"
        ? runAnalysisBatch({
          title: material.title,
          batch,
          batchIndex: index,
          batchCount: batches.length,
          directory,
          outputPath,
          difficultyProfile,
          timeoutMs: options.timeoutMs,
          onOutput: options.onOutput,
        })
        : runSpokenFormBatch({
          title: material.title,
          batch,
          batchIndex: index,
          batchCount: batches.length,
          directory,
          outputPath,
          timeoutMs: options.timeoutMs,
          onOutput: options.onOutput,
        })
    );
    validateBatch(result, batch, kind);
    if (kind === "full") overviews.push(result.overview);
    for (const item of result.segments) {
      const spokenFormNotes = addDeterministicSpokenFormNotes(sentenceById.get(item.id)?.text, item.spokenFormNotes);
      analysisById.set(item.id, kind === "full"
        ? { ...item, spokenFormNotes }
        : { ...analysisById.get(item.id), spokenFormNotes });
    }
    await options.onBatch?.({
      overview: fullBatches.length ? combineOverviews(material.overview, overviews) : material.overview || null,
      sentences: preparedSentences.map((sentence) => ({
        ...sentence,
        analysis: analysisById.get(sentence.id) || null,
      })),
      completedBatches: index + 1,
      totalBatches: batches.length,
    });
  }

  const sentences = preparedSentences.map((sentence) => ({
    ...sentence,
    analysis: analysisById.get(sentence.id) || null,
  }));
  return {
    overview: fullBatches.length ? combineOverviews(material.overview, overviews) : material.overview || null,
    sentences,
    skipped: false,
  };
}

function compactSentence({ id, speaker, start, text }) {
  return { id, speaker, start, text };
}

function normalizeNoteText(value) {
  return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}

export function buildLearningQuestionPrompt(input) {
  return [
    "You are an English coach answering a learner's follow-up question about one exact sentence from a real workplace meeting.",
    "Return JSON matching the supplied schema. Return plain text inside every string, without Markdown markers.",
    "The supplied transcript is fallible ASR, not ground truth. First decide whether the selected wording is credible English in context.",
    "Use transcriptStatus=likely_mistranscribed only when the wording's syntax or meaning collapses and the surrounding context supports one specific reconstruction. Otherwise use credible.",
    "For likely_mistranscribed, likelySpokenEnglish must be the sentence the speaker most likely actually said. Reconstruct the intended spoken wording faithfully; do not merely polish the broken ASR text into formal grammar.",
    "For likely_mistranscribed, intendedMeaningZh must state what the speaker was actually communicating in natural Chinese. The answer must explain the ASR confusion, not teach the incorrect transcript as if it were valid English.",
    "For credible, return empty strings for likelySpokenEnglish and intendedMeaningZh.",
    "Answer in concise, natural Chinese. Tie the explanation to the selected expression and the exact sentence context.",
    "Clarify the contextual meaning, nuance, grammar or workplace usage that resolves the user's question. Add a short example only when useful.",
    "Do not invent meeting facts, speakers' intentions, or confidential background that is not present in the supplied context. When no specific reconstruction is defensible, keep transcriptStatus=credible and explain the uncertainty.",
    "learningSummaryZh must be a compact note suitable for later review and must stand on its own. If the transcript is likely wrong, use likelySpokenEnglish as the learning target and do not repeat the erroneous ASR wording except as an explicitly labeled contrast.",
    "grammarPointZh: if the credible or reconstructed sentence contains a genuinely useful grammar structure, explain that structure concisely in Chinese, including its reusable pattern and how it works here. If there is no useful grammar point, return an empty string. Never describe an ASR error as the speaker's grammar mistake; analyze the reconstructed sentence instead.",
    "Input:",
    JSON.stringify(input),
  ].join("\n");
}

export async function answerLearningQuestion(material, directory, input, options = {}) {
  const sentenceIndex = material.sentences.findIndex((item) => item.id === input.sentenceId);
  if (sentenceIndex < 0) throw new Error("没有找到问题对应的自然句");
  const sentence = material.sentences[sentenceIndex];
  const context = {
    previous: material.sentences[sentenceIndex - 1]?.text || "",
    current: sentence.text,
    next: material.sentences[sentenceIndex + 1]?.text || "",
  };
  const outputPath = path.join(directory, `codex-qa-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  const prompt = buildLearningQuestionPrompt({
    title: material.title,
    speaker: sentence.speaker,
    context,
    selectedText: input.selectedText,
    questionZh: input.question,
    existingAnalysis: sentence.analysis || null,
  });

  try {
    await runCommand("codex", [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--output-schema", QA_SCHEMA_PATH,
      "--output-last-message", outputPath,
      "-s", "read-only",
      "-C", directory,
      "-",
    ], {
      cwd: directory,
      input: prompt,
      timeoutMs: options.timeoutMs || 10 * 60 * 1000,
      onOutput: options.onOutput,
    });

    const result = JSON.parse(await fs.readFile(outputPath, "utf8"));
    if (!result.answerZh || !result.learningSummaryZh || typeof result.grammarPointZh !== "string") throw new Error("Codex 没有返回完整讲解，请重试");
    if (result.transcriptStatus === "likely_mistranscribed" && !result.likelySpokenEnglish?.trim()) {
      throw new Error("Codex 判断逐字稿有误，但没有给出可用的原话还原，请重试");
    }
    return { ...result, sentenceId: sentence.id, selectedText: input.selectedText, question: input.question };
  } finally {
    await fs.rm(outputPath, { force: true });
  }
}

async function runAnalysisBatch({ title, batch, batchIndex, batchCount, directory, outputPath, difficultyProfile, timeoutMs, onOutput }) {
  const hasDifficultyFeedback = difficultyProfile?.explicitTooSimpleCount > 0;
  const prompt = [
    "You are preparing intensive English-listening material from a real workplace meeting.",
    "Return JSON matching the supplied schema. Analyze every supplied sentence exactly once and preserve every id.",
    "The transcript comes from fallible ASR. Preserve it as the source record, but do not treat obvious recognition errors as the speaker's grammar.",
    "translationZh: natural Chinese meaning in context. If a literal translation is incoherent and the context supports a specific ASR reconstruction, translate the reconstructed intended meaning instead of translating nonsense.",
    "explanationZh: explain only the grammar, implied meaning, or workplace usage that is genuinely useful.",
    "spokenFormNotes: identify only genuinely useful non-standard spoken forms; otherwise return an empty array.",
    "For each spokenFormNote, sourceText must be an exact fragment from the transcript.",
    "Use kind=disfluency for fillers, repeated words, false starts, abandoned fragments, or self-corrections that add no independent meaning.",
    "Use kind=grammar for a genuine grammatical or incomplete construction, such as agreement, word form, or clause-structure errors. Do not label acceptable informal English as wrong.",
    "Use kind=mistranscription when the transcript wording is not plausible English and context supports a specific sentence the speaker most likely actually said. This is an ASR correction, not a grammar optimization.",
    "When one sentence contains both a disfluency and a grammar issue, return separate notes for the two categories instead of combining them.",
    "explanationZh must explicitly say what carries no additional meaning or what grammatical rule is broken. If transcription uncertainty is plausible, say so rather than claiming certainty.",
    "For mistranscription, correctedEnglish must be the sentence the speaker most likely actually said. For grammar or disfluency, correctedEnglish must give one clear, natural sentence that preserves the intended contextual meaning without inventing facts.",
    "Prefer a natural recast over mechanically retaining a broken sentence frame. Make pronoun antecedents explicit and check agreement, word forms, and participles in the corrected sentence itself.",
    "phrases: zero to three reusable expressions from the exact sentence. Do not invent phrases.",
    hasDifficultyFeedback
      ? "learnerDifficultyProfile contains expressions this learner explicitly marked as too simple. Treat them as negative difficulty examples: do not return exact matches, and avoid similarly elementary phrases unless their contextual use is genuinely non-obvious. Prefer fewer phrases over padding the list with easy material. Infer only a practical difficulty floor from the examples; do not assign or mention a CEFR level."
      : "Choose fewer phrases rather than padding the list with generic or obvious expressions.",
    "questionZh: always return an empty string. This product does not use comprehension-check questions.",
    "Never include confidential details beyond what is necessary to explain the sentence.",
    `This is batch ${batchIndex + 1} of ${batchCount}. The overview should summarize only this batch.`,
    "Input:",
    JSON.stringify({
      title,
      sentences: batch,
      ...(hasDifficultyFeedback ? { learnerDifficultyProfile: difficultyProfile } : {}),
    }),
  ].join("\n");

  await runCommand("codex", [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--output-schema", ANALYSIS_SCHEMA_PATH,
    "--output-last-message", outputPath,
    "-s", "read-only",
    "-C", directory,
    "-",
  ], {
    cwd: directory,
    input: prompt,
    timeoutMs: timeoutMs || 45 * 60 * 1000,
    onOutput,
  });

  return JSON.parse(await fs.readFile(outputPath, "utf8"));
}

async function runSpokenFormBatch({ title, batch, batchIndex, batchCount, directory, outputPath, timeoutMs, onOutput }) {
  const prompt = [
    "You are adding a spoken-English note to existing intensive listening material from a real workplace meeting.",
    "Return JSON matching the supplied schema. Analyze every supplied sentence exactly once and preserve every id.",
    "Preserve the transcript as the source record and do not return translations, phrase lists, comprehension questions, or general meeting summaries. Treat it as fallible ASR rather than unquestionable ground truth.",
    "spokenFormNotes: identify only genuinely useful non-standard spoken forms; otherwise return an empty array.",
    "For each note, sourceText must be an exact fragment from the transcript.",
    "Use kind=disfluency for fillers, repeated words, false starts, abandoned fragments, or self-corrections that add no independent meaning.",
    "Use kind=grammar for a genuine grammatical or incomplete construction, such as agreement, word form, or clause-structure errors. Do not label acceptable informal English as wrong.",
    "Use kind=mistranscription when the transcript wording is not plausible English and context supports a specific sentence the speaker most likely actually said. This is an ASR correction, not a grammar optimization.",
    "When one sentence contains both a disfluency and a grammar issue, return separate notes for the two categories instead of combining them.",
    "explanationZh must be concise and explicitly say what carries no additional meaning or what grammatical rule is broken. If transcription uncertainty is plausible, say so rather than claiming certainty.",
    "For mistranscription, correctedEnglish must be the sentence the speaker most likely actually said. For grammar or disfluency, correctedEnglish must give one clear, natural sentence that preserves the intended contextual meaning without inventing facts.",
    "Prefer a natural recast over mechanically retaining a broken sentence frame. Make pronoun antecedents explicit and check agreement, word forms, and participles in the corrected sentence itself.",
    `This is batch ${batchIndex + 1} of ${batchCount}.`,
    "Input:",
    JSON.stringify({ title, sentences: batch }),
  ].join("\n");

  await runCommand("codex", [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--output-schema", SPOKEN_FORM_SCHEMA_PATH,
    "--output-last-message", outputPath,
    "-s", "read-only",
    "-C", directory,
    "-",
  ], {
    cwd: directory,
    input: prompt,
    timeoutMs: timeoutMs || 45 * 60 * 1000,
    onOutput,
  });

  return JSON.parse(await fs.readFile(outputPath, "utf8"));
}

async function loadCachedBatch(outputPath, batch, kind) {
  try {
    const result = JSON.parse(await fs.readFile(outputPath, "utf8"));
    validateBatch(result, batch, kind);
    return result;
  } catch {
    return null;
  }
}

function validateBatch(result, batch, kind = "full") {
  const expected = new Set(batch.map((sentence) => sentence.id));
  const received = (result?.segments || []).map((segment) => segment.id);
  if (received.length !== expected.size || new Set(received).size !== expected.size) {
    throw new Error("Codex 返回的句子数量不完整，请重试解析");
  }
  for (const id of received) {
    if (!expected.has(id)) throw new Error(`Codex 返回了未知句子：${id}`);
  }
  if (kind === "full" && !result.overview) throw new Error("Codex 没有返回材料概览，请重试解析");
  for (const segment of result.segments) {
    if (!Array.isArray(segment.spokenFormNotes)) throw new Error(`Codex 没有返回口语结构说明：${segment.id}`);
    for (const note of segment.spokenFormNotes) {
      if (!["disfluency", "grammar"].includes(note.kind) || !note.sourceText || !note.explanationZh || !note.correctedEnglish) {
        throw new Error(`Codex 返回的口语结构说明不完整：${segment.id}`);
      }
    }
  }
}

function combineOverviews(existing, overviews) {
  const valid = overviews.filter(Boolean);
  if (!valid.length) return existing || null;
  return {
    summaryZh: valid.map((item) => item.summaryZh).filter(Boolean).join(" "),
    learningFocusZh: valid.map((item) => item.learningFocusZh).filter(Boolean).join("；"),
  };
}

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}
