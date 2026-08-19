import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ANALYSIS_SCHEMA_PATH,
  PHRASE_GUIDE_SCHEMA_PATH,
  QA_SCHEMA_PATH,
  SPOKEN_FORM_SCHEMA_PATH,
} from "./config.mjs";
import { runStructured } from "./ai-providers.mjs";
import { buildLearnerDifficultyPromptProfile } from "./learner-profile.mjs";

const DEFAULT_BATCH_SIZE = 60;
const ANALYSIS_VERSION = "provider-v1-spoken-form-v3";

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
  const aiSettings = requireAiSelection(options.aiSettings);

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
  const difficultyProfile = buildLearnerDifficultyPromptProfile(options.learnerProfile);
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
    const adaptiveFingerprint = kind === "full" && difficultyProfile.length
      ? { difficultyProfile }
      : {};
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ version: ANALYSIS_VERSION, provider: aiSettings.provider, model: aiSettings.model, kind, batch, ...adaptiveFingerprint }))
      .digest("hex")
      .slice(0, 12);
    const outputPath = path.join(directory, `ai-${aiSettings.provider}-${kind}-${String(index + 1).padStart(3, "0")}-${fingerprint}.json`);
    const providerLabel = aiSettings.provider === "cursor" ? "Cursor" : "Codex";
    await options.onStage?.(
      kind === "full"
        ? `${providerLabel} 正在生成翻译和职场表达讲解（${index + 1}/${batches.length}）`
        : `${providerLabel} 正在补充口语结构和正确表达（${index + 1}/${batches.length}）`,
      0.82 + 0.16 * (index / Math.max(1, batches.length)),
    );
    let result = await loadCachedBatch(outputPath, batch, kind, aiSettings);
    if (!result) {
      result = kind === "full"
        ? await runAnalysisBatch({
          title: material.title,
          batch,
          batchIndex: index,
          batchCount: batches.length,
          aiSettings,
          difficultyProfile,
          timeoutMs: options.timeoutMs,
          onOutput: options.onOutput,
        })
        : await runSpokenFormBatch({
          title: material.title,
          batch,
          batchIndex: index,
          batchCount: batches.length,
          aiSettings,
          timeoutMs: options.timeoutMs,
          onOutput: options.onOutput,
        });
      validateBatch(result, batch, kind);
      await fs.writeFile(outputPath, `${JSON.stringify({ aiProvider: aiSettings, result }, null, 2)}\n`, "utf8");
    }
    validateBatch(result, batch, kind);
    if (kind === "full") overviews.push(result.overview);
    for (const item of result.segments) {
      const spokenFormNotes = addDeterministicSpokenFormNotes(sentenceById.get(item.id)?.text, item.spokenFormNotes);
      analysisById.set(item.id, kind === "full"
        ? { ...item, spokenFormNotes }
        : { ...analysisById.get(item.id), spokenFormNotes });
    }
    await options.onBatch?.({
      analysisProvider: aiSettings,
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
    analysisProvider: aiSettings,
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

export async function answerLearningQuestion(material, _directory, input, options = {}) {
  const sentenceIndex = material.sentences.findIndex((item) => item.id === input.sentenceId);
  if (sentenceIndex < 0) throw new Error("没有找到问题对应的自然句");
  const sentence = material.sentences[sentenceIndex];
  const context = {
    previous: material.sentences[sentenceIndex - 1]?.text || "",
    current: sentence.text,
    next: material.sentences[sentenceIndex + 1]?.text || "",
  };
  const prompt = buildLearningQuestionPrompt({
    title: material.title,
    speaker: sentence.speaker,
    context,
    selectedText: input.selectedText,
    questionZh: input.question,
    existingAnalysis: sentence.analysis || null,
  });

  const aiSettings = requireAiSelection(options.aiSettings);
  const result = await runStructured({
    ...aiSettings,
    prompt,
    schemaPath: QA_SCHEMA_PATH,
    timeoutMs: options.timeoutMs || 10 * 60 * 1000,
    onOutput: options.onOutput,
  });
  if (!result.answerZh || !result.learningSummaryZh || typeof result.grammarPointZh !== "string") throw new Error("AI 没有返回完整讲解，请重试");
  if (result.transcriptStatus === "likely_mistranscribed" && !result.likelySpokenEnglish?.trim()) {
    throw new Error("AI 判断逐字稿有误，但没有给出可用的原话还原，请重试");
  }
  return { ...result, aiProvider: aiSettings, sentenceId: sentence.id, selectedText: input.selectedText, question: input.question };
}

export function buildPhraseGuidePrompt(input = {}) {
  const payload = {
    speaker: String(input.speaker || ""),
    currentSentence: String(input.currentSentence || ""),
    phraseText: String(input.phraseText || ""),
    meaningZh: String(input.meaningZh || ""),
    usageZh: String(input.usageZh || ""),
  };
  return [
    "You are expanding one reusable English phrase for a workplace English learner.",
    "Return JSON matching the supplied schema, with plain text in every string and no Markdown markers.",
    "Use only the supplied current sentence to explain how the phrase works here.",
    "usageZh: give a concise contextual usage explanation in Chinese.",
    "patternZh: give one reusable English pattern with a concise Chinese explanation.",
    "alternatives: return zero to three natural alternatives and explain the practical nuance difference in Chinese.",
    "examples: return three or four concise examples with Chinese meanings.",
    "Every example must be a generic, synthetic workplace scenario. Do not reuse names, organizations, products, figures, policies, regions, or other meeting-specific facts from the source sentence.",
    "Do not infer or mention any information outside the supplied fields.",
    "Input:",
    JSON.stringify(payload),
  ].join("\n");
}

export async function answerPhraseGuide(material, _directory, input, options = {}) {
  const sentence = material.sentences.find((item) => item.id === input.sentenceId);
  if (!sentence) throw new Error("没有找到表达对应的自然句");
  const prompt = buildPhraseGuidePrompt({
    speaker: sentence.speaker,
    currentSentence: sentence.text,
    phraseText: input.phraseText,
    meaningZh: input.meaningZh,
    usageZh: input.usageZh,
  });

  const aiSettings = requireAiSelection(options.aiSettings);
  const result = await runStructured({
    ...aiSettings,
    prompt,
    schemaPath: PHRASE_GUIDE_SCHEMA_PATH,
    timeoutMs: options.timeoutMs || 10 * 60 * 1000,
    onOutput: options.onOutput,
  });
  validatePhraseGuideResult(result);
  return { ...result, aiProvider: aiSettings };
}

function validatePhraseGuideResult(result) {
  if (!result || typeof result.usageZh !== "string" || !result.usageZh.trim()
    || typeof result.patternZh !== "string" || !result.patternZh.trim()
    || !Array.isArray(result.alternatives) || result.alternatives.length > 3
    || !Array.isArray(result.examples) || result.examples.length < 3 || result.examples.length > 4) {
    throw new Error("AI 没有返回完整的表达讲解，请重试");
  }
  if (result.alternatives.some((item) => (
    !item || typeof item.text !== "string" || !item.text.trim()
    || typeof item.differenceZh !== "string" || !item.differenceZh.trim()
  ))) throw new Error("AI 返回的替代表达不完整，请重试");
  if (result.examples.some((item) => (
    !item || typeof item.english !== "string" || !item.english.trim()
    || typeof item.meaningZh !== "string" || !item.meaningZh.trim()
  ))) throw new Error("AI 返回的表达例句不完整，请重试");
}

async function runAnalysisBatch({ title, batch, batchIndex, batchCount, aiSettings, difficultyProfile, timeoutMs, onOutput }) {
  const hasDifficultyFeedback = Array.isArray(difficultyProfile) && difficultyProfile.length > 0;
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
      ? "learnerDifficultyProfile contains expressions that the learner explicitly marked as too simple or repeatedly skipped without opening, asking about, or reviewing. Treat them as conservative negative difficulty examples: do not return exact matches, and avoid similarly elementary phrases unless their contextual use is genuinely non-obvious. Prefer fewer phrases over padding the list with easy material. Infer only a practical difficulty floor from the examples; do not assign or mention a CEFR level."
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

  return runStructured({
    ...aiSettings,
    prompt,
    schemaPath: ANALYSIS_SCHEMA_PATH,
    timeoutMs: timeoutMs || 45 * 60 * 1000,
    onOutput,
  });
}

async function runSpokenFormBatch({ title, batch, batchIndex, batchCount, aiSettings, timeoutMs, onOutput }) {
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

  return runStructured({
    ...aiSettings,
    prompt,
    schemaPath: SPOKEN_FORM_SCHEMA_PATH,
    timeoutMs: timeoutMs || 45 * 60 * 1000,
    onOutput,
  });
}

async function loadCachedBatch(outputPath, batch, kind, aiSettings) {
  try {
    const cached = JSON.parse(await fs.readFile(outputPath, "utf8"));
    const hasMetadata = cached?.aiProvider && cached?.result;
    if (hasMetadata && (
      cached.aiProvider.provider !== aiSettings.provider
      || cached.aiProvider.model !== aiSettings.model
    )) return null;
    const result = hasMetadata ? cached.result : cached;
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
    throw new Error("AI 返回的句子数量不完整，请重试解析");
  }
  for (const id of received) {
    if (!expected.has(id)) throw new Error(`AI 返回了未知句子：${id}`);
  }
  if (kind === "full" && !result.overview) throw new Error("AI 没有返回材料概览，请重试解析");
  for (const segment of result.segments) {
    if (!Array.isArray(segment.spokenFormNotes)) throw new Error(`AI 没有返回口语结构说明：${segment.id}`);
    for (const note of segment.spokenFormNotes) {
      if (!["disfluency", "grammar", "mistranscription"].includes(note.kind) || !note.sourceText || !note.explanationZh || !note.correctedEnglish) {
        throw new Error(`AI 返回的口语结构说明不完整：${segment.id}`);
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

function requireAiSelection(value) {
  if (!value || !["codex", "cursor"].includes(value.provider) || typeof value.model !== "string") {
    const error = new Error("这项任务没有绑定 AI provider，请重新开始");
    error.statusCode = 409;
    throw error;
  }
  return Object.freeze({ provider: value.provider, model: value.model });
}
