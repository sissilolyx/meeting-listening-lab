import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { commandExists, parseLastJson, runCommand } from "./lib/commands.mjs";
import { answerLearningQuestion } from "./lib/analysis.mjs";
import { DATA_ROOT, HOST, MAX_UPLOAD_BYTES, MODEL_PATH, PORT, PUBLIC_ROOT } from "./lib/config.mjs";
import { addAnalysis, importLarkMaterial, importLocalMaterial } from "./lib/importers.mjs";
import { createJob, recoverInterruptedJobs } from "./lib/jobs.mjs";
import {
  normalizeKnowledgeText,
  readLearnerProfile,
  removeTooSimpleKnowledge,
  saveTooSimpleKnowledge,
} from "./lib/learner-profile.mjs";
import { modelAvailable } from "./lib/media.mjs";
import { calculateMaterialStudyProgress } from "./lib/progress.mjs";
import { isExpectedClientDisconnect, pipeFileToHttpResponse } from "./lib/http-stream.mjs";
import {
  createMaterial,
  deleteMaterial,
  ensureStorage,
  listMaterials,
  listTrash,
  materialDir,
  purgeExpiredTrash,
  readJob,
  readMaterial,
  removeQaHistoryItem,
  removeReviewItem,
  restoreMaterial,
  saveQaHistoryItem,
  saveReviewItem,
  updateMaterial,
  updateProgress,
  updateSentenceText,
} from "./lib/storage.mjs";
import { extractMinuteToken } from "./lib/transcript.mjs";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

const allowedExtensions = new Set([".mp3", ".m4a", ".wav", ".mp4", ".mov"]);

await ensureStorage();
await purgeExpiredTrash();

const server = http.createServer(async (request, response) => {
  setSecurityHeaders(response);
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/status") {
      return sendJson(response, 200, await getSystemStatus());
    }

    if (request.method === "GET" && url.pathname === "/api/materials") {
      const materials = (await listMaterials()).map(toMaterialSummary);
      return sendJson(response, 200, { materials });
    }

    if (request.method === "GET" && url.pathname === "/api/trash") {
      return sendJson(response, 200, { trash: await listTrash() });
    }

    const trashMatch = url.pathname.match(/^\/api\/trash\/([a-z0-9-]+)\/restore$/i);
    if (request.method === "POST" && trashMatch) {
      const restored = await restoreMaterial(trashMatch[1]);
      return sendJson(response, 200, {
        restored: true,
        material: toMaterialSummary(restored.material),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/learner-profile") {
      return sendJson(response, 200, { profile: await readLearnerProfile() });
    }

    if (request.method === "POST" && url.pathname === "/api/learner-profile/too-simple") {
      const body = await readJson(request);
      const materialId = cleanId(body.materialId, "缺少知识点对应的材料");
      const sentenceId = cleanId(body.sentenceId, "缺少知识点对应的自然句");
      const material = await readMaterial(materialId);
      const sentence = material.sentences.find((item) => item.id === sentenceId);
      if (!sentence) throw httpError(400, "没有找到知识点对应的自然句");
      const text = cleanText(body.text, 300, "知识点不能为空");
      const profile = await saveTooSimpleKnowledge({
        text,
        meaningZh: typeof body.meaningZh === "string" ? body.meaningZh.trim().slice(0, 1000) : "",
        usageZh: typeof body.usageZh === "string" ? body.usageZh.trim().slice(0, 1000) : "",
        context: {
          materialId,
          materialTitle: material.title,
          sentenceId,
          sentenceText: sentence.text,
        },
      });
      const normalizedText = normalizeKnowledgeText(text);
      const feedback = profile.tooSimple.find((item) => item.normalizedText === normalizedText);
      return sendJson(response, 200, { profile, feedback });
    }

    const tooSimpleMatch = url.pathname.match(/^\/api\/learner-profile\/too-simple\/([a-z0-9-]+)$/i);
    if (request.method === "DELETE" && tooSimpleMatch) {
      const profile = await removeTooSimpleKnowledge(tooSimpleMatch[1]);
      return sendJson(response, 200, { profile });
    }

    const materialMatch = url.pathname.match(/^\/api\/materials\/([a-z0-9-]+)$/i);
    if (request.method === "GET" && materialMatch) {
      return sendJson(response, 200, { material: await readMaterial(materialMatch[1]) });
    }
    if (request.method === "PATCH" && materialMatch) {
      const body = await readJson(request);
      const title = cleanText(body.title, 160, "材料标题不能为空");
      const material = await updateMaterial(materialMatch[1], (latest) => {
        latest.title = title;
        return latest;
      });
      return sendJson(response, 200, { material: toMaterialSummary(material) });
    }
    if (request.method === "DELETE" && materialMatch) {
      const deleted = await deleteMaterial(materialMatch[1]);
      return sendJson(response, 200, { trashed: true, materialId: deleted.id, trashEntry: deleted });
    }

    const mediaMatch = url.pathname.match(/^\/api\/materials\/([a-z0-9-]+)\/media$/i);
    if (request.method === "GET" && mediaMatch) {
      return await streamMaterialMedia(request, response, mediaMatch[1]);
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)$/i);
    if (request.method === "GET" && jobMatch) {
      return sendJson(response, 200, { job: await readJob(jobMatch[1]) });
    }

    if (request.method === "POST" && url.pathname === "/api/import/lark") {
      const body = await readJson(request);
      const minuteToken = extractMinuteToken(body.url);
      const material = await createMaterial({
        title: "正在读取飞书妙记",
        sourceType: "lark",
        sourceUrl: body.url,
        minuteToken,
      });
      const job = await createJob("lark-import", material.id, (report) => (
        importLarkMaterial(material.id, body.url, minuteToken, report)
      ));
      return sendJson(response, 202, { material, job });
    }

    if (request.method === "POST" && url.pathname === "/api/import/file") {
      return await receiveLocalFile(request, response, url);
    }

    const progressMatch = url.pathname.match(/^\/api\/materials\/([a-z0-9-]+)\/progress$/i);
    if (request.method === "PATCH" && progressMatch) {
      const body = await readJson(request);
      const ids = Array.isArray(body.segmentIds) ? body.segmentIds.filter(Boolean) : [];
      if (!ids.length) throw httpError(400, "缺少需要保存的句子");
      const patch = {};
      if (["review", "unrated"].includes(body.status)) patch.status = body.status;
      if (typeof body.dictation === "string") patch.dictation = body.dictation.slice(0, 5000);
      if (typeof body.heard === "boolean") patch.heard = body.heard;
      const material = await updateProgress(progressMatch[1], ids, patch);
      return sendJson(response, 200, { material: toMaterialSummary(material) });
    }

    const askMatch = url.pathname.match(/^\/api\/materials\/([a-z0-9-]+)\/ask$/i);
    if (request.method === "POST" && askMatch) {
      const body = await readJson(request);
      const sentenceId = cleanId(body.sentenceId, "缺少问题对应的自然句");
      const selectedText = cleanText(body.selectedText, 300, "请先选择或指定想问的内容");
      const question = cleanText(body.question, 1000, "请输入你的问题");
      const material = await readMaterial(askMatch[1]);
      const answer = await answerLearningQuestion(material, materialDir(material.id), {
        sentenceId,
        selectedText,
        question,
      });
      const history = await saveQaHistoryItem(material.id, sanitizeQaHistoryItem(material, answer));
      return sendJson(response, 200, { answer, historyItem: history.historyItem });
    }

    const qaHistoryMatch = url.pathname.match(/^\/api\/materials\/([a-z0-9-]+)\/qa-history\/([a-z0-9-]+)$/i);
    if (request.method === "DELETE" && qaHistoryMatch) {
      try {
        const material = await removeQaHistoryItem(qaHistoryMatch[1], qaHistoryMatch[2]);
        return sendJson(response, 200, { material });
      } catch (error) {
        if (error.code === "QA_HISTORY_NOT_FOUND") throw httpError(404, "没有找到这条问问记录");
        throw error;
      }
    }

    const reviewItemsMatch = url.pathname.match(/^\/api\/materials\/([a-z0-9-]+)\/review-items$/i);
    if (request.method === "POST" && reviewItemsMatch) {
      const body = await readJson(request);
      const kind = ["phrase", "qa", "paragraph"].includes(body.kind) ? body.kind : null;
      if (!kind) throw httpError(400, "复习内容类型无效");
      const material = await readMaterial(reviewItemsMatch[1]);
      const reviewItem = sanitizeReviewItem(material, body, kind);
      const saved = await saveReviewItem(material.id, reviewItem);
      return sendJson(response, 200, saved);
    }

    const reviewItemMatch = url.pathname.match(/^\/api\/materials\/([a-z0-9-]+)\/review-items\/([a-z0-9-]+)$/i);
    if (request.method === "DELETE" && reviewItemMatch) {
      const material = await removeReviewItem(reviewItemMatch[1], reviewItemMatch[2]);
      return sendJson(response, 200, { material });
    }

    const sentenceMatch = url.pathname.match(/^\/api\/materials\/([a-z0-9-]+)\/sentences\/([a-z0-9-]+)$/i);
    if (request.method === "PATCH" && sentenceMatch) {
      const body = await readJson(request);
      if (typeof body.text !== "string" || !body.text.trim()) throw httpError(400, "原文不能为空");
      const material = await updateSentenceText(sentenceMatch[1], sentenceMatch[2], body.text);
      return sendJson(response, 200, { material });
    }

    const analyzeMatch = url.pathname.match(/^\/api\/materials\/([a-z0-9-]+)\/analyze$/i);
    if (request.method === "POST" && analyzeMatch) {
      const material = await readMaterial(analyzeMatch[1]);
      const job = await createJob("codex-analysis", material.id, (report) => addAnalysis(material.id, report));
      return sendJson(response, 202, { job });
    }

    if (request.method === "GET") return await serveStatic(request, response, url.pathname);
    throw httpError(404, "Not found");
  } catch (error) {
    if (isExpectedClientDisconnect(error, request, response) || response.writableEnded) return;
    if (response.destroyed) {
      console.error("本地服务响应中断：", error);
      return;
    }
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    const status = Number(error.statusCode || (error.code === "ENOENT" ? 404 : 500));
    sendJson(response, status, {
      error: status >= 500 ? "本地服务处理失败" : error.message,
      detail: status >= 500 ? error.message : undefined,
    });
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`原声精听已启动：http://${HOST}:${PORT}`);
  console.log(`本地数据目录：${DATA_ROOT}`);
  try {
    const recovery = await recoverInterruptedJobs((materialId) => (
      createJob("codex-analysis", materialId, (report) => addAnalysis(materialId, report))
    ));
    if (recovery.resumed.length) console.log(`已自动恢复 ${recovery.resumed.length} 个讲解任务`);
  } catch (error) {
    console.error(`恢复中断任务失败：${error?.message || error}`);
  }
});

async function receiveLocalFile(request, response, url) {
  const rawName = url.searchParams.get("filename") || "meeting-audio";
  const decoded = decodeURIComponent(rawName);
  const extension = path.extname(decoded).toLowerCase();
  if (!allowedExtensions.has(extension)) throw httpError(400, "支持 MP3、M4A、WAV、MP4 和 MOV 文件");

  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > MAX_UPLOAD_BYTES) throw httpError(413, "文件超过本地工具的上传上限");

  const safeStem = path.basename(decoded, extension).replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 100) || "meeting";
  const material = await createMaterial({ title: safeStem, sourceType: "local" });
  const relativeMedia = `source${extension}`;
  const target = path.join(materialDir(material.id), relativeMedia);
  let received = 0;
  request.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) request.destroy(httpError(413, "文件超过本地工具的上传上限"));
  });
  await pipeline(request, fs.createWriteStream(target, { flags: "wx" }));

  const savedMaterial = await updateMaterial(material.id, (latest) => {
    latest.media = { file: relativeMedia, kind: null, size: received };
    latest.stage = "文件已保存，等待本地转写";
    return latest;
  });
  const job = await createJob("local-import", material.id, (report) => importLocalMaterial(material.id, report));
  sendJson(response, 202, { material: savedMaterial, job });
}

async function getSystemStatus() {
  const [ffmpeg, ffprobe, whisper, codex, lark, model] = await Promise.all([
    commandExists("ffmpeg"),
    commandExists("ffprobe"),
    commandExists("whisper-cli"),
    commandExists("codex"),
    commandExists("lark-cli"),
    modelAvailable(),
  ]);
  const emptyResult = { stdout: "", stderr: "", code: null };
  const [codexLogin, larkAuth] = await Promise.all([
    codex
      ? runCommand("codex", ["login", "status"], { allowFailure: true, timeoutMs: 10000 }).catch(() => emptyResult)
      : Promise.resolve(emptyResult),
    lark
      ? runCommand("lark-cli", ["auth", "status", "--json"], {
      allowFailure: true,
      timeoutMs: 10000,
      env: { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
        }).catch(() => emptyResult)
      : Promise.resolve(emptyResult),
  ]);
  const codexLoggedIn = /Logged in using ChatGPT/i.test(`${codexLogin.stdout}\n${codexLogin.stderr}`);
  let larkUserReady = false;
  try {
    const envelope = parseLastJson(larkAuth.stdout || larkAuth.stderr);
    larkUserReady = envelope?.identities?.user?.tokenStatus === "valid"
      || envelope?.identities?.user?.status === "ready";
  } catch {
    larkUserReady = false;
  }
  return {
    // Lark is optional: local MP3/M4A/WAV/MP4/MOV imports must work without it.
    ready: Boolean(ffmpeg && ffprobe && whisper && codex && codexLoggedIn && model),
    tools: {
      ffmpeg: Boolean(ffmpeg),
      ffprobe: Boolean(ffprobe),
      whisper: Boolean(whisper),
      whisperModel: model,
      codex: Boolean(codex),
      codexLoggedIn,
      lark: Boolean(lark),
      larkUserReady,
    },
    whisperModelPath: MODEL_PATH,
  };
}

async function streamMaterialMedia(request, response, id) {
  const material = await readMaterial(id);
  if (!material.media?.file) throw httpError(404, "没有找到原始媒体文件");
  const directory = materialDir(id);
  const target = path.resolve(directory, material.media.file);
  if (!target.startsWith(`${directory}${path.sep}`)) throw httpError(400, "Invalid media path");
  const stat = await fsp.stat(target);
  const contentType = mimeTypes[path.extname(target).toLowerCase()] || "application/octet-stream";
  const range = request.headers.range;

  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "private, max-age=3600");

  if (!range) {
    response.writeHead(200, { "Content-Length": stat.size });
    return await pipeFileToHttpResponse(request, response, target);
  }
  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match) throw httpError(416, "Invalid range");
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (start > end || start >= stat.size) throw httpError(416, "Range outside file");
  response.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    "Content-Length": end - start + 1,
  });
  return await pipeFileToHttpResponse(request, response, target, { start, end });
}

async function serveStatic(request, response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(PUBLIC_ROOT, relative);
  if (!target.startsWith(`${PUBLIC_ROOT}${path.sep}`) && target !== path.join(PUBLIC_ROOT, "index.html")) {
    throw httpError(403, "Forbidden");
  }
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    throw httpError(404, "Not found");
  }
  if (!stat.isFile()) throw httpError(404, "Not found");
  response.writeHead(200, {
    "Content-Type": mimeTypes[path.extname(target).toLowerCase()] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": /\.(?:html|css|js)$/.test(relative) ? "no-cache" : "public, max-age=300",
  });
  return await pipeFileToHttpResponse(request, response, target);
}

function toMaterialSummary(material) {
  const studyProgress = calculateMaterialStudyProgress(material);
  const reviewSentenceIds = new Set((material.reviewItems || []).map((item) => item.sentenceId).filter(Boolean));
  const reviewParagraphIds = new Set((material.reviewItems || []).map((item) => item.paragraphId).filter(Boolean));
  const manualReviewIds = new Set(Object.entries(material.progress || {}).filter(([, item]) => item.status === "review").map(([id]) => id));
  return {
    id: material.id,
    title: material.title,
    sourceType: material.sourceType,
    status: material.status,
    stage: material.stage,
    error: material.error,
    warning: material.warning,
    duration: material.duration,
    media: material.media,
    sentenceCount: material.sentences?.length || 0,
    paragraphCount: material.paragraphs?.length || 0,
    reviewCount: new Set([...manualReviewIds, ...reviewSentenceIds, ...reviewParagraphIds]).size,
    ...studyProgress,
    analysisStatus: material.analysisStatus,
    createdAt: material.createdAt,
    updatedAt: material.updatedAt,
  };
}

function sanitizeReviewItem(material, body, kind) {
  const item = { kind };
  if (body.id !== undefined) item.id = cleanId(body.id, "复习记录 ID 无效");
  if (kind === "paragraph") {
    item.paragraphId = cleanId(body.paragraphId, "缺少对应的自然分段");
    if (!material.paragraphs.some((paragraph) => paragraph.id === item.paragraphId)) throw httpError(400, "没有找到对应的自然分段");
    item.sourceText = cleanText(body.sourceText, 10000, "自然分段原文不能为空");
    return item;
  }
  item.sentenceId = cleanId(body.sentenceId, "缺少对应的自然句");
  if (!material.sentences.some((sentence) => sentence.id === item.sentenceId)) throw httpError(400, "没有找到对应的自然句");
  item.sourceText = cleanText(body.sourceText, 500, "复习内容不能为空");
  if (kind === "phrase") {
    item.meaningZh = cleanText(body.meaningZh || "", 1000, "知识点解释不能为空");
    item.usageZh = typeof body.usageZh === "string" ? body.usageZh.trim().slice(0, 1000) : "";
  } else {
    if (body.historyId !== undefined) {
      item.historyId = cleanId(body.historyId, "问问记录 ID 无效");
      const historyItem = (material.qaHistory || []).find((candidate) => candidate.id === item.historyId);
      if (!historyItem || historyItem.sentenceId !== item.sentenceId) throw httpError(400, "没有找到对应的问问记录");
    }
    item.question = cleanText(body.question, 1000, "复习问题不能为空");
    item.answerZh = cleanText(body.answerZh, 5000, "复习答案不能为空");
    item.learningSummaryZh = cleanText(body.learningSummaryZh, 2000, "复习总结不能为空");
    item.grammarPointZh = typeof body.grammarPointZh === "string" ? body.grammarPointZh.trim().slice(0, 1500) : "";
  }
  return item;
}

function sanitizeQaHistoryItem(material, answer) {
  const sentenceId = cleanId(answer.sentenceId, "缺少问题对应的自然句");
  const sentence = material.sentences.find((item) => item.id === sentenceId);
  if (!sentence) throw httpError(400, "没有找到问题对应的自然句");
  const sourceText = cleanText(answer.selectedText, 500, "问问内容不能为空");
  const transcriptStatus = answer.transcriptStatus === "likely_mistranscribed" ? "likely_mistranscribed" : "credible";
  const likelySpokenEnglish = optionalText(answer.likelySpokenEnglish, 1500);
  return {
    sentenceId,
    sentenceText: sentence.text,
    sourceText,
    learningTargetText: transcriptStatus === "likely_mistranscribed" && likelySpokenEnglish
      ? likelySpokenEnglish
      : sourceText,
    question: cleanText(answer.question, 1000, "问问问题不能为空"),
    answerZh: cleanText(answer.answerZh, 5000, "问问答案不能为空"),
    learningSummaryZh: cleanText(answer.learningSummaryZh, 2000, "问问总结不能为空"),
    grammarPointZh: optionalText(answer.grammarPointZh, 1500),
    transcriptStatus,
    likelySpokenEnglish,
    intendedMeaningZh: optionalText(answer.intendedMeaningZh, 2000),
  };
}

function optionalText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanText(value, maxLength, message) {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, message);
  return value.trim().slice(0, maxLength);
}

function cleanId(value, message) {
  if (typeof value !== "string" || !/^[a-z0-9-]+$/i.test(value)) throw httpError(400, message);
  return value;
}

async function readJson(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, "请求内容过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "请求格式不是有效 JSON");
  }
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function setSecurityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; media-src 'self' blob:; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

let shutdownStarted = false;

function shutdownServer() {
  if (shutdownStarted) return;
  shutdownStarted = true;

  server.close(() => process.exit(0));
  server.closeIdleConnections?.();

  const closeConnectionsTimer = setTimeout(() => {
    server.closeAllConnections?.();
  }, 750);
  closeConnectionsTimer.unref();

  const forceExitTimer = setTimeout(() => process.exit(0), 2500);
  forceExitTimer.unref();
}

process.on("SIGTERM", shutdownServer);
process.on("SIGINT", shutdownServer);
