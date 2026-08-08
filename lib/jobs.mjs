import {
  createId,
  listJobs,
  listMaterials,
  readMaterial,
  saveJob,
  updateMaterial,
} from "./storage.mjs";

const activeJobs = new Map();

function activeJobKey(kind, materialId) {
  return `${kind}:${materialId}`;
}

export async function createJob(kind, materialId, runner) {
  const key = activeJobKey(kind, materialId);
  const existing = activeJobs.get(key);
  if (existing) return existing;

  const now = new Date().toISOString();
  const job = {
    id: createId("job"),
    kind,
    materialId,
    status: "queued",
    stage: "等待开始",
    progress: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await saveJob(job);
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
          throw new Error(material.warning || "Codex 讲解生成失败");
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
            material.stage = "精听材料已就绪，Codex 讲解生成失败";
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
  });

  return job;
}

export async function recoverInterruptedJobs(resumeAnalysis) {
  const interruptedAt = new Date().toISOString();
  const jobs = await listJobs();
  const interrupted = jobs.filter((job) => job.status === "queued" || job.status === "running");

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
    if (material.analysisStatus !== "processing") continue;

    if (material.status === "ready" && material.sentences?.length) {
      await updateMaterial(material.id, (latest) => {
        latest.stage = "讲解生成曾中断，正在自动恢复";
        latest.warning = null;
        latest.error = null;
      });
      resumed.push(await resumeAnalysis(material.id));
      continue;
    }

    await updateMaterial(material.id, (latest) => {
      latest.status = "failed";
      latest.stage = "导入曾被中断，请重新导入";
      latest.error = "本地服务在材料导入完成前退出";
    });
  }

  return { interrupted, resumed };
}
