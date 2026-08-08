import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { addAnalysis } from "../lib/importers.mjs";
import { repairSparseLarkTranscript } from "../lib/lark-transcript-repair.mjs";
import { createId, materialDir, readMaterial, saveMaterial } from "../lib/storage.mjs";
import {
  buildParagraphs,
  buildSegmentsFromBlocks,
  formatLarkTranscript,
  parseLarkTranscript,
} from "../lib/transcript.mjs";

const args = process.argv.slice(2);
const analyze = args.includes("--analyze");
const dryRun = args.includes("--dry-run");
const regroupOnly = args.includes("--regroup-only");
const maxPauseSeconds = Number(args.find((value) => value.startsWith("--max-pause="))?.split("=")[1] || 4);
const blockIds = args.filter((value) => value.startsWith("--block="))
  .map((value) => value.slice("--block=".length))
  .filter(Boolean);
const materialId = args.find((value) => !value.startsWith("--"));
if (!materialId) throw new Error("Usage: node scripts/repair-lark-transcript.mjs [--dry-run] [--analyze] [--regroup-only] [--max-pause=4] [--block=block-id] <material-id>");

let material = await readMaterial(materialId);
if (material.sourceType !== "lark") throw new Error(`${materialId} is not a Lark material`);
const directory = materialDir(materialId);
if (regroupOnly) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const materialPath = path.join(directory, "material.json");
  await fs.copyFile(materialPath, path.join(directory, `material.before-paragraph-regroup.${timestamp}.json`), constants.COPYFILE_EXCL);
  material.paragraphs = reconcileParagraphs(
    material.paragraphs,
    buildParagraphs(material.sentences, 100, maxPauseSeconds),
  );
  material.stage = "解析完成";
  await saveMaterial(material);
  console.log(`${materialId}: regrouped into ${material.paragraphs.length} paragraphs with ${maxPauseSeconds}s pause tolerance`);
  process.exit(0);
}
const transcriptPath = path.join(directory, "source-transcript.txt");
const mediaPath = path.join(directory, material.media.file);
const transcript = await fs.readFile(transcriptPath, "utf8");
const blocks = parseLarkTranscript(transcript, material.duration);
const repaired = await repairSparseLarkTranscript(blocks, mediaPath, directory, {
  blockIds,
  onStage: (stage) => console.log(stage),
});

console.log(JSON.stringify({ repairs: repaired.repairs, warnings: repaired.warnings }, null, 2));
if (dryRun || !repaired.repairs.length) process.exit(0);

const materialPath = path.join(directory, "material.json");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
await fs.copyFile(materialPath, path.join(directory, `material.before-local-repair.${timestamp}.json`), constants.COPYFILE_EXCL);
await fs.copyFile(transcriptPath, path.join(directory, `source-transcript.before-local-repair.${timestamp}.txt`), constants.COPYFILE_EXCL);

const segments = buildSegmentsFromBlocks(repaired.blocks, 100, maxPauseSeconds);
const sentences = reconcileSentences(material.sentences, segments.sentences);
const paragraphs = reconcileParagraphs(material.paragraphs, buildParagraphs(sentences, 100, maxPauseSeconds));
material.sentences = sentences;
material.paragraphs = paragraphs;
material.analysisStatus = "pending";
material.stage = `本地 Whisper 已补全 ${repaired.repairs.length} 处逐字稿缺失`;
material.warning = `原文主要来自飞书妙记；本地 Whisper 补全了 ${repaired.repairs.length} 处明显缺失的英文片段。`;
await saveMaterial(material);
await fs.writeFile(transcriptPath, `${formatLarkTranscript(repaired.blocks)}\n`, "utf8");

console.log(`${materialId}: ${sentences.length} sentences, ${paragraphs.length} paragraphs`);
if (analyze) {
  await addAnalysis(materialId, (stage) => console.log(`${materialId}: ${stage}`));
  material = await readMaterial(materialId);
  console.log(`${materialId}: analysis ${material.analysisStatus}`);
}

function reconcileSentences(previousSentences, nextSentences) {
  const previousByKey = uniqueBy(previousSentences, sentenceKey);
  return nextSentences.map((sentence) => {
    const previous = previousByKey.get(sentenceKey(sentence));
    return previous
      ? { ...sentence, id: previous.id, analysis: previous.analysis || null }
      : { ...sentence, id: createId("sentence"), analysis: null };
  });
}

function reconcileParagraphs(previousParagraphs, nextParagraphs) {
  const previousByKey = uniqueBy(previousParagraphs, paragraphKey);
  return nextParagraphs.map((paragraph) => {
    const previous = previousByKey.get(paragraphKey(paragraph));
    return { ...paragraph, id: previous?.id || createId("paragraph") };
  });
}

function uniqueBy(items, keyFor) {
  const values = new Map();
  for (const item of items || []) {
    const key = keyFor(item);
    values.set(key, values.has(key) ? null : item);
  }
  return values;
}

function sentenceKey(sentence) {
  return `${sentence.speaker}|${Number(sentence.start).toFixed(3)}|${normalizeText(sentence.text)}`;
}

function paragraphKey(paragraph) {
  return (paragraph.sentenceIds || []).join("|");
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}
