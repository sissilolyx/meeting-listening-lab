import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LEARNER_PROFILE_PATH } from "./config.mjs";

const PROFILE_VERSION = 2;
const MAX_DIFFICULTY_EXAMPLES = 80;
const MIN_IMPLICIT_EASY_CONTEXTS = 3;
const MIN_IMPLICIT_EASY_SESSIONS = 2;
const COUNTER_EVIDENCE_FIELDS = Object.freeze({
  review_added: "reviewAddedAt",
  guide_opened: "guideOpenedAt",
  asked: "askedAt",
});
const profileMutationTails = new Map();

export const PHRASE_SIGNAL_EVENTS = Object.freeze([
  "exposed",
  ...Object.keys(COUNTER_EVIDENCE_FIELDS),
]);

export function createEmptyLearnerProfile() {
  return {
    version: PROFILE_VERSION,
    updatedAt: null,
    tooSimple: [],
    phraseSignals: [],
  };
}

export function normalizeKnowledgeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export async function readLearnerProfile(options = {}) {
  const filePath = options.filePath || LEARNER_PROFILE_PATH;
  try {
    const profile = JSON.parse(await fs.readFile(filePath, "utf8"));
    return normalizeLearnerProfile(profile);
  } catch (error) {
    if (error.code === "ENOENT") return createEmptyLearnerProfile();
    throw error;
  }
}

export async function saveTooSimpleKnowledge(input, options = {}) {
  const filePath = options.filePath || LEARNER_PROFILE_PATH;
  const normalizedText = normalizeKnowledgeText(input.text);
  if (!normalizedText) throw new Error("知识点不能为空");

  return mutateLearnerProfile(filePath, (profile) => {
    const now = currentTimestamp(options.now);
    const context = normalizeContext(input.context);
    const existing = profile.tooSimple.find((item) => item.normalizedText === normalizedText);

    if (existing) {
      existing.text = String(input.text).trim();
      existing.meaningZh = String(input.meaningZh || existing.meaningZh || "").trim();
      existing.usageZh = String(input.usageZh || existing.usageZh || "").trim();
      existing.lastMarkedAt = now;
      if (context && !existing.contexts.some((item) => sameContext(item, context))) existing.contexts.push(context);
    } else {
      profile.tooSimple.push({
        id: `simple-${randomUUID().slice(0, 12)}`,
        text: String(input.text).trim(),
        normalizedText,
        meaningZh: String(input.meaningZh || "").trim(),
        usageZh: String(input.usageZh || "").trim(),
        firstMarkedAt: now,
        lastMarkedAt: now,
        contexts: context ? [context] : [],
      });
    }

    profile.updatedAt = now;
    return profile;
  });
}

export async function removeTooSimpleKnowledge(feedbackId, options = {}) {
  const filePath = options.filePath || LEARNER_PROFILE_PATH;
  return mutateLearnerProfile(filePath, (profile) => {
    profile.tooSimple = profile.tooSimple.filter((item) => item.id !== feedbackId);
    profile.updatedAt = currentTimestamp(options.now);
    return profile;
  });
}

export async function recordPhraseSignal(input, options = {}) {
  const filePath = options.filePath || LEARNER_PROFILE_PATH;
  const event = String(input.event || "").trim();
  if (!PHRASE_SIGNAL_EVENTS.includes(event)) throw new Error("表达学习信号无效");
  const normalizedText = normalizeKnowledgeText(input.text);
  if (!normalizedText) throw new Error("表达不能为空");
  const context = normalizeSignalContext(input.context);
  if (!context) throw new Error("表达对应的句子无效");
  const sessionId = event === "exposed" ? normalizeSessionId(input.sessionId) : "";
  if (event === "exposed" && !sessionId) throw new Error("表达曝光缺少会话标识");

  return mutateLearnerProfile(filePath, (profile) => {
    const now = currentTimestamp(options.now);
    let signal = profile.phraseSignals.find((item) => item.normalizedText === normalizedText);
    if (!signal) {
      signal = {
        id: `phrase-signal-${randomUUID().slice(0, 12)}`,
        text: String(input.text).trim(),
        normalizedText,
        meaningZh: String(input.meaningZh || "").trim(),
        usageZh: String(input.usageZh || "").trim(),
        firstSeenAt: now,
        lastSeenAt: now,
        exposures: [],
        counterEvidence: createEmptyCounterEvidence(),
        implicitEasyAt: null,
        lastRevokedAt: null,
      };
      profile.phraseSignals.push(signal);
    }

    signal.text = String(input.text).trim();
    signal.meaningZh = String(input.meaningZh || signal.meaningZh || "").trim();
    signal.usageZh = String(input.usageZh || signal.usageZh || "").trim();
    signal.lastSeenAt = now;

    if (event === "exposed") {
      const existingExposure = signal.exposures.find((item) => (
        sameSignalContext(item, context) && item.sessionId === sessionId
      ));
      if (existingExposure) existingExposure.lastSeenAt = now;
      else {
        signal.exposures.push({
          ...context,
          sessionId,
          firstSeenAt: now,
          lastSeenAt: now,
        });
      }
    } else {
      const evidenceField = COUNTER_EVIDENCE_FIELDS[event];
      signal.counterEvidence[evidenceField] ||= now;
    }

    updateImplicitEasyState(signal, now);
    profile.updatedAt = now;
    return { profile, signal: summarizePhraseSignal(signal) };
  });
}

export function summarizePhraseSignal(signal) {
  const normalized = normalizePhraseSignal(signal);
  const contextCount = countDistinctContexts(normalized.exposures);
  const sessionCount = new Set(normalized.exposures.map((item) => item.sessionId).filter(Boolean)).size;
  return {
    ...normalized,
    contextCount,
    sessionCount,
    implicitEasy: isImplicitEasySignal(normalized),
    blocked: hasCounterEvidence(normalized),
  };
}

export function buildLearnerDifficultyProfile(profile) {
  const normalized = normalizeLearnerProfile(profile);
  const explicitExamples = [...normalized.tooSimple]
    .sort((a, b) => String(b.lastMarkedAt || "").localeCompare(String(a.lastMarkedAt || "")));
  const implicitExamples = normalized.phraseSignals
    .filter(isImplicitEasySignal)
    .sort((a, b) => String(b.implicitEasyAt || "").localeCompare(String(a.implicitEasyAt || "")));
  const examples = [];
  const seen = new Set();
  for (const item of [...explicitExamples, ...implicitExamples]) {
    if (seen.has(item.normalizedText)) continue;
    seen.add(item.normalizedText);
    examples.push({ text: item.text, meaningZh: item.meaningZh, usageZh: item.usageZh });
    if (examples.length >= MAX_DIFFICULTY_EXAMPLES) break;
  }
  return {
    explicitTooSimpleCount: normalized.tooSimple.length,
    implicitTooSimpleCount: implicitExamples.length,
    tooSimpleExamples: examples,
  };
}

// This is the only learner-profile shape allowed to leave the local data layer
// for Codex analysis. It deliberately excludes material/sentence identifiers,
// session identifiers, timestamps, hashes, and counters.
export function buildLearnerDifficultyPromptProfile(profile) {
  return buildLearnerDifficultyProfile(profile).tooSimpleExamples.map(({ text, meaningZh, usageZh }) => ({
    text,
    meaningZh,
    usageZh,
  }));
}

function normalizeLearnerProfile(profile) {
  const result = createEmptyLearnerProfile();
  result.updatedAt = typeof profile?.updatedAt === "string" ? profile.updatedAt : null;
  result.tooSimple = Array.isArray(profile?.tooSimple)
    ? profile.tooSimple.map((item) => ({
      id: String(item.id || `simple-${randomUUID().slice(0, 12)}`),
      text: String(item.text || "").trim(),
      normalizedText: normalizeKnowledgeText(item.normalizedText || item.text),
      meaningZh: String(item.meaningZh || "").trim(),
      usageZh: String(item.usageZh || "").trim(),
      firstMarkedAt: item.firstMarkedAt || item.lastMarkedAt || null,
      lastMarkedAt: item.lastMarkedAt || item.firstMarkedAt || null,
      contexts: Array.isArray(item.contexts) ? item.contexts.map(normalizeContext).filter(Boolean) : [],
    })).filter((item) => item.normalizedText)
    : [];
  result.phraseSignals = Array.isArray(profile?.phraseSignals)
    ? profile.phraseSignals.map(normalizePhraseSignal).filter((item) => item.normalizedText)
    : [];
  return result;
}

function normalizePhraseSignal(item) {
  const evidence = item?.counterEvidence && typeof item.counterEvidence === "object"
    ? item.counterEvidence
    : {};
  return {
    id: String(item?.id || `phrase-signal-${randomUUID().slice(0, 12)}`),
    text: String(item?.text || "").trim(),
    normalizedText: normalizeKnowledgeText(item?.normalizedText || item?.text),
    meaningZh: String(item?.meaningZh || "").trim(),
    usageZh: String(item?.usageZh || "").trim(),
    firstSeenAt: normalizeTimestamp(item?.firstSeenAt || item?.lastSeenAt),
    lastSeenAt: normalizeTimestamp(item?.lastSeenAt || item?.firstSeenAt),
    exposures: Array.isArray(item?.exposures)
      ? deduplicateExposures(item.exposures.map(normalizeExposure).filter(Boolean))
      : [],
    counterEvidence: {
      reviewAddedAt: normalizeTimestamp(evidence.reviewAddedAt),
      guideOpenedAt: normalizeTimestamp(evidence.guideOpenedAt),
      askedAt: normalizeTimestamp(evidence.askedAt),
    },
    implicitEasyAt: normalizeTimestamp(item?.implicitEasyAt),
    lastRevokedAt: normalizeTimestamp(item?.lastRevokedAt),
  };
}

function normalizeContext(context) {
  if (!context || typeof context !== "object") return null;
  const materialId = String(context.materialId || "").trim();
  const sentenceId = String(context.sentenceId || "").trim();
  if (!materialId || !sentenceId) return null;
  return {
    materialId,
    materialTitle: String(context.materialTitle || "").trim(),
    sentenceId,
    sentenceText: String(context.sentenceText || "").trim(),
  };
}

function normalizeSignalContext(context) {
  if (!context || typeof context !== "object") return null;
  const materialId = String(context.materialId || "").trim();
  const sentenceId = String(context.sentenceId || "").trim();
  if (!materialId || !sentenceId) return null;
  return { materialId, sentenceId };
}

function normalizeExposure(exposure) {
  const context = normalizeSignalContext(exposure);
  const sessionId = normalizeSessionId(exposure?.sessionId);
  if (!context || !sessionId) return null;
  return {
    ...context,
    sessionId,
    firstSeenAt: normalizeTimestamp(exposure.firstSeenAt || exposure.lastSeenAt),
    lastSeenAt: normalizeTimestamp(exposure.lastSeenAt || exposure.firstSeenAt),
  };
}

function normalizeSessionId(value) {
  return String(value || "").trim().slice(0, 160);
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function currentTimestamp(now) {
  const value = typeof now === "function" ? now() : now;
  if (value !== undefined) {
    const normalized = normalizeTimestamp(String(value));
    if (!normalized) throw new Error("学习信号时间无效");
    return normalized;
  }
  return new Date().toISOString();
}

function createEmptyCounterEvidence() {
  return { reviewAddedAt: null, guideOpenedAt: null, askedAt: null };
}

function updateImplicitEasyState(signal, now) {
  const qualifies = qualifiesAsImplicitEasy(signal);
  if (qualifies && !signal.implicitEasyAt) signal.implicitEasyAt = now;
  if (!qualifies && signal.implicitEasyAt && hasCounterEvidence(signal)) {
    signal.implicitEasyAt = null;
    signal.lastRevokedAt = now;
  }
}

function qualifiesAsImplicitEasy(signal) {
  if (hasCounterEvidence(signal)) return false;
  return countDistinctContexts(signal.exposures) >= MIN_IMPLICIT_EASY_CONTEXTS
    && new Set(signal.exposures.map((item) => item.sessionId).filter(Boolean)).size >= MIN_IMPLICIT_EASY_SESSIONS;
}

function isImplicitEasySignal(signal) {
  return Boolean(signal.implicitEasyAt) && qualifiesAsImplicitEasy(signal);
}

function hasCounterEvidence(signal) {
  return Object.values(signal.counterEvidence || {}).some(Boolean);
}

function countDistinctContexts(exposures) {
  return new Set(exposures.map((item) => `${item.materialId}\n${item.sentenceId}`)).size;
}

function deduplicateExposures(exposures) {
  const result = [];
  const lookup = new Map();
  for (const exposure of exposures) {
    const key = `${exposure.materialId}\n${exposure.sentenceId}\n${exposure.sessionId}`;
    const existing = lookup.get(key);
    if (!existing) {
      lookup.set(key, exposure);
      result.push(exposure);
      continue;
    }
    existing.firstSeenAt = earliestTimestamp(existing.firstSeenAt, exposure.firstSeenAt);
    existing.lastSeenAt = latestTimestamp(existing.lastSeenAt, exposure.lastSeenAt);
  }
  return result;
}

function earliestTimestamp(left, right) {
  if (!left) return right;
  if (!right) return left;
  return left < right ? left : right;
}

function latestTimestamp(left, right) {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

function sameContext(left, right) {
  return left.materialId === right.materialId && left.sentenceId === right.sentenceId;
}

function sameSignalContext(left, right) {
  return left.materialId === right.materialId && left.sentenceId === right.sentenceId;
}

function mutateLearnerProfile(filePath, updater) {
  const previous = profileMutationTails.get(filePath) || Promise.resolve();
  const result = previous.catch(() => {}).then(async () => {
    const profile = await readLearnerProfile({ filePath });
    const value = await updater(profile);
    const nextProfile = value?.profile || value || profile;
    await writeLearnerProfile(nextProfile, filePath);
    return value;
  });
  const tail = result.then(() => undefined, () => undefined);
  profileMutationTails.set(filePath, tail);
  tail.then(() => {
    if (profileMutationTails.get(filePath) === tail) profileMutationTails.delete(filePath);
  });
  return result;
}

async function writeLearnerProfile(profile, filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}
