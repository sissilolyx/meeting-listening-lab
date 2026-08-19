import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_ROOT, JOBS_ROOT, MATERIALS_ROOT, TRASH_ROOT } from "./config.mjs";
import { attachStandaloneAcknowledgementContexts, countWords } from "./transcript.mjs";

const deletedMaterialIds = new Set();
const materialMutationTails = new Map();
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TRASH_METADATA_FILE = "trash.json";

export async function ensureStorage() {
  await Promise.all([
    fs.mkdir(DATA_ROOT, { recursive: true }),
    fs.mkdir(MATERIALS_ROOT, { recursive: true }),
    fs.mkdir(TRASH_ROOT, { recursive: true }),
    fs.mkdir(JOBS_ROOT, { recursive: true }),
  ]);
}

export function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function materialDir(id) {
  validateMaterialId(id);
  return path.join(MATERIALS_ROOT, id);
}

export function trashDir(id) {
  validateMaterialId(id);
  return path.join(TRASH_ROOT, id);
}

export async function createMaterial(seed = {}) {
  const id = createId("material");
  const directory = materialDir(id);
  await fs.mkdir(directory, { recursive: true });
  const now = new Date().toISOString();
  const material = {
    id,
    title: seed.title || "正在导入",
    sourceType: seed.sourceType || "local",
    sourceUrl: seed.sourceUrl || null,
    minuteToken: seed.minuteToken || null,
    status: "processing",
    stage: "准备导入",
    createdAt: now,
    updatedAt: now,
    duration: null,
    media: null,
    overview: null,
    analysisStatus: "pending",
    analysisProvider: null,
    sentences: [],
    paragraphs: [],
    progress: {},
    reviewItems: [],
    qaHistory: [],
    phraseGuides: [],
    completed: false,
    completedAt: null,
    warning: null,
    error: null,
  };
  await saveMaterial(material);
  return material;
}

export async function saveMaterial(material) {
  return enqueueMaterialMutation(material.id, () => writeMaterialUnlocked(material));
}

export async function updateMaterial(id, updater) {
  return enqueueMaterialMutation(id, async () => {
    const material = await readMaterial(id);
    const result = await updater(material);
    await writeMaterialUnlocked(material);
    return result === undefined ? material : result;
  });
}

async function writeMaterialUnlocked(material) {
  if (deletedMaterialIds.has(material.id)) throw new Error("Material was deleted");
  const directory = materialDir(material.id);
  await fs.mkdir(directory, { recursive: true });
  if (deletedMaterialIds.has(material.id)) throw new Error("Material was deleted");
  const target = path.join(directory, "material.json");
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  material.progress = normalizeProgress(material.progress);
  normalizeMaterialPhraseGuides(material);
  normalizeMaterialLearningState(material);
  material.updatedAt = new Date().toISOString();
  try {
    await fs.writeFile(temporary, `${JSON.stringify(material, null, 2)}\n`, "utf8");
    if (deletedMaterialIds.has(material.id)) throw new Error("Material was deleted");
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  if (deletedMaterialIds.has(material.id)) {
    await fs.rm(directory, { recursive: true, force: true });
    throw new Error("Material was deleted");
  }
  return material;
}

export async function readMaterial(id) {
  const raw = await fs.readFile(path.join(materialDir(id), "material.json"), "utf8");
  const material = JSON.parse(raw);
  material.paragraphs = attachStandaloneAcknowledgementContexts(material.paragraphs || []);
  material.progress = normalizeProgress(material.progress);
  material.reviewItems ||= [];
  material.qaHistory = Array.isArray(material.qaHistory) ? material.qaHistory : [];
  normalizeMaterialPhraseGuides(material);
  normalizeMaterialLearningState(material);
  return material;
}

export async function deleteMaterial(id) {
  return enqueueMaterialMutation(id, async () => {
    const directory = materialDir(id);
    const material = await readMaterial(id);
    const deletedAt = new Date().toISOString();
    const entry = {
      id,
      title: material.title,
      deletedAt,
      expiresAt: new Date(Date.parse(deletedAt) + TRASH_RETENTION_MS).toISOString(),
    };
    const destination = trashDir(id);
    deletedMaterialIds.add(id);
    try {
      await fs.access(destination).then(
        () => { throw new Error("Material already exists in trash"); },
        (error) => { if (error.code !== "ENOENT") throw error; },
      );
      await fs.writeFile(path.join(directory, TRASH_METADATA_FILE), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
      await fs.rename(directory, destination);
    } catch (error) {
      await fs.rm(path.join(directory, TRASH_METADATA_FILE), { force: true });
      deletedMaterialIds.delete(id);
      throw error;
    }
    return entry;
  });
}

export async function listTrash(options = {}) {
  await ensureStorage();
  await purgeExpiredTrash(options);
  const entries = await fs.readdir(TRASH_ROOT, { withFileTypes: true });
  const trash = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      trash.push(await readTrashEntry(entry.name));
    } catch {
      // Ignore incomplete trash entries so one damaged item cannot block recovery of the rest.
    }
  }
  return trash.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export async function restoreMaterial(id, options = {}) {
  await ensureStorage();
  await purgeExpiredTrash(options);
  return enqueueMaterialMutation(id, async () => {
    const entry = await readTrashEntry(id);
    const source = trashDir(id);
    const destination = materialDir(id);
    await fs.access(destination).then(
      () => { throw new Error("Material already exists in library"); },
      (error) => { if (error.code !== "ENOENT") throw error; },
    );
    await fs.rename(source, destination);
    await fs.rm(path.join(destination, TRASH_METADATA_FILE), { force: true });
    deletedMaterialIds.delete(id);
    return { entry, material: await readMaterial(id) };
  });
}

export async function purgeExpiredTrash(options = {}) {
  const now = Number(options.now ?? Date.now());
  const entries = await fs.readdir(TRASH_ROOT, { withFileTypes: true });
  const purgedIds = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const purged = await enqueueMaterialMutation(entry.name, async () => {
        const trashEntry = await readTrashEntry(entry.name);
        if (Date.parse(trashEntry.expiresAt) > now) return false;
        await fs.rm(trashDir(entry.name), { recursive: true, force: true });
        return true;
      });
      if (purged) purgedIds.push(entry.name);
    } catch {
      // Keep unreadable entries for manual recovery rather than deleting unknown data.
    }
  }
  return { purgedIds };
}

export function normalizeProgress(progress = {}) {
  return Object.fromEntries(Object.entries(progress).map(([segmentId, value]) => {
    const item = value && typeof value === "object" ? { ...value } : {};
    if (item.status === "mastered") {
      item.heard = true;
      delete item.status;
    }
    if (item.status === "unrated") delete item.status;
    return [segmentId, item];
  }));
}

export async function listMaterials() {
  await ensureStorage();
  const entries = await fs.readdir(MATERIALS_ROOT, { withFileTypes: true });
  const materials = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      materials.push(await readMaterial(entry.name));
    } catch {
      // Ignore incomplete directories left by an interrupted import.
    }
  }
  return materials.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function readTrashEntry(id) {
  const raw = await fs.readFile(path.join(trashDir(id), TRASH_METADATA_FILE), "utf8");
  const entry = JSON.parse(raw);
  if (entry.id !== id || !entry.deletedAt || !entry.expiresAt) throw new Error("Invalid trash entry");
  return entry;
}

function validateMaterialId(id) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("Invalid material id");
}

export async function updateProgress(id, segmentIds, patch) {
  return updateMaterial(id, (material) => {
    for (const segmentId of segmentIds) {
      const previous = material.progress[segmentId] || {};
      material.progress[segmentId] = {
        ...previous,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
    }
    return material;
  });
}

export async function updateMaterialLearningState(id, patch, options = {}) {
  if (typeof patch?.completed !== "boolean") {
    const error = new Error("Completed state must be a boolean");
    error.code = "INVALID_LEARNING_STATE";
    throw error;
  }
  const now = normalizeIsoTimestamp(options.now) || new Date().toISOString();
  return updateMaterial(id, (material) => {
    normalizeMaterialLearningState(material);
    if (patch.completed) {
      if (!material.completed) material.completedAt = now;
      else material.completedAt ||= now;
      material.completed = true;
    } else {
      material.completed = false;
      material.completedAt = null;
    }
    return material;
  });
}

export async function updateSentenceText(id, sentenceId, text, options = {}) {
  return updateMaterial(id, (material) => {
    const sentence = material.sentences.find((item) => item.id === sentenceId);
    if (!sentence) throw new Error("Sentence not found");
    if (typeof options.expectedText === "string" && sentence.text !== options.expectedText) {
      const error = new Error("Sentence text changed before this edit was saved");
      error.code = "SENTENCE_EDIT_CONFLICT";
      error.currentText = sentence.text;
      throw error;
    }

    const nextText = String(text || "").trim();
    if (!nextText) {
      const error = new Error("Sentence text cannot be empty");
      error.code = "INVALID_SENTENCE_TEXT";
      throw error;
    }
    const changed = sentence.text !== nextText;
    if (!changed) return { material, sentence, changed: false };

    sentence.text = nextText;
    sentence.wordCount = countWords(nextText);
    sentence.analysis = null;
    material.phraseGuides = material.phraseGuides.filter((item) => item.sentenceId !== sentenceId);
    material.paragraphs = rebuildParagraphTexts(material.paragraphs, material.sentences);
    material.analysisStatus = "pending";
    material.stage = "原文已修正，等待重新生成本句讲解";
    material.warning = null;
    return { material, sentence, changed: true };
  });
}

export function normalizePhraseGuideText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function phraseGuideKey(sentenceId, phraseText) {
  return `${String(sentenceId || "").trim()}|${normalizePhraseGuideText(phraseText)}`;
}

export async function savePhraseGuideItem(id, guide) {
  return updateMaterial(id, (material) => {
    normalizeMaterialPhraseGuides(material);
    const sentenceId = String(guide?.sentenceId || "").trim();
    const phraseText = String(guide?.phraseText || "").trim();
    const sourceSentenceText = String(guide?.sourceSentenceText || "");
    const sentence = material.sentences.find((item) => item.id === sentenceId);
    if (!sentence || sentence.text !== sourceSentenceText) {
      const error = new Error("Source sentence changed before the phrase guide was saved");
      error.code = "PHRASE_GUIDE_SENTENCE_CONFLICT";
      error.currentSentenceText = sentence?.text || "";
      throw error;
    }
    const analyzedPhrase = (sentence.analysis?.phrases || []).find((item) => (
      String(item.text || "").trim() === phraseText
    ));
    if (!analyzedPhrase) {
      const error = new Error("Phrase is no longer part of the sentence analysis");
      error.code = "PHRASE_GUIDE_PHRASE_CONFLICT";
      throw error;
    }
    const normalizedPhrase = normalizePhraseGuideText(phraseText);
    if (!normalizedPhrase) throw new Error("Phrase text cannot be empty");
    const key = phraseGuideKey(sentenceId, phraseText);
    const now = new Date().toISOString();
    const existingIndex = material.phraseGuides.findIndex((item) => (
      (item.key || phraseGuideKey(item.sentenceId, item.phraseText)) === key
    ));
    const existing = existingIndex >= 0 ? material.phraseGuides[existingIndex] : null;
    const phraseGuide = {
      id: existing?.id || createId("phrase-guide"),
      key,
      sentenceId,
      phraseText,
      normalizedPhrase,
      sourceSentenceText,
      meaningZh: String(guide.meaningZh ?? analyzedPhrase.meaningZh ?? "").trim(),
      usageZh: String(guide.usageZh || "").trim(),
      patternZh: String(guide.patternZh || "").trim(),
      alternatives: Array.isArray(guide.alternatives)
        ? guide.alternatives.slice(0, 3).map((item) => ({
          text: String(item?.text || "").trim(),
          differenceZh: String(item?.differenceZh || "").trim(),
        }))
        : [],
      examples: Array.isArray(guide.examples)
        ? guide.examples.slice(0, 4).map((item) => ({
          english: String(item?.english || "").trim(),
          meaningZh: String(item?.meaningZh || "").trim(),
        }))
        : [],
      ...(normalizeAiProviderMetadata(guide.aiProvider) ? { aiProvider: normalizeAiProviderMetadata(guide.aiProvider) } : {}),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    if (existingIndex >= 0) material.phraseGuides[existingIndex] = phraseGuide;
    else material.phraseGuides.push(phraseGuide);
    return { material, phraseGuide };
  });
}

export async function saveReviewItem(id, reviewItem) {
  return updateMaterial(id, (material) => {
    const now = new Date().toISOString();
    const item = {
      ...reviewItem,
      id: reviewItem.id || createId("review"),
      createdAt: reviewItem.createdAt || now,
      updatedAt: now,
    };
    const index = material.reviewItems.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) material.reviewItems[index] = { ...material.reviewItems[index], ...item };
    else material.reviewItems.push(item);
    return { material, reviewItem: item };
  });
}

export async function saveQaHistoryItem(id, historyItem) {
  return updateMaterial(id, (material) => {
    const now = new Date().toISOString();
    const item = {
      ...historyItem,
      id: historyItem.id || createId("qa-history"),
      createdAt: historyItem.createdAt || now,
    };
    material.qaHistory.push(item);
    return { material, historyItem: item };
  });
}

export async function removeQaHistoryItem(id, historyId) {
  return updateMaterial(id, (material) => {
    const index = material.qaHistory.findIndex((item) => item.id === historyId);
    if (index < 0) {
      const error = new Error("Question history item not found");
      error.code = "QA_HISTORY_NOT_FOUND";
      throw error;
    }
    material.qaHistory.splice(index, 1);
    return material;
  });
}

export async function removeReviewItem(id, reviewId) {
  return updateMaterial(id, (material) => {
    const previousLength = material.reviewItems.length;
    material.reviewItems = material.reviewItems.filter((item) => item.id !== reviewId);
    if (material.reviewItems.length === previousLength) throw new Error("Review item not found");
    return material;
  });
}

function enqueueMaterialMutation(id, mutation) {
  validateMaterialId(id);
  const previous = materialMutationTails.get(id) || Promise.resolve();
  const result = previous.catch(() => {}).then(mutation);
  const tail = result.then(() => undefined, () => undefined);
  materialMutationTails.set(id, tail);
  tail.then(() => {
    if (materialMutationTails.get(id) === tail) materialMutationTails.delete(id);
  });
  return result;
}

function normalizeMaterialLearningState(material) {
  material.completed = material.completed === true;
  material.completedAt = material.completed ? normalizeIsoTimestamp(material.completedAt) : null;
  return material;
}

function normalizeMaterialPhraseGuides(material) {
  material.phraseGuides = Array.isArray(material.phraseGuides) ? material.phraseGuides : [];
  return material;
}

function normalizeAiProviderMetadata(value) {
  if (!value || !["codex", "cursor"].includes(value.provider) || typeof value.model !== "string") return null;
  return { provider: value.provider, model: value.model.slice(0, 160) };
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function rebuildParagraphTexts(paragraphs, sentences) {
  const lookup = new Map(sentences.map((item) => [item.id, item]));
  return paragraphs.map((paragraph) => {
    const paragraphSentences = paragraph.sentenceIds.map((id) => lookup.get(id)).filter(Boolean);
    const text = paragraphSentences.map((sentence) => sentence.text).filter(Boolean).join(" ");
    return {
      ...paragraph,
      text,
      wordCount: paragraphSentences.reduce(
        (total, sentence) => total + (Number(sentence.wordCount) || countWords(sentence.text)),
        0,
      ),
    };
  });
}

export async function saveJob(job) {
  await fs.mkdir(JOBS_ROOT, { recursive: true });
  const target = path.join(JOBS_ROOT, `${job.id}.json`);
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, "utf8");
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function readJob(id) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("Invalid job id");
  const raw = await fs.readFile(path.join(JOBS_ROOT, `${id}.json`), "utf8");
  return JSON.parse(raw);
}

export async function listJobs() {
  await ensureStorage();
  const entries = await fs.readdir(JOBS_ROOT, { withFileTypes: true });
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(JOBS_ROOT, entry.name), "utf8");
      jobs.push(JSON.parse(raw));
    } catch {
      // Ignore incomplete job files left by an interrupted write.
    }
  }
  return jobs.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}
