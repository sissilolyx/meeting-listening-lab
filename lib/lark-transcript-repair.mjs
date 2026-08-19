import { modelAvailable, transcribeMediaRange } from "./media.mjs";
import {
  countWords,
  findSparseLarkBlocks,
  shouldPreferRecoveredTranscript,
} from "./transcript.mjs";

export async function repairSparseLarkTranscript(blocks, mediaPath, workDir, options = {}) {
  if (!(await modelAvailable(options.modelPath))) {
    return { blocks, repairs: [], warnings: ["本地 Whisper 模型不可用，未检查飞书逐字稿缺失"] };
  }

  const requestedBlockIds = new Set(options.blockIds || []);
  const candidates = findSparseLarkBlocks(blocks, options)
    .filter((block) => !requestedBlockIds.size || requestedBlockIds.has(block.id));
  const repaired = [...blocks];
  const repairs = [];
  const warnings = [];

  for (const [candidateIndex, candidate] of candidates.entries()) {
    await options.onStage?.(
      `本地 Whisper 正在核对可能缺失的逐字稿（${candidateIndex + 1}/${candidates.length}）`,
      0.62 + 0.08 * (candidateIndex / Math.max(1, candidates.length)),
    );
    try {
      const recovered = await transcribeMediaRange(mediaPath, workDir, {
        start: candidate.start,
        end: candidate.end,
        modelPath: options.modelPath,
        onOutput: options.onOutput,
      });
      const repair = replaceSparseCandidate(repaired, candidate, recovered.blocks, options);
      if (repair) repairs.push(repair);
    } catch (error) {
      warnings.push(`${candidate.id}: ${error?.message || error}`);
    }
  }

  return { blocks: repaired, repairs, warnings };
}

// Reuse a full, already-local Whisper transcript when it exists. This is both
// faster and safer for an old material than retranscribing the same private
// recording: only blocks whose midpoint belongs to a verified sparse Lark
// window are considered, and the original speaker label stays authoritative.
export function repairSparseLarkTranscriptFromBlocks(blocks, recoveredBlocks, options = {}) {
  const requestedBlockIds = new Set(options.blockIds || []);
  const candidates = findSparseLarkBlocks(blocks, options)
    .filter((block) => !requestedBlockIds.size || requestedBlockIds.has(block.id));
  const repaired = [...blocks];
  const repairs = [];

  for (const candidate of candidates) {
    const recovered = recoveredBlocksForCandidate(candidate, recoveredBlocks, options);
    const repair = replaceSparseCandidate(repaired, candidate, recovered, options);
    if (repair) repairs.push(repair);
  }

  return { blocks: repaired, repairs, warnings: [] };
}

export function recoveredBlocksForCandidate(candidate, recoveredBlocks = [], options = {}) {
  const tolerance = Math.max(0, Number(options.boundaryToleranceSeconds ?? 0.12));
  const start = Number(candidate?.start);
  const end = Number(candidate?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  return recoveredBlocks.filter((block) => {
    const blockStart = Number(block?.start);
    const blockEnd = Number(block?.end);
    if (!Number.isFinite(blockStart) || !Number.isFinite(blockEnd) || blockEnd <= blockStart) return false;
    const midpoint = blockStart + (blockEnd - blockStart) / 2;
    return midpoint >= start - tolerance && midpoint < end + tolerance;
  });
}

function replaceSparseCandidate(repaired, candidate, recoveredBlocks, options) {
  if (!shouldPreferRecoveredTranscript(candidate, recoveredBlocks, options)) return null;
  const replacement = recoveredBlocks
    .map((block, index) => ({
      ...block,
      id: `${candidate.id}-recovered-${index + 1}`,
      speaker: candidate.speaker,
      text: String(block.text || "").replace(/^\s*-\s+/, "").trim(),
      transcriptSource: "local-whisper-recovery",
    }))
    .filter((block) => block.text);
  if (!replacement.length) return null;

  const targetIndex = repaired.findIndex((block) => block.id === candidate.id);
  if (targetIndex < 0) return null;
  repaired.splice(targetIndex, 1, ...replacement);
  return {
    blockId: candidate.id,
    start: candidate.start,
    end: candidate.end,
    officialWords: countWords(candidate.text),
    recoveredWords: replacement.reduce((sum, block) => sum + countWords(block.text), 0),
  };
}
