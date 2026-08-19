import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { addAnalysis } from "../lib/importers.mjs";
import {
  repairSparseLarkTranscript,
  repairSparseLarkTranscriptFromBlocks,
} from "../lib/lark-transcript-repair.mjs";
import { createId, materialDir, readMaterial, saveMaterial } from "../lib/storage.mjs";
import {
  reconcileTranscriptParagraphs,
  reconcileTranscriptSentences,
} from "../lib/transcript-reconciliation.mjs";
import { alignSentencePlaybackRanges } from "../lib/sentence-playback-alignment.mjs";
import {
  buildParagraphs,
  buildSegmentsFromBlocks,
  formatLarkTranscript,
  parseLarkTranscript,
  parseWhisperJson,
} from "../lib/transcript.mjs";

const args = process.argv.slice(2);
const analyze = args.includes("--analyze");
const dryRun = args.includes("--dry-run");
const regroupOnly = args.includes("--regroup-only");
const useExistingWhisper = args.includes("--use-existing-whisper");
const maxPauseSeconds = Number(args.find((value) => value.startsWith("--max-pause="))?.split("=")[1] || 4);
const blockIds = args.filter((value) => value.startsWith("--block="))
  .map((value) => value.slice("--block=".length))
  .filter(Boolean);
const materialId = args.find((value) => !value.startsWith("--"));
if (!materialId) throw new Error("Usage: node scripts/repair-lark-transcript.mjs [--dry-run] [--analyze] [--regroup-only] [--use-existing-whisper] [--max-pause=4] [--block=block-id] <material-id>");

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
let repaired;
let fullWhisperPayload = null;
if (useExistingWhisper) {
  fullWhisperPayload = JSON.parse(await fs.readFile(path.join(directory, "whisper", "transcript.json"), "utf8"));
  repaired = repairSparseLarkTranscriptFromBlocks(
    blocks,
    parseWhisperJson(fullWhisperPayload, material.duration),
    { blockIds },
  );
} else {
  repaired = await repairSparseLarkTranscript(blocks, mediaPath, directory, {
    blockIds,
    onStage: (stage) => console.log(stage),
  });
}

console.log(JSON.stringify({ repairs: repaired.repairs, warnings: repaired.warnings }, null, 2));
if (dryRun || !repaired.repairs.length) process.exit(0);

// Repair/transcription can take long enough for the learner to make progress
// in the open app. Rebase the transcript rebuild on the newest local material
// instead of saving the stale snapshot read when this script started.
material = await readMaterial(materialId);
const materialPath = path.join(directory, "material.json");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
await fs.copyFile(materialPath, path.join(directory, `material.before-local-repair.${timestamp}.json`), constants.COPYFILE_EXCL);
await fs.copyFile(transcriptPath, path.join(directory, `source-transcript.before-local-repair.${timestamp}.txt`), constants.COPYFILE_EXCL);

const segments = buildSegmentsFromBlocks(repaired.blocks, 100, maxPauseSeconds);
const sentences = reconcileTranscriptSentences(
  material.sentences,
  segments.sentences,
  () => createId("sentence"),
);
if (!fullWhisperPayload) {
  fullWhisperPayload = await fs.readFile(path.join(directory, "whisper", "transcript.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
}
const playbackAlignment = fullWhisperPayload
  ? alignSentencePlaybackRanges(sentences, fullWhisperPayload, { force: true })
  : { sentences, alignedCount: 0 };
const alignedSentences = playbackAlignment.sentences;
const paragraphs = reconcileTranscriptParagraphs(
  material.paragraphs,
  buildParagraphs(alignedSentences, 100, maxPauseSeconds),
  () => createId("paragraph"),
);
// Re-read once more immediately before saving so progress, review items,
// question history, title changes, and other learner-owned state created while
// alignment was running remain the base of the final write.
const latestMaterial = await readMaterial(materialId);
latestMaterial.sentences = alignedSentences;
latestMaterial.paragraphs = paragraphs;
latestMaterial.analysisStatus = "pending";
latestMaterial.stage = `本地 Whisper 已补全 ${repaired.repairs.length} 处逐字稿缺失`;
latestMaterial.warning = `原文主要来自飞书妙记；本地 Whisper 补全了 ${repaired.repairs.length} 处明显缺失的英文片段。`;
await saveMaterial(latestMaterial);
await fs.writeFile(transcriptPath, `${formatLarkTranscript(repaired.blocks)}\n`, "utf8");

console.log(`${materialId}: ${alignedSentences.length} sentences, ${paragraphs.length} paragraphs, ${playbackAlignment.alignedCount} playback ranges aligned`);
if (analyze) {
  await addAnalysis(materialId, (stage) => console.log(`${materialId}: ${stage}`));
  material = await readMaterial(materialId);
  console.log(`${materialId}: analysis ${material.analysisStatus}`);
}
