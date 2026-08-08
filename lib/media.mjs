import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MODEL_PATH } from "./config.mjs";
import { parseLastJson, runCommand } from "./commands.mjs";
import { parseWhisperJson } from "./transcript.mjs";

export async function probeMedia(filePath) {
  const result = await runCommand("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size,format_name",
    "-show_entries", "stream=index,codec_type,codec_name,channels,sample_rate,width,height",
    "-of", "json",
    filePath,
  ]);
  const payload = JSON.parse(result.stdout);
  const streams = payload.streams || [];
  const video = streams.find((stream) => stream.codec_type === "video") || null;
  const audio = streams.find((stream) => stream.codec_type === "audio") || null;
  if (!audio) throw new Error("没有在文件中检测到可播放的音轨");
  return {
    duration: Number(payload.format?.duration || 0),
    size: Number(payload.format?.size || 0),
    format: payload.format?.format_name || "unknown",
    kind: video ? "video" : "audio",
    video: video ? {
      codec: video.codec_name,
      width: Number(video.width || 0),
      height: Number(video.height || 0),
    } : null,
    audio: {
      codec: audio.codec_name,
      channels: Number(audio.channels || 0),
      sampleRate: Number(audio.sample_rate || 0),
    },
  };
}

export async function modelAvailable(modelPath = MODEL_PATH) {
  try {
    const stat = await fs.stat(modelPath);
    return stat.isFile() && stat.size > 1024 * 1024;
  } catch {
    return false;
  }
}

export async function transcribeMedia(filePath, workDir, options = {}) {
  const modelPath = options.modelPath || MODEL_PATH;
  if (!(await modelAvailable(modelPath))) {
    throw new Error(`本地 Whisper 模型尚未安装：${modelPath}`);
  }

  const transcriptDir = path.join(workDir, "whisper");
  await fs.mkdir(transcriptDir, { recursive: true });
  const wavPath = path.join(transcriptDir, "audio-16k.wav");
  const outputBase = path.join(transcriptDir, "transcript");

  options.onStage?.("正在提取原始音轨", 0.42);
  await runCommand("ffmpeg", [
    "-y", "-v", "error", "-i", filePath,
    "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath,
  ], { cwd: workDir });

  options.onStage?.("本地 Whisper 正在生成精确时间戳", 0.52);
  await runCommand("whisper-cli", [
    "-m", modelPath,
    "-f", wavPath,
    "-l", "en",
    "-ojf",
    "-sow",
    "-ng",
    "-nfa",
    "-t", String(options.threads || 10),
    "-np",
    "-of", outputBase,
  ], {
    cwd: workDir,
    timeoutMs: options.timeoutMs || 2 * 60 * 60 * 1000,
    onOutput: options.onOutput,
  });

  const jsonPath = `${outputBase}.json`;
  const payload = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  const blocks = parseWhisperJson(payload, options.duration);
  if (!blocks.length) throw new Error("Whisper 没有从文件中识别出英文语音");

  if (!options.keepIntermediate) {
    await fs.rm(wavPath, { force: true });
  }
  return { blocks, jsonPath };
}

export async function transcribeMediaRange(filePath, workDir, options = {}) {
  const modelPath = options.modelPath || MODEL_PATH;
  if (!(await modelAvailable(modelPath))) {
    throw new Error(`本地 Whisper 模型尚未安装：${modelPath}`);
  }

  const start = Math.max(0, Number(options.start || 0));
  const end = Math.max(start + 0.25, Number(options.end || start + 0.25));
  const rangeDir = path.join(workDir, "whisper-ranges", randomUUID());
  const wavPath = path.join(rangeDir, "audio.wav");
  const outputBase = path.join(rangeDir, "transcript");
  await fs.mkdir(rangeDir, { recursive: true });

  try {
    await runCommand("ffmpeg", [
      "-y", "-v", "error",
      "-ss", String(start),
      "-t", String(end - start),
      "-i", filePath,
      "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath,
    ], { cwd: workDir });

    await runCommand("whisper-cli", [
      "-m", modelPath,
      "-f", wavPath,
      "-l", "en",
      "-ojf",
      "-sow",
      "-ng",
      "-nfa",
      "-t", String(options.threads || 10),
      "-np",
      "-of", outputBase,
    ], {
      cwd: workDir,
      timeoutMs: options.timeoutMs || 20 * 60 * 1000,
      onOutput: options.onOutput,
    });

    const payload = JSON.parse(await fs.readFile(`${outputBase}.json`, "utf8"));
    const blocks = parseWhisperJson(payload, end - start).map((block) => ({
      ...block,
      start: Math.round((block.start + start) * 1000) / 1000,
      end: Math.round((block.end + start) * 1000) / 1000,
    }));
    return { blocks };
  } finally {
    await fs.rm(rangeDir, { recursive: true, force: true });
  }
}

export function parseCommandEnvelope(result) {
  for (const value of [result.stdout, result.stderr, `${result.stderr}\n${result.stdout}`]) {
    try {
      return parseLastJson(value);
    } catch {
      // Try the next stream order.
    }
  }
  throw new Error("无法读取命令返回结果");
}

export function attachSpeakers(blocks, speakerBlocks) {
  if (!speakerBlocks?.length) return blocks;
  return blocks.map((block) => {
    const midpoint = block.start + (block.end - block.start) / 2;
    const match = speakerBlocks.find((item) => midpoint >= item.start && midpoint < item.end)
      || speakerBlocks.reduce((best, item) => {
        const distance = Math.abs(item.start - midpoint);
        return !best || distance < best.distance ? { item, distance } : best;
      }, null)?.item;
    return { ...block, speaker: match?.speaker || block.speaker };
  });
}
