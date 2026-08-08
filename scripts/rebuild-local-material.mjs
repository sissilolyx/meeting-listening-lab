import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { materialDir, readMaterial, saveMaterial } from "../lib/storage.mjs";
import { blocksToSentences, buildParagraphs, parseWhisperJson } from "../lib/transcript.mjs";

const materialId = process.argv[2];
if (!materialId) throw new Error("Usage: node scripts/rebuild-local-material.mjs <material-id>");

const material = await readMaterial(materialId);
if (material.sourceType !== "local") throw new Error(`${materialId} is not a local material`);
if (material.reviewItems?.length) {
  throw new Error("This material has review items. Remap them before rebuilding the transcript.");
}

const directory = materialDir(materialId);
const materialPath = path.join(directory, "material.json");
const transcriptPath = path.join(directory, "whisper", "transcript.json");
const backupPath = path.join(directory, `material.before-local-transcript-rebuild.${backupTimestamp()}.json`);
const payload = JSON.parse(await fs.readFile(transcriptPath, "utf8"));
const blocks = parseWhisperJson(payload, material.duration);
const sentences = blocksToSentences(blocks);
const paragraphs = buildParagraphs(sentences, 100);
const previousSentences = material.sentences;

if (!sentences.length) throw new Error("The cleaned Whisper transcript is empty");
await fs.copyFile(materialPath, backupPath, constants.COPYFILE_EXCL);

material.sentences = sentences;
material.paragraphs = paragraphs;
material.progress = remapUniqueProgress(previousSentences, sentences, material.progress || {});
material.overview = null;
material.analysisStatus = "pending";
material.status = "ready";
material.stage = "原文已清理，讲解待重新生成";
material.warning = null;
material.error = null;
await saveMaterial(material);

console.log(`${materialId}: backup ${path.basename(backupPath)}`);
console.log(`${materialId}: ${sentences.length} sentences, ${paragraphs.length} paragraphs`);

function backupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function remapUniqueProgress(previousSentences, nextSentences, previousProgress) {
  const previousByText = uniqueSentenceMap(previousSentences);
  const nextCounts = countSentenceTexts(nextSentences);
  const progress = {};
  for (const sentence of nextSentences) {
    const key = normalizeText(sentence.text);
    const previous = previousByText.get(key);
    if (!previous || nextCounts.get(key) !== 1 || !previousProgress[previous.id]) continue;
    progress[sentence.id] = previousProgress[previous.id];
  }
  return progress;
}

function uniqueSentenceMap(sentences) {
  const map = new Map();
  for (const sentence of sentences) {
    const key = normalizeText(sentence.text);
    map.set(key, map.has(key) ? null : sentence);
  }
  return map;
}

function countSentenceTexts(sentences) {
  const counts = new Map();
  for (const sentence of sentences) {
    const key = normalizeText(sentence.text);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function normalizeText(text) {
  return String(text).toLowerCase().replace(/\s+/g, " ").trim();
}
