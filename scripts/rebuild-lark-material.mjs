import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { addAnalysis } from "../lib/importers.mjs";
import { materialDir, readMaterial, saveMaterial } from "../lib/storage.mjs";
import { buildLarkSegments } from "../lib/transcript.mjs";

const args = process.argv.slice(2);
const analyze = args.includes("--analyze");
const materialIds = args.filter((value) => value !== "--analyze");

if (!materialIds.length) {
  throw new Error("Usage: node scripts/rebuild-lark-material.mjs [--analyze] <material-id> [...]");
}

for (const materialId of materialIds) {
  let material = await readMaterial(materialId);
  if (material.sourceType !== "lark") throw new Error(`${materialId} is not a Lark material`);

  const directory = materialDir(materialId);
  const transcriptPath = path.join(directory, "source-transcript.txt");
  const materialPath = path.join(directory, "material.json");
  const backupPath = path.join(directory, `material.before-transcript-rebuild.${backupTimestamp()}.json`);
  const transcript = await fs.readFile(transcriptPath, "utf8");
  const segments = buildLarkSegments(transcript, material.duration, 100);
  const progress = remapUniqueProgress(material.sentences, segments.sentences, material.progress || {});
  await fs.copyFile(materialPath, backupPath, constants.COPYFILE_EXCL);

  material.sentences = segments.sentences;
  material.paragraphs = segments.paragraphs;
  material.progress = progress;
  material.overview = null;
  material.analysisStatus = "pending";
  material.stage = "原文已按飞书逐字稿校准";
  material.warning = "原文和说话人来自飞书妙记；同一发言块内的自然句时间为估算值。";
  await saveMaterial(material);

  console.log(`${materialId}: backup ${path.basename(backupPath)}`);
  console.log(`${materialId}: ${segments.sentences.length} sentences, ${segments.paragraphs.length} paragraphs`);
  if (analyze) {
    await addAnalysis(materialId, (stage) => console.log(`${materialId}: ${stage}`));
    material = await readMaterial(materialId);
    console.log(`${materialId}: analysis ${material.analysisStatus}`);
  }
}

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
