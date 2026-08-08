import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { alignSentencePlaybackRanges } from "../lib/sentence-playback-alignment.mjs";
import { materialDir } from "../lib/storage.mjs";

const playbackFields = [
  "playbackStart",
  "playbackEnd",
  "playbackTimingQuality",
  "playbackAlignmentCoverage",
];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const materialIds = args.filter((value) => !value.startsWith("--"));

if (!materialIds.length) {
  throw new Error("Usage: node scripts/align-sentence-playback.mjs [--dry-run] [--force] <material-id> [...]");
}

for (const materialId of materialIds) {
  const directory = materialDir(materialId);
  const whisperPath = path.join(directory, "whisper", "transcript.json");
  const materialPath = path.join(directory, "material.json");
  const [materialRaw, whisperPayload] = await Promise.all([
    fs.readFile(materialPath, "utf8"),
    fs.readFile(whisperPath, "utf8").then(JSON.parse),
  ]);
  const material = JSON.parse(materialRaw);
  const result = alignSentencePlaybackRanges(material.sentences, whisperPayload, { force });
  const unchangedCount = material.sentences.length - result.alignedCount - result.skippedCount;
  console.log(JSON.stringify({
    materialId,
    sentenceCount: material.sentences.length,
    alignedCount: result.alignedCount,
    skippedCount: result.skippedCount,
    unchangedCount,
    dryRun,
  }));
  if (dryRun || result.alignedCount === 0) continue;

  const backupPath = path.join(directory, `material.before-playback-alignment.${backupTimestamp()}.json`);
  await fs.copyFile(materialPath, backupPath, constants.COPYFILE_EXCL);
  material.sentences = material.sentences.map((sentence, index) => {
    const aligned = result.sentences[index] || {};
    const next = { ...sentence };
    for (const field of playbackFields) {
      if (Object.hasOwn(aligned, field)) next[field] = aligned[field];
    }
    return next;
  });
  material.updatedAt = new Date().toISOString();
  await writeRawMaterial(materialPath, material, materialRaw);
  console.log(`${materialId}: saved playback alignment; backup ${path.basename(backupPath)}`);
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeRawMaterial(materialPath, material, expectedRaw) {
  const latestRaw = await fs.readFile(materialPath, "utf8");
  if (latestRaw !== expectedRaw) {
    throw new Error("Material changed while playback alignment was running; no changes were saved");
  }
  const temporaryPath = `${materialPath}.${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(material, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, materialPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}
