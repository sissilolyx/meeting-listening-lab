import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { APP_ROOT, MODEL_PATH } from "../lib/config.mjs";

const defaultModelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin";
const defaultModelSha256 = "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d";
const modelUrl = process.env.WHISPER_MODEL_URL || defaultModelUrl;
const expectedSha256 = String(
  process.env.WHISPER_MODEL_SHA256 || (modelUrl === defaultModelUrl ? defaultModelSha256 : "")
).trim().toLowerCase();

await fs.mkdir(path.dirname(MODEL_PATH), { recursive: true });
try {
  const existing = await fs.stat(MODEL_PATH);
  if (existing.size > 100 * 1024 * 1024) {
    if (expectedSha256) {
      const existingSha256 = await sha256File(MODEL_PATH);
      if (existingSha256 !== expectedSha256) {
        throw new Error(
          `现有 Whisper 模型校验失败。请删除 ${path.relative(APP_ROOT, MODEL_PATH)} 后重新运行下载。`
        );
      }
    }
    console.log(`Whisper 模型已经存在：${path.relative(APP_ROOT, MODEL_PATH)}`);
    process.exit(0);
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  // Download below when the model does not exist yet.
}

const temporary = `${MODEL_PATH}.partial`;
console.log("正在下载 Whisper small.en 模型（约 466 MB）…");
const response = await fetch(modelUrl, { redirect: "follow" });
if (!response.ok || !response.body) throw new Error(`模型下载失败：HTTP ${response.status}`);
const expected = Number(response.headers.get("content-length") || 0);
let received = 0;
let lastPercent = -1;
const hash = createHash("sha256");
const stream = Readable.fromWeb(response.body);
stream.on("data", (chunk) => {
  received += chunk.length;
  hash.update(chunk);
  if (!expected) return;
  const percent = Math.floor((received / expected) * 100);
  if (percent >= lastPercent + 5) {
    lastPercent = percent;
    console.log(`${percent}%`);
  }
});
await pipeline(stream, (await import("node:fs")).createWriteStream(temporary));
if (received < 100 * 1024 * 1024) {
  await fs.rm(temporary, { force: true });
  throw new Error("下载到的模型文件异常小，已删除临时文件");
}
const downloadedSha256 = hash.digest("hex");
if (expectedSha256 && downloadedSha256 !== expectedSha256) {
  await fs.rm(temporary, { force: true });
  throw new Error(`模型 SHA-256 校验失败（收到 ${downloadedSha256}），已删除临时文件`);
}
await fs.rename(temporary, MODEL_PATH);
console.log(`模型已保存：${path.relative(APP_ROOT, MODEL_PATH)}`);

function sha256File(target) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = fsSync.createReadStream(target);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}
