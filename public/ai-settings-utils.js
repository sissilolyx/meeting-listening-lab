export const AI_PROVIDER_CODEX = "codex";
export const AI_PROVIDER_CURSOR = "cursor";
export const AI_PROVIDER_IDS = [AI_PROVIDER_CODEX, AI_PROVIDER_CURSOR];

const PROVIDER_LABELS = {
  [AI_PROVIDER_CODEX]: "Codex",
  [AI_PROVIDER_CURSOR]: "Cursor",
};

export function aiProviderLabel(provider) {
  return PROVIDER_LABELS[provider] || "AI";
}

export function normalizeAiSettingsPayload(payload = {}) {
  const provider = normalizeProviderId(payload?.settings?.provider);
  const model = normalizeText(payload?.settings?.model);
  return {
    settings: {
      configured: payload?.settings?.configured === true,
      provider,
      model,
    },
    providers: {
      [AI_PROVIDER_CODEX]: normalizeProvider(payload?.providers?.[AI_PROVIDER_CODEX]),
      [AI_PROVIDER_CURSOR]: normalizeProvider(payload?.providers?.[AI_PROVIDER_CURSOR]),
    },
  };
}

export function normalizeAiModels(models) {
  const seen = new Set();
  return (Array.isArray(models) ? models : []).flatMap((model) => {
    const id = normalizeText(model?.id ?? model?.slug ?? model?.name);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      label: normalizeText(model?.label ?? model?.displayName ?? model?.display_name) || id,
      description: normalizeText(model?.description),
      reasoningLevels: normalizeReasoningLevels(model?.reasoningLevels ?? model?.supported_reasoning_levels),
    }];
  });
}

export function aiSelectionProblem(payload, provider, model) {
  const normalized = normalizeAiSettingsPayload(payload);
  if (!AI_PROVIDER_IDS.includes(provider)) return "请选择 Codex 或 Cursor。";
  const capability = normalized.providers[provider];
  const label = aiProviderLabel(provider);
  if (!capability.installed) return `${label} Agent 尚未安装。安装后请重新检查本机状态。`;
  if (!capability.authenticated) return `${label} Agent 尚未登录。请先完成账号登录，再重新检查本机状态。`;
  if (!capability.models.length) return `${label} 已登录，但暂时没有读取到可用模型。请重新检查本机状态。`;
  if (!capability.models.some((item) => item.id === model)) return "请选择当前账号可用的模型。";
  return "";
}

export function isAiSelectionReady(payload, provider, model) {
  return aiSelectionProblem(payload, provider, model) === "";
}

export function findAiModel(payload, provider, model) {
  const normalized = normalizeAiSettingsPayload(payload);
  return normalized.providers[provider]?.models.find((item) => item.id === model) || null;
}

export function aiSettingsRailLabel(payload) {
  const normalized = normalizeAiSettingsPayload(payload);
  const { configured, provider, model } = normalized.settings;
  if (!configured || !provider || !model) return "AI讲解 · 待设置";
  const selectedModel = findAiModel(normalized, provider, model);
  return `AI讲解 · ${aiProviderLabel(provider)} / ${selectedModel?.label || model}`;
}

function normalizeProvider(value = {}) {
  return {
    installed: value?.installed === true,
    authenticated: value?.authenticated === true,
    models: normalizeAiModels(value?.models),
    error: normalizeText(value?.error),
  };
}

function normalizeProviderId(value) {
  return AI_PROVIDER_IDS.includes(value) ? value : null;
}

function normalizeReasoningLevels(levels) {
  return (Array.isArray(levels) ? levels : []).flatMap((level) => {
    const value = normalizeText(typeof level === "string" ? level : level?.effort ?? level?.id ?? level?.label);
    return value ? [value] : [];
  });
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}
