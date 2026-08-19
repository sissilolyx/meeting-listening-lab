import {
  createId,
  listJobs,
  listMaterials,
  readMaterial,
  saveJob,
  updateMaterial,
} from "./storage.mjs";
import { needsSpokenFormAnalysis } from "./analysis.mjs";

const activeJobs = new Map();
const queuedJobs = new Map();

function activeJobKey(kind, materialId) {
  return `${kind}:${materialId}`;
}

export async function createJob(kind, materialId, runner, options = {}) {
  const key = activeJobKey(kind, materialId);
  const existing = activeJobs.get(key);
  if (existing) {
    if (!options.enqueueAfterActive) return existing;
    const alreadyQueued = queuedJobs.get(key);
    if (alreadyQueued) return alreadyQueued.job;
    const job = createJobRecord(kind, materialId, "等待上一轮讲解完成", options.aiSettings);
    queuedJobs.set(key, { job, runner });
    try {
      await saveJob(job);
    } catch (error) {
      queuedJobs.delete(key);
      throw error;
    }
    if (!activeJobs.has(key) && queuedJobs.get(key)?.job.id === job.id) {
      queuedJobs.delete(key);
      startJob(kind, materialId, runner, job);
    }
    return job;
  }

  const job = createJobRecord(kind, materialId, "等待开始", options.aiSettings);
  activeJobs.set(key, job);
  try {
    await saveJob(job);
  } catch (error) {
    activeJobs.delete(key);
    throw error;
  }
  startJob(kind, materialId, runner, job);
  return job;
}

function createJobRecord(kind, materialId, stage = "等待开始", aiSettings = null) {
  const now = new Date().toISOString();
  return {
    id: createId("job"),
    kind,
    materialId,
    status: "queued",
    stage,
    progress: 0,
    error: null,
    aiProvider: normalizeAiProvider(aiSettings),
    createdAt: now,
    updatedAt: now,
  };
}

function startJob(kind, materialId, runner, job) {
  const key = activeJobKey(kind, materialId);
  activeJobs.set(key, job);
  setImmediate(async () => {
    const report = async (stage, progress) => {
      job.status = "running";
      job.stage = stage;
      job.progress = Math.max(job.progress, Number(progress || 0));
      job.updatedAt = new Date().toISOString();
      await saveJob(job);
      await updateMaterial(materialId, (material) => {
        material.stage = stage;
        material.status = material.status === "ready" ? "ready" : "processing";
      });
    };

    try {
      await report("开始处理", 0.02);
      await runner(report);
      if (kind === "codex-analysis") {
        const material = await readMaterial(materialId);
        if (material.analysisStatus === "failed") {
          throw new Error(material.warning || "AI 讲解生成失败");
        }
      }
      job.status = "completed";
      job.stage = "处理完成";
      job.progress = 1;
    } catch (error) {
      job.status = "failed";
      job.stage = "处理失败";
      job.error = error?.message || String(error);
      try {
        await updateMaterial(materialId, (material) => {
          if (kind === "codex-analysis" || material.status === "ready") {
            material.status = "ready";
            if (kind === "codex-analysis") material.analysisStatus = "failed";
            material.stage = "精听材料已就绪，AI 讲解生成失败";
            material.warning = job.error;
          } else {
            material.status = "failed";
            material.stage = "处理失败";
            material.error = job.error;
          }
        });
      } catch {
        // The material may have been removed outside the app.
      }
    }
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
    activeJobs.delete(key);
    const queued = queuedJobs.get(key);
    if (queued) {
      queuedJobs.delete(key);
      startJob(kind, materialId, queued.runner, queued.job);
    }
  });
}

export async function recoverInterruptedJobs(resumeAnalysis) {
  const interruptedAt = new Date().toISOString();
  const jobs = await listJobs();
  const interrupted = jobs.filter((job) => job.status === "queued" || job.status === "running");
  const recoveryJobByMaterial = new Map();
  for (const job of interrupted
    .filter((item) => item.kind === "codex-analysis" && normalizeAiProvider(item.aiProvider))
    .sort(compareRecoveryJobs)) {
    if (!recoveryJobByMaterial.has(job.materialId)) recoveryJobByMaterial.set(job.materialId, job);
  }

  for (const job of interrupted) {
    job.status = "failed";
    job.stage = "本地服务曾中断，旧任务已停止";
    job.error = "本地服务在任务完成前退出";
    job.updatedAt = interruptedAt;
    await saveJob(job);
  }

  const resumed = [];
  const materials = await listMaterials();
  for (const material of materials) {
    if (!["pending", "processing"].includes(material.analysisStatus)) continue;

    const readyForAnalysis = material.status === "ready" && material.sentences?.length;
    const stillNeedsAnalysis = readyForAnalysis && material.sentences.some(needsSpokenFormAnalysis);

    if (stillNeedsAnalysis) {
      const matchingJob = recoveryJobByMaterial.get(material.id);
      const aiSettings = normalizeAiProvider(matchingJob?.aiProvider);
      if (!aiSettings) {
        await updateMaterial(material.id, (latest) => {
          latest.stage = "讲解生成曾中断，请手动重新开始";
          latest.warning = "中断任务没有保存 AI provider 与模型，已停止自动恢复";
          latest.error = null;
        });
        continue;
      }
      await updateMaterial(material.id, (latest) => {
        latest.stage = "讲解生成曾中断，正在自动恢复";
        latest.warning = null;
        latest.error = null;
      });
      resumed.push(await resumeAnalysis(material.id, aiSettings));
      continue;
    }

    if (readyForAnalysis) {
      await updateMaterial(material.id, (latest) => {
        latest.analysisStatus = "ready";
        latest.stage = "解析完成";
        latest.warning = null;
        latest.error = null;
      });
      continue;
    }

    if (material.analysisStatus !== "processing") continue;

    await updateMaterial(material.id, (latest) => {
      latest.status = "failed";
      latest.stage = "导入曾被中断，请重新导入";
      latest.error = "本地服务在材料导入完成前退出";
    });
  }

  return { interrupted, resumed };
}

function normalizeAiProvider(value) {
  if (!value || !["codex", "cursor"].includes(value.provider)) return null;
  if (typeof value.model !== "string" || !value.model.trim()) return null;
  return { provider: value.provider, model: value.model.trim().slice(0, 160) };
}

function compareRecoveryJobs(a, b) {
  const queuedPriority = Number(b.status === "queued") - Number(a.status === "queued");
  if (queuedPriority) return queuedPriority;
  const timestampOrder = recoveryTimestamp(b) - recoveryTimestamp(a);
  if (timestampOrder) return timestampOrder;
  return String(b.id || "").localeCompare(String(a.id || ""));
}

function recoveryTimestamp(job) {
  return Math.max(Date.parse(job.updatedAt || "") || 0, Date.parse(job.createdAt || "") || 0);
}
