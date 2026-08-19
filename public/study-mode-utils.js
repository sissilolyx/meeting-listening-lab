export const STUDY_MODE_INTENSIVE = "intensive";
export const STUDY_MODE_REVIEW = "review";
export const STUDY_PREFERENCES_STORAGE_KEY = "meeting-listening-lab.study-preferences.v1";

export function defaultStudyPreferences() {
  return {
    mode: STUDY_MODE_INTENSIVE,
    reviewScope: { kind: "all" },
  };
}

export function normalizeStudyPreferences(value = {}) {
  return {
    mode: value?.mode === STUDY_MODE_REVIEW ? STUDY_MODE_REVIEW : STUDY_MODE_INTENSIVE,
    reviewScope: normalizeReviewScope(value?.reviewScope),
  };
}

export function normalizeReviewScope(value) {
  if (value?.kind === "material") {
    const materialId = String(value.materialId || "").trim();
    if (materialId) return { kind: "material", materialId };
  }
  return { kind: "all" };
}

export function updateStudyPreferences(current, action = {}) {
  const preferences = normalizeStudyPreferences(current);
  if (action.type === "set-mode") {
    return normalizeStudyPreferences({ ...preferences, mode: action.mode });
  }
  if (action.type === "set-review-scope") {
    return normalizeStudyPreferences({ ...preferences, reviewScope: action.scope });
  }
  return preferences;
}

export function loadStudyPreferences(storage, key = STUDY_PREFERENCES_STORAGE_KEY) {
  try {
    const value = storage?.getItem?.(key);
    return value ? normalizeStudyPreferences(JSON.parse(value)) : defaultStudyPreferences();
  } catch {
    return defaultStudyPreferences();
  }
}

export function saveStudyPreferences(storage, preferences, key = STUDY_PREFERENCES_STORAGE_KEY) {
  const normalized = normalizeStudyPreferences(preferences);
  try {
    storage?.setItem?.(key, JSON.stringify(normalized));
  } catch {
    // Preferences are an enhancement; unavailable storage must not block study.
  }
  return normalized;
}

export function normalizeMaterialCompletion(value = {}) {
  const completed = value?.completed === true;
  return {
    completed,
    completedAt: completed ? normalizeTimestamp(value.completedAt) : null,
    replayRequiredAfter: completed ? null : normalizeTimestamp(value.replayRequiredAfter),
  };
}

export function resetMaterialCompletion(value, resetAt = new Date()) {
  const current = normalizeMaterialCompletion(value);
  if (!current.completed) return { completion: current, transitioned: false };
  return {
    completion: {
      completed: false,
      completedAt: null,
      replayRequiredAfter: requireTimestamp(resetAt),
    },
    transitioned: true,
  };
}

export function shouldCompleteMaterial({
  completion,
  mode,
  reviewFilterActive = false,
  paragraphs = [],
  paragraphId,
  playbackPass,
} = {}) {
  const current = normalizeMaterialCompletion(completion);
  if (current.completed || mode !== STUDY_MODE_INTENSIVE || reviewFilterActive) return false;

  const actualParagraphs = Array.isArray(paragraphs) ? paragraphs.filter((item) => item?.id) : [];
  const actualFinalParagraphId = String(actualParagraphs.at(-1)?.id || "");
  if (!actualFinalParagraphId || String(paragraphId || "") !== actualFinalParagraphId) return false;

  if (playbackPass?.surface !== "paragraph-player") return false;
  if (playbackPass?.mediaKind !== "original") return false;
  if (playbackPass?.startedFromBeginning !== true) return false;
  if (playbackPass?.reachedContentEnd !== true) return false;
  if (playbackPass?.endedNaturally !== true || playbackPass?.endedBySeek === true) return false;

  if (current.replayRequiredAfter) {
    const resetAt = Date.parse(current.replayRequiredAfter);
    const playbackStartedAt = Date.parse(normalizeTimestamp(playbackPass.startedAt) || "");
    if (!Number.isFinite(playbackStartedAt) || playbackStartedAt < resetAt) return false;
  }
  return true;
}

export function transitionMaterialCompletion(options = {}, completedAt = new Date()) {
  const current = normalizeMaterialCompletion(options.completion);
  if (!shouldCompleteMaterial({ ...options, completion: current })) {
    return { completion: current, transitioned: false };
  }
  return {
    completion: {
      completed: true,
      completedAt: requireTimestamp(completedAt),
      replayRequiredAfter: null,
    },
    transitioned: true,
  };
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requireTimestamp(value) {
  return normalizeTimestamp(value) || new Date().toISOString();
}
