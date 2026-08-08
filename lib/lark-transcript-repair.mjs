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
      if (!shouldPreferRecoveredTranscript(candidate, recovered.blocks, options)) continue;

      const replacement = recovered.blocks.map((block, index) => ({
        ...block,
        id: `${candidate.id}-recovered-${index + 1}`,
        speaker: candidate.speaker,
        text: String(block.text || "").replace(/^\s*-\s+/, "").trim(),
        transcriptSource: "local-whisper-recovery",
      }));
      const targetIndex = repaired.findIndex((block) => block.id === candidate.id);
      if (targetIndex < 0) continue;
      repaired.splice(targetIndex, 1, ...replacement);
      repairs.push({
        blockId: candidate.id,
        start: candidate.start,
        end: candidate.end,
        officialWords: countWords(candidate.text),
        recoveredWords: replacement.reduce((sum, block) => sum + countWords(block.text), 0),
      });
    } catch (error) {
      warnings.push(`${candidate.id}: ${error?.message || error}`);
    }
  }

  return { blocks: repaired, repairs, warnings };
}
