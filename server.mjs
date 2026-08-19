import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { commandExists, parseLastJson, runCommand } from "./lib/commands.mjs";
import { answerLearningQuestion, answerPhraseGuide } from "./lib/analysis.mjs";
import { assertProviderSelectionAvailable, getAiProviderStatuses, testAiProviderSelection } from "./lib/ai-providers.mjs";
import { captureAiSettings, readAiSettings, saveAiSettings, validateAiSettingsInput } from "./lib/ai-settings.mjs";
import { DATA_ROOT, HOST, MAX_UPLOAD_BYTES, MODEL_PATH, PORT, PUBLIC_ROOT } from "./lib/config.mjs";
import { addAnalysis, importLarkMaterial, importLocalMaterial } from "./lib/importers.mjs";
import { createJob, recoverInterruptedJobs } from "./lib/jobs.mjs";
import {
  normalizeKnowledgeText,
  PHRASE_SIGNAL_EVENTS,
  readLearnerProfile,
  recordPhraseSignal,
  removeTooSimpleKnowledge,
  saveTooSimpleKnowledge,
} from "./lib/learner-profile.mjs";
import { modelAvailable } from "./lib/media.mjs";
import { calculateMaterialStudyProgress } from "./lib/progress.mjs";
import { buildReviewQueue } from "./lib/review-queue.mjs";
import { isExpectedClientDisconnect, pipeFileToHttpResponse } from "./lib/http-stream.mjs";
import {
  createMaterial,
  deleteMaterial,
  ensureStorage,
  listMaterials,
  listTrash,
  materialDir,
  purgeExpiredTrash,
  phraseGuideKey,
  readJob,
  readMaterial,
  removeQaHistoryItem,
  removeReviewItem,
  restoreMaterial,
  saveQaHistoryItem,
  savePhraseGuideItem,
  saveReviewItem,
  updateMaterial,
  updateMaterialLearningState,
  updateProgress,
  updateSentenceText,
} from "./lib/storage.mjs";
import { extractMinuteToken } from "./lib/transcript.mjs";
import { ASK_ANCHOR_SURFACES } from "./public/ask-text-anchor-utils.js";

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
const LOCAL_ORIGIN = `http://${HOST}:${PORT}`;
const LOCAL_HOST = new URL(LOCAL_ORIGIN).host.toLowerCase();

await ensureStorage();
await purgeExpiredTrash();

const server = http.createServer(async (request, response) => {
  setSecurityHeaders(response);
  const url = new URL(request.url, LOCAL_ORIGIN);

  try {
    enforceLocalRequestHost(request);
    enforceLocalMutationRequest(request, url);
    if (request.method === "GET" && url.pathname === "/api/status") {
      return sendJson(response, 200, await getSystemStatus());
    }

    if (request.method === "GET" && url.pathname === "/api/ai-settings") {
      const [settings, providers] = await Promise.all([readAiSettings(), getAiProviderStatuses()]);
      return sendJson(response, 200, { settings, providers });
    }

    if (request.method === "PATCH" && url.pathname === "/api/ai-settings") {
      const requested = validateAiSettingsInput(await readJson(request));
      const providers = await getAiProviderStatuses();
      const selection = assertProviderSelectionAvailable(requested, providers);
      const settings = await saveAiSettings(selection);
      return sendJson(response, 200, { settings, providers });
    }

    if (request.method === "POST" && url.pathname === "/api/ai-settings/test") {
      const requested = validateAiSettingsInput(await readJson(request));
      const selection = assertProviderSelectionAvailable(requested, await getAiProviderStatuses());
      const result = await testAiProviderSelection(selection);
      return sendJson(response, 200, { ok: true, provider: selection.provider, model: selection.model, result });
    }

    if (request.method === "GET" && url.pathname === "/api/materials") {
      const materials = (await listMaterials()).map(toMaterialSummary);
      return sendJson(response, 200, { materials });
    }

    if (request.method === "GET" && url.pathname === "/api/review-queue") {
      const requestedMaterialId = url.searchParams.get("materialId");
      const materialId = requestedMaterialId === null
        ? null
        : cleanId(requestedMaterialId, "复习范围对应的材料无效");
      const materials = materialId ? [await readMaterial(materialId)] : await listMaterials();
      const items = buildReviewQueue(materials);
      return sendJson(response, 200, {
        scope: materialId ? { type: "material", materialId } : { type: "all", materialId: null },
        total: items.length,
        items,
      });
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

    if (request.method === "POST" && url.pathname === "/api/learner-profile/phrase-signals") {
      const body = await readJson(request);
      const event = PHRASE_SIGNAL_EVENTS.includes(body.event) ? body.event : null;
      if (!event) throw httpError(400, "表达学习信号无效");
      const materialId = cleanId(body.materialId, "缺少表达对应的材料");
      const sentenceId = cleanId(body.sentenceId, "缺少表达对应的自然句");
      const phraseText = cleanText(body.phraseText, 300, "表达不能为空");
      const sessionId = event === "exposed"
        ? cleanPhraseSignalSessionId(body.sessionId)
        : "";
      const material = await readMaterial(materialId);
      const result = await saveValidatedPhraseSignal({
        event,
        material,
        sentenceId,
        phraseText,
        sessionId,
      });
      return sendJson(response, 200, result);
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
      const aiSettings = await captureAnalysisSelection();
      const material = await createMaterial({
        title: "正在读取飞书妙记",
        sourceType: "lark",
        sourceUrl: body.url,
        minuteToken,
      });
      const job = await createJob("lark-import", material.id, (report) => (
        importLarkMaterial(material.id, body.url, minuteToken, report, { aiSettings })
      ), { aiSettings });
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

    const learningStateMatch = url.pathname.match(/^\/api\/materials\/([a-z0-9-]+)\/learning-state$/i);
    if (request.method === "PATCH" && learningStateMatch) {
      const body = await readJson(request);
      if (typeof body.completed !== "boolean") throw httpError(400, "已学完状态必须是布尔值");
      const material = await updateMaterialLearningState(learningStateMatch[1], {
        completed: body.completed,
      });
      return sendJson(response, 200, { material: toMaterialSummary(material) });
    }

    const askMatch = url.pathname.match(/^\/api\/materials\/([a-z0-9-]+)\/ask$/i);
    if (request.method === "POST" && askMatch) {
      const body = await readJson(request);
      const sentenceId = cleanId(body.sentenceId, "缺少问题对应的自然句");
      const selectedText = cleanText(body.selectedText, 300, "请先选择或指定想问的内容");
      const question = cleanText(body.question, 1000, "请输入你的问题");
      const textAnchor = sanitizeQaTextAnchor(body);
      const aiSettings = await captureAiSettings();
      const material = await readMaterial(askMatch[1]);
      if (findAnalyzedPhrase(material, sentenceId, selectedText)) {
        await saveValidatedPhraseSignal({
          event: "asked",
          material,
          sentenceId,
          phraseText: selectedText,
        });
      }
      const answer = await answerLearningQuestion(material, materialDir(material.id), {
        sentenceId,
        selectedText,
        question,
      }, { aiSettings });
      const history = await saveQaHistoryItem(material.id, sanitizeQaHistoryItem(material, answer, textAnchor));
      return sendJson(response, 200, { answer, historyItem: history.historyItem });
    }

    const phraseGuideMatch = url.pathname.match(/^\/api\/materials\/([a-z0-9-]+)\/phrase-guides$/i);
    if (request.method === "POST" && phraseGuideMatch) {
      const body = await readJson(request);
      const sentenceId = cleanId(body.sentenceId, "缺少表达对应的自然句");
      const phraseText = cleanText(body.phraseText, 300, "表达不能为空");
      if (typeof body.expectedSentenceText !== "string" || !body.expectedSentenceText.trim()) {
        throw httpError(400, "缺少表达对应的原句版本");
      }
      const expectedSentenceText = body.expectedSentenceText.trim();
      const material = await readMaterial(phraseGuideMatch[1]);
      const sentence = material.sentences.find((item) => item.id === sentenceId);
      if (!sentence) throw httpError(400, "没有找到表达对应的自然句");
      if (sentence.text !== expectedSentenceText) {
        return sendJson(response, 409, {
          error: "原句已发生变化，请按最新原文重新展开讲解",
          currentSentenceText: sentence.text,
        });
      }
      const phrase = (sentence.analysis?.phrases || []).find((item) => (
        String(item.text || "").trim() === phraseText
      ));
      if (!phrase) throw httpError(400, "这条表达已不在当前句子的讲解中");
      await saveValidatedPhraseSignal({
        event: "guide_opened",
        material,
        sentenceId,
        phraseText,
      });
      const key = phraseGuideKey(sentenceId, phraseText);
      const cached = (material.phraseGuides || []).find((item) => (
        (item.key || phraseGuideKey(item.sentenceId, item.phraseText)) === key
        && item.sourceSentenceText === sentence.text
      ));
      if (cached) return sendJson(response, 200, { phraseGuide: cached, cached: true });

      const aiSettings = await captureAiSettings();
      const generated = await answerPhraseGuide(material, materialDir(material.id), {
        sentenceId,
        phraseText,
        meaningZh: String(phrase.meaningZh || ""),
        usageZh: String(phrase.usageZh || ""),
      }, { aiSettings });
      try {
        const saved = await savePhraseGuideItem(material.id, {
          ...generated,
          sentenceId,
          phraseText,
          sourceSentenceText: sentence.text,
          meaningZh: String(phrase.meaningZh || ""),
        });
        return sendJson(response, 200, { phraseGuide: saved.phraseGuide, cached: false });
      } catch (error) {
        if (error.code === "PHRASE_GUIDE_SENTENCE_CONFLICT") {
          return sendJson(response, 409, {
            error: "原句已发生变化，请按最新原文重新展开讲解",
            currentSentenceText: error.currentSentenceText,
          });
        }
        if (error.code === "PHRASE_GUIDE_PHRASE_CONFLICT") {
          throw httpError(409, "这条表达的句子讲解已更新，请重新展开");
        }
        throw error;
      }
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
      if (kind === "phrase" && findAnalyzedPhrase(material, reviewItem.sentenceId, reviewItem.sourceText)) {
        await saveValidatedPhraseSignal({
          event: "review_added",
          material,
          sentenceId: reviewItem.sentenceId,
          phraseText: reviewItem.sourceText,
        });
      }
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
      if (typeof body.expectedText !== "string") throw httpError(400, "缺少待修正原文的版本信息");
      let updated;
      try {
        updated = await updateSentenceText(sentenceMatch[1], sentenceMatch[2], body.text, {
          expectedText: body.expectedText,
        });
      } catch (error) {
        if (error.code !== "SENTENCE_EDIT_CONFLICT") throw error;
        return sendJson(response, 409, {
          error: "这句原文已在别处被修改，请按当前版本重新修正",
          currentText: error.currentText,
        });
      }
      let job = null;
      let warning = "";
      if (updated.changed) {
        try {
          job = await createAnalysisJob(updated.material.id, { enqueueAfterActive: true });
        } catch (error) {
          if (error.statusCode !== 409) throw error;
          warning = `${error.message}；原文已保存，讲解仍为待生成状态。`;
        }
      }
      return sendJson(response, 200, { material: updated.material, job, ...(warning ? { warning } : {}) });
    }

    const analyzeMatch = url.pathname.match(/^\/api\/materials\/([a-z0-9-]+)\/analyze$/i);
    if (request.method === "POST" && analyzeMatch) {
      const material = await readMaterial(analyzeMatch[1]);
      const job = await createAnalysisJob(material.id);
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
    const recovery = await recoverInterruptedJobs((materialId, aiSettings) => (
      createAnalysisJob(materialId, {}, aiSettings)
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
  const aiSettings = await captureAnalysisSelection();

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
  const job = await createJob("local-import", material.id, (report) => (
    importLocalMaterial(material.id, report, { aiSettings })
  ), { aiSettings });
  sendJson(response, 202, { material: savedMaterial, job });
}

async function createAnalysisJob(materialId, options = {}, frozenAiSettings = undefined) {
  const aiSettings = frozenAiSettings === undefined
    ? await captureAnalysisSelection()
    : frozenAiSettings;
  return createJob(
    "codex-analysis",
    materialId,
    (report) => addAnalysis(materialId, report, { aiSettings }),
    { ...options, aiSettings },
  );
}

async function captureAnalysisSelection() {
  return process.env.SKIP_CODEX_ANALYSIS === "1" ? null : captureAiSettings();
}

function enforceLocalRequestHost(request) {
  const host = String(request.headers.host || "").trim().toLowerCase();
  if (host !== LOCAL_HOST) throw httpError(403, "只允许通过本地固定地址访问");
}

function enforceLocalMutationRequest(request, url) {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method || "")) return;
  const fetchSite = String(request.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite === "cross-site") throw httpError(403, "只允许从本地网页发起修改请求");
  const origin = String(request.headers.origin || "").trim();
  if (origin && origin !== LOCAL_ORIGIN) throw httpError(403, "只允许从本地网页发起修改请求");

  const requiresJson = request.method === "PATCH"
    || (request.method === "POST"
      && url.pathname !== "/api/import/file"
      && !/^\/api\/trash\/[a-z0-9-]+\/restore$/i.test(url.pathname));
  if (!requiresJson) return;
  const contentType = String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw httpError(415, "修改请求必须使用 application/json");
}

async function getSystemStatus() {
  const [ffmpeg, ffprobe, whisper, lark, model, settings, providers] = await Promise.all([
    commandExists("ffmpeg"),
    commandExists("ffprobe"),
    commandExists("whisper-cli"),
    commandExists("lark-cli"),
    modelAvailable(),
    readAiSettings(),
    getAiProviderStatuses(),
  ]);
  const emptyResult = { stdout: "", stderr: "", code: null };
  const larkAuth = await (lark
    ? runCommand("lark-cli", ["auth", "status", "--json"], {
      allowFailure: true,
      timeoutMs: 10000,
      env: { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
    }).catch(() => emptyResult)
    : Promise.resolve(emptyResult));
  let larkUserReady = false;
  try {
    const envelope = parseLastJson(larkAuth.stdout || larkAuth.stderr);
    larkUserReady = envelope?.identities?.user?.tokenStatus === "valid"
      || envelope?.identities?.user?.status === "ready";
  } catch {
    larkUserReady = false;
  }
  const selectedProvider = settings.configured ? providers[settings.provider] : null;
  const selectedModels = new Set((selectedProvider?.models || []).map((item) => typeof item === "string" ? item : item?.id));
  const aiReady = Boolean(
    settings.configured
    && selectedProvider?.installed
    && selectedProvider?.authenticated
    && selectedModels.has(settings.model),
  );
  const coreReady = Boolean(ffmpeg && ffprobe && whisper && model);
  return {
    // Lark is optional: local MP3/M4A/WAV/MP4/MOV imports must work without it.
    // AI onboarding is independent so an unconfigured user can still open this local page and choose an account.
    ready: coreReady,
    coreReady,
    aiReady,
    ai: { settings, providers },
    tools: {
      ffmpeg: Boolean(ffmpeg),
      ffprobe: Boolean(ffprobe),
      whisper: Boolean(whisper),
      whisperModel: model,
      codex: providers.codex.installed,
      codexLoggedIn: providers.codex.authenticated,
      cursor: providers.cursor.installed,
      cursorLoggedIn: providers.cursor.authenticated,
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
    completed: material.completed === true,
    completedAt: material.completed === true && typeof material.completedAt === "string"
      ? material.completedAt
      : null,
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

function sanitizeQaHistoryItem(material, answer, textAnchor = {}) {
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
    aiProvider: answer.aiProvider,
    ...textAnchor,
  };
}

function sanitizeQaTextAnchor(body) {
  const anchorKeys = [
    "anchorSurface",
    "anchorSurfaceText",
    "anchorStart",
    "anchorEnd",
    "anchorExact",
    "anchorPrefix",
    "anchorSuffix",
    "prefix",
    "suffix",
  ];
  if (!anchorKeys.some((key) => body[key] !== undefined)) return {};

  if (typeof body.anchorSurface !== "string" || !ASK_ANCHOR_SURFACES.includes(body.anchorSurface)) {
    throw httpError(400, "问问锚点所在区域无效");
  }
  const anchorSurfaceText = optionalAnchorText(body.anchorSurfaceText, 20000, "问问锚点原文无效");
  const anchorExact = optionalAnchorText(body.anchorExact, 500, "问问锚点选区无效");
  const anchorPrefix = optionalAnchorText(body.anchorPrefix ?? body.prefix, 256, "问问锚点前文无效");
  const anchorSuffix = optionalAnchorText(body.anchorSuffix ?? body.suffix, 256, "问问锚点后文无效");
  const hasStart = body.anchorStart !== undefined;
  const hasEnd = body.anchorEnd !== undefined;
  if (hasStart !== hasEnd) throw httpError(400, "问问锚点起止位置不完整");
  const anchorStart = hasStart ? cleanNonNegativeInteger(body.anchorStart, "问问锚点起始位置无效") : null;
  const anchorEnd = hasEnd ? cleanNonNegativeInteger(body.anchorEnd, "问问锚点结束位置无效") : null;
  if (anchorStart !== null && anchorEnd <= anchorStart) throw httpError(400, "问问锚点结束位置无效");
  if (anchorSurfaceText && anchorEnd !== null && anchorEnd > anchorSurfaceText.length) {
    throw httpError(400, "问问锚点超出原文范围");
  }
  if (anchorSurfaceText && anchorExact && anchorStart !== null
    && anchorSurfaceText.slice(anchorStart, anchorEnd) !== anchorExact) {
    throw httpError(400, "问问锚点与选区内容不一致");
  }

  return {
    anchorSurface: body.anchorSurface,
    ...(anchorSurfaceText ? { anchorSurfaceText } : {}),
    ...(anchorStart !== null ? { anchorStart, anchorEnd } : {}),
    ...(anchorExact ? { anchorExact } : {}),
    ...(anchorPrefix ? { prefix: anchorPrefix } : {}),
    ...(anchorSuffix ? { suffix: anchorSuffix } : {}),
  };
}

async function saveValidatedPhraseSignal({ event, material, sentenceId, phraseText, sessionId = "" }) {
  const sentence = material.sentences.find((item) => item.id === sentenceId);
  if (!sentence) throw httpError(400, "没有找到表达对应的自然句");
  const phrase = findAnalyzedPhrase(material, sentenceId, phraseText);
  if (!phrase) throw httpError(400, "这条表达已不在当前句子的讲解中");
  const signalInput = {
    event,
    sessionId,
    text: String(phrase.text || "").trim(),
    meaningZh: String(phrase.meaningZh || "").trim(),
    usageZh: String(phrase.usageZh || "").trim(),
    context: {
      materialId: material.id,
      sentenceId,
    },
  };
  if (event === "exposed") {
    const normalizedPhrase = normalizeKnowledgeText(signalInput.text);
    const hasSavedGuide = (material.phraseGuides || []).some((guide) => (
      guide.sentenceId === sentenceId
      && normalizeKnowledgeText(guide.phraseText) === normalizedPhrase
    ));
    const hasSavedReview = (material.reviewItems || []).some((item) => (
      item.kind === "phrase"
      && item.sentenceId === sentenceId
      && normalizeKnowledgeText(item.sourceText) === normalizedPhrase
    ));
    const hasSavedQuestion = (material.qaHistory || []).some((item) => (
      item.sentenceId === sentenceId
      && [item.sourceText, item.learningTargetText].some((text) => normalizeKnowledgeText(text) === normalizedPhrase)
    ));
    for (const counterEvent of [
      ...(hasSavedGuide ? ["guide_opened"] : []),
      ...(hasSavedReview ? ["review_added"] : []),
      ...(hasSavedQuestion ? ["asked"] : []),
    ]) {
      await recordPhraseSignal({ ...signalInput, event: counterEvent, sessionId: "" });
    }
  }
  return recordPhraseSignal(signalInput);
}

function findAnalyzedPhrase(material, sentenceId, phraseText) {
  const sentence = material.sentences.find((item) => item.id === sentenceId);
  if (!sentence) return null;
  const exactText = String(phraseText || "").trim();
  return (sentence.analysis?.phrases || []).find((item) => (
    String(item.text || "").trim() === exactText
  )) || null;
}

function cleanPhraseSignalSessionId(value) {
  if (typeof value !== "string" || !/^[a-z0-9._:-]{1,160}$/i.test(value)) {
    throw httpError(400, "表达曝光缺少有效的会话标识");
  }
  return value;
}

function optionalAnchorText(value, maxLength, message) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw httpError(400, message);
  return value.slice(0, maxLength);
}

function cleanNonNegativeInteger(value, message) {
  if (!Number.isInteger(value) || value < 0) throw httpError(400, message);
  return value;
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
