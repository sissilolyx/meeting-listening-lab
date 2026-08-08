import fs from "node:fs/promises";
import path from "node:path";
import { analyzeMaterial } from "./analysis.mjs";
import { friendlyCommandError, runCommand } from "./commands.mjs";
import { readLearnerProfile } from "./learner-profile.mjs";
import { parseCommandEnvelope, probeMedia, transcribeMedia } from "./media.mjs";
import { repairSparseLarkTranscript } from "./lark-transcript-repair.mjs";
import { alignSentencePlaybackRanges } from "./sentence-playback-alignment.mjs";
import { materialDir, readMaterial, updateMaterial } from "./storage.mjs";
import {
  blocksToSentences,
  buildParagraphs,
  buildSegmentsFromBlocks,
  formatLarkTranscript,
  parseLarkTranscript,
} from "./transcript.mjs";

const larkEnvironment = {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
};

export async function importLarkMaterial(materialId, sourceUrl, minuteToken, report) {
  const directory = materialDir(materialId);
  const staging = path.join(directory, "lark-import");
  await fs.mkdir(staging, { recursive: true });
  let material = await readMaterial(materialId);

  try {
    await report("正在读取飞书逐字稿", 0.08);
    const detail = await runCommand("lark-cli", [
      "minutes", "+detail",
      "--minute-tokens", minuteToken,
      "--transcript",
      "--output-dir", "./transcript",
      "--as", "user",
      "--format", "json",
    ], { cwd: staging, env: larkEnvironment, timeoutMs: 20 * 60 * 1000 });
    const detailEnvelope = parseCommandEnvelope(detail);
    const item = detailEnvelope?.data?.minutes?.[0];
    if (!detailEnvelope?.ok || !item) throw new Error("没有读取到这条妙记");

    material = await updateMaterial(materialId, (latest) => {
      if (!latest.title || latest.title === "正在读取飞书妙记" || latest.title === "正在导入") {
        latest.title = item.title || latest.title;
      }
      latest.minuteToken = minuteToken;
      latest.sourceUrl = sourceUrl;
      return latest;
    });

    await report("正在下载原始飞书录屏", 0.2);
    const download = await runCommand("lark-cli", [
      "minutes", "+download",
      "--minute-tokens", minuteToken,
      "--output-dir", "./media",
      "--as", "user",
      "--format", "json",
    ], { cwd: staging, env: larkEnvironment, timeoutMs: 2 * 60 * 60 * 1000 });
    const downloadEnvelope = parseCommandEnvelope(download);
    const savedPath = downloadEnvelope?.data?.saved_path
      || downloadEnvelope?.data?.downloads?.[0]?.saved_path;
    if (!downloadEnvelope?.ok || !savedPath) throw new Error("飞书没有返回可下载的原始录屏");

    const transcriptPath = path.resolve(staging, item.artifacts?.transcript_file || "");
    const mediaPath = path.resolve(savedPath);
    const mediaInfo = await probeMedia(mediaPath);
    const extension = path.extname(mediaPath).toLowerCase() || (mediaInfo.kind === "video" ? ".mp4" : ".m4a");
    const finalMediaPath = path.join(directory, `source${extension}`);
    const finalTranscriptPath = path.join(directory, "source-transcript.txt");
    const officialTranscriptPath = path.join(directory, "source-transcript-lark.txt");
    await fs.rename(mediaPath, finalMediaPath);
    await fs.copyFile(transcriptPath, officialTranscriptPath);

    const larkText = await fs.readFile(officialTranscriptPath, "utf8");
    const officialBlocks = parseLarkTranscript(larkText, mediaInfo.duration);
    const repairedTranscript = await repairSparseLarkTranscript(
      officialBlocks,
      finalMediaPath,
      directory,
      { onStage: report },
    );
    await fs.writeFile(finalTranscriptPath, `${formatLarkTranscript(repairedTranscript.blocks)}\n`, "utf8");
    const segments = buildSegmentsFromBlocks(repairedTranscript.blocks, 100, 4);
    const playbackAlignment = await alignLarkPlaybackRanges(
      segments.sentences,
      finalMediaPath,
      directory,
      mediaInfo.duration,
      report,
    );

    material = await updateMaterial(materialId, (latest) => {
      latest.duration = mediaInfo.duration;
      latest.media = {
        file: path.basename(finalMediaPath),
        kind: mediaInfo.kind,
        format: mediaInfo.format,
        video: mediaInfo.video,
        audio: mediaInfo.audio,
        size: mediaInfo.size,
      };
      latest.sentences = playbackAlignment.sentences;
      latest.paragraphs = segments.paragraphs;
      const transcriptWarning = repairedTranscript.repairs.length
        ? `原文主要来自飞书妙记；本地 Whisper 补全了 ${repairedTranscript.repairs.length} 处明显缺失的英文片段。`
        : "原文和说话人来自飞书妙记；同一发言块内的自然句时间为估算值。";
      latest.warning = playbackAlignment.warning
        ? `${transcriptWarning} ${playbackAlignment.warning}`
        : `${transcriptWarning} 本地 Whisper 已校准 ${playbackAlignment.alignedCount} 句的原声播放范围。`;
      latest.status = "ready";
      latest.stage = "可以开始精听，讲解正在生成";
      return latest;
    });
    await fs.rm(staging, { recursive: true, force: true });

    await addAnalysis(materialId, report);
    return await readMaterial(materialId);
  } catch (error) {
    throw new Error(friendlyCommandError(error));
  }
}

async function alignLarkPlaybackRanges(sentences, mediaPath, directory, duration, report) {
  try {
    const whisperPath = path.join(directory, "whisper", "transcript.json");
    let whisperPayload;
    try {
      whisperPayload = JSON.parse(await fs.readFile(whisperPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const transcription = await transcribeMedia(mediaPath, directory, {
        duration,
        onStage: (stage) => report(stage, 0.58),
      });
      whisperPayload = JSON.parse(await fs.readFile(transcription.jsonPath, "utf8"));
    }
    await report("正在校准逐句原声范围", 0.61);
    const alignment = alignSentencePlaybackRanges(sentences, whisperPayload);
    return {
      sentences: alignment.sentences,
      alignedCount: alignment.alignedCount,
      warning: alignment.alignedCount
        ? null
        : "本地 Whisper 未能高置信校准逐句播放范围，已继续使用飞书时间。",
    };
  } catch (error) {
    return {
      sentences,
      alignedCount: 0,
      warning: `逐句原声时间校准失败，已继续使用飞书时间：${friendlyCommandError(error)}`,
    };
  }
}

export async function importLocalMaterial(materialId, report) {
  const directory = materialDir(materialId);
  let material = await readMaterial(materialId);
  const mediaPath = path.join(directory, material.media.file);

  await report("正在检查音视频文件", 0.16);
  const mediaInfo = await probeMedia(mediaPath);
  const transcription = await transcribeMedia(mediaPath, directory, {
    duration: mediaInfo.duration,
    onStage: (stage, progress) => report(stage, progress),
  });
  const sentences = blocksToSentences(transcription.blocks);
  material = await updateMaterial(materialId, (latest) => {
    latest.duration = mediaInfo.duration;
    latest.media = { ...latest.media, ...mediaInfo };
    latest.sentences = sentences;
    latest.paragraphs = buildParagraphs(sentences, 100);
    latest.status = "ready";
    latest.stage = "可以开始精听，讲解正在生成";
    latest.warning = null;
    return latest;
  });
  await addAnalysis(materialId, report);
  return await readMaterial(materialId);
}

export async function addAnalysis(materialId, report) {
  const directory = materialDir(materialId);
  let material = await updateMaterial(materialId, (latest) => {
    latest.analysisStatus = "processing";
    return latest;
  });
  try {
    const learnerProfile = await readLearnerProfile();
    const analyzed = await analyzeMaterial(material, directory, {
      learnerProfile,
      onStage: (stage, progress) => report(stage, progress),
      onBatch: async (partial) => {
        await updateMaterial(materialId, (latest) => {
          latest.sentences = mergeSentenceAnalysis(latest.sentences, partial.sentences);
          latest.overview = partial.overview;
          latest.analysisStatus = "processing";
          latest.status = "ready";
          latest.stage = `讲解已生成 ${partial.completedBatches}/${partial.totalBatches} 批，正在继续`;
        });
      },
    });
    material = await updateMaterial(materialId, (latest) => {
      latest.sentences = mergeSentenceAnalysis(latest.sentences, analyzed.sentences);
      latest.overview = analyzed.overview;
      latest.analysisStatus = analyzed.skipped ? "skipped" : "ready";
      latest.stage = "解析完成";
      latest.status = "ready";
      return latest;
    });
  } catch (error) {
    material = await updateMaterial(materialId, (latest) => {
      latest.analysisStatus = "failed";
      latest.stage = "精听材料已就绪，Codex 讲解生成失败";
      latest.warning = friendlyCommandError(error);
      latest.status = "ready";
      return latest;
    });
  }
}

function mergeSentenceAnalysis(currentSentences = [], analyzedSentences = []) {
  const analysisById = new Map(analyzedSentences.map((sentence) => [sentence.id, sentence.analysis || null]));
  return currentSentences.map((sentence) => (
    analysisById.has(sentence.id)
      ? { ...sentence, analysis: analysisById.get(sentence.id) }
      : sentence
  ));
}
