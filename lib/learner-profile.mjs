import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LEARNER_PROFILE_PATH } from "./config.mjs";

const PROFILE_VERSION = 1;
const MAX_DIFFICULTY_EXAMPLES = 80;

export function createEmptyLearnerProfile() {
  return {
    version: PROFILE_VERSION,
    updatedAt: null,
    tooSimple: [],
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
  const profile = await readLearnerProfile({ filePath });
  const normalizedText = normalizeKnowledgeText(input.text);
  if (!normalizedText) throw new Error("知识点不能为空");
  const now = new Date().toISOString();
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
  await writeLearnerProfile(profile, filePath);
  return profile;
}

export async function removeTooSimpleKnowledge(feedbackId, options = {}) {
  const filePath = options.filePath || LEARNER_PROFILE_PATH;
  const profile = await readLearnerProfile({ filePath });
  profile.tooSimple = profile.tooSimple.filter((item) => item.id !== feedbackId);
  profile.updatedAt = new Date().toISOString();
  await writeLearnerProfile(profile, filePath);
  return profile;
}

export function buildLearnerDifficultyProfile(profile) {
  const normalized = normalizeLearnerProfile(profile);
  const examples = [...normalized.tooSimple]
    .sort((a, b) => String(b.lastMarkedAt || "").localeCompare(String(a.lastMarkedAt || "")))
    .slice(0, MAX_DIFFICULTY_EXAMPLES)
    .map(({ text, meaningZh, usageZh }) => ({ text, meaningZh, usageZh }));
  return {
    explicitTooSimpleCount: normalized.tooSimple.length,
    tooSimpleExamples: examples,
  };
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
  return result;
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

function sameContext(left, right) {
  return left.materialId === right.materialId && left.sentenceId === right.sentenceId;
}

async function writeLearnerProfile(profile, filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}
