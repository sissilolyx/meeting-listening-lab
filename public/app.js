import { clipboardContainsFiles, extractPastedMediaFile, normalizePastedMediaFile } from "./file-import-utils.js";
import {
  AI_PROVIDER_IDS,
  aiProviderLabel,
  aiSelectionProblem,
  aiSettingsRailLabel,
  findAiModel,
  isAiSelectionReady,
  normalizeAiSettingsPayload,
} from "./ai-settings-utils.js";
import {
  countAskThreadCards,
  isAskRequestTokenCurrent,
  mergeAskThreadCards,
} from "./ask-thread-utils.js";
import { resolveTextAnchor, segmentTextAnchors } from "./ask-text-anchor-utils.js";
import {
  playbackLeadInRatio,
  playbackTargetCompletion,
  hasReliableSentencePlayback,
  resolveParagraphLeadIn,
  resolveParagraphPlaybackRange,
  resolveSentencePlaybackRange,
} from "./playback-range-utils.js";
import {
  pronunciationAccentLabel,
  selectPronunciationVoice,
  splitPronunciationText,
} from "./pronunciation-utils.js";
import { hasTranscriptReconstruction } from "./qa-answer-utils.js";
import { resolveLatestStudyIndex, resolveSavedStudyIndex } from "./study-position-utils.js";
import {
  STUDY_MODE_INTENSIVE,
  STUDY_MODE_REVIEW,
  loadStudyPreferences,
  normalizeMaterialCompletion,
  saveStudyPreferences,
  shouldCompleteMaterial,
  updateStudyPreferences,
} from "./study-mode-utils.js";

const DEFAULT_PANE_RATIO = 0.44;
const DEFAULT_STUDY_MODE = "paragraphs";
const PANE_RATIO_STORAGE_KEY = "meeting-listening-pane-ratio";
const STUDY_POSITION_STORAGE_PREFIX = "meeting-listening-position";
const LIBRARY_PREFERENCES_STORAGE_KEY = "meeting-listening-library-preferences";
const LIBRARY_RAIL_COLLAPSED_STORAGE_KEY = "meeting-listening-library-rail-collapsed";
const MEDIA_VIEW_STORAGE_PREFIX = "meeting-listening-media-view";
const MEDIA_VIEW_VISUAL = "visual";
const MEDIA_VIEW_LISTEN = "listen";
const PHRASE_EXPOSURE_MIN_RATIO = 0.6;
const PHRASE_EXPOSURE_DELAY_MS = 1200;
const PHRASE_SIGNAL_SESSION_ID = globalThis.crypto?.randomUUID?.()
  || `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const INLINE_SEGMENT_DRAWER_QUERY = "(min-width: 1400px)";
const initialStudyPreferences = loadStudyPreferences(globalThis.localStorage);

const state = {
  status: null,
  aiSettings: normalizeAiSettingsPayload(),
  aiSettingsLoaded: false,
  aiSettingsLoading: false,
  aiSettingsSaving: false,
  aiSettingsTesting: false,
  aiSettingsDialogMode: "settings",
  aiSettingsDraftProvider: "",
  aiSettingsDraftModel: "",
  aiSettingsLoadError: "",
  aiSettingsActionError: "",
  aiSettingsTestMessage: "",
  aiSettingsTestSucceeded: false,
  materials: [],
  trash: [],
  trashLoading: false,
  restoringTrashIds: new Set(),
  trashDialogOpener: null,
  material: null,
  mode: DEFAULT_STUDY_MODE,
  reviewOnly: false,
  studyPreferences: initialStudyPreferences,
  committedStudyPreferences: initialStudyPreferences,
  studyPreferenceOperationId: 0,
  reviewQueue: [],
  reviewQueueIndex: 0,
  committedReviewQueue: [],
  committedReviewQueueIndex: 0,
  reviewQueueRequestId: 0,
  reviewActivationRequestId: 0,
  materialOpenRequestId: 0,
  reviewQueueLoading: false,
  completionPlaybackPass: null,
  completionSaving: false,
  completionCelebratedMaterialIds: new Set(),
  index: 0,
  revealed: false,
  loop: false,
  speed: 1,
  media: null,
  mediaViewMode: MEDIA_VIEW_VISUAL,
  sentencePlayback: null,
  activeJobId: null,
  activeJobMaterialId: null,
  pollTimer: null,
  analysisPollTimer: null,
  saveTimer: null,
  playRequestId: 0,
  playbackPassEligible: false,
  playbackSeekPointerId: null,
  playbackSeekWasPlaying: false,
  heardSaving: new Set(),
  drawerReturnFocus: null,
  paneRatio: loadPaneRatio(),
  paneResizePointerId: null,
  askThreads: new Map(),
  activeAskThreadId: null,
  askRailCollapsed: true,
  askRailScrollTop: 0,
  collapsedAskThreadIds: new Set(),
  askAnchorElement: null,
  askRepositionFrame: null,
  phraseGuideRequests: new Map(),
  expandedPhraseGuideKeys: new Set(),
  phraseExposureObserver: null,
  phraseExposureTimers: new Map(),
  phraseExposureRecorded: new Set(),
  phraseExposurePending: new Set(),
  pronunciationButton: null,
  pronunciationUtterance: null,
  pronunciationTimer: null,
  pronunciationRequestId: 0,
  pronunciationVoiceLoadPromise: null,
  collapsedQuestionHistoryKeys: new Set(),
  selectionContext: null,
  libraryPreferences: loadLibraryPreferences(),
  libraryRailCollapsed: loadLibraryRailCollapsed(),
  draggedMaterialId: null,
  pendingDeleteMaterialId: null,
  deleteDialogOpener: null,
  learnerProfile: { version: 1, updatedAt: null, tooSimple: [] },
};

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));

boot();

async function boot() {
  applyLibraryRailState();
  bindEvents();
  await Promise.all([
    loadSystemStatus(),
    loadAiSettings({ openWhenUnconfigured: true }),
    loadMaterials(),
    loadLearnerProfile(),
    loadTrash().catch(() => {}),
  ]);
  normalizeStoredReviewScope();
  renderGlobalStudyControls();
  const materialId = new URLSearchParams(location.search).get("material");
  if (inReviewMode()) await enterReviewMode({ autoOpen: true, preferredMaterialId: materialId || "" });
  else if (materialId) await openMaterial(materialId);
}

function bindEvents() {
  elements.homeButton.addEventListener("click", showHome);
  elements.libraryRailToggle.addEventListener("click", toggleLibraryRail);
  elements.newImportButton.addEventListener("click", showHome);
  elements.backButton.addEventListener("click", showHome);
  elements.larkTab.addEventListener("click", () => switchImportTab("lark"));
  elements.fileTab.addEventListener("click", () => switchImportTab("file"));
  elements.importLarkButton.addEventListener("click", importLark);
  elements.larkUrl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") importLark();
  });
  elements.fileInput.addEventListener("change", () => {
    const file = elements.fileInput.files?.[0];
    if (file) uploadFile(file);
  });
  elements.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("is-dragging");
  });
  elements.dropZone.addEventListener("dragleave", () => elements.dropZone.classList.remove("is-dragging"));
  elements.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("is-dragging");
    const file = event.dataTransfer.files?.[0];
    if (file) uploadFile(file);
  });
  elements.dropZone.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    elements.fileInput.click();
  });
  document.addEventListener("paste", handleFilePaste);

  elements.aiSettingsRailButton.addEventListener("click", () => openAiSettingsDialog({ onboarding: false }));
  elements.closeAiSettingsButton.addEventListener("click", closeAiSettingsDialog);
  elements.cancelAiSettingsButton.addEventListener("click", closeAiSettingsDialog);
  elements.refreshAiSettingsButton.addEventListener("click", refreshAiSettings);
  elements.testAiSettingsButton.addEventListener("click", testAiSettings);
  elements.aiSettingsForm.addEventListener("submit", saveAiSettings);
  elements.aiModelSelect.addEventListener("change", () => {
    state.aiSettingsDraftModel = elements.aiModelSelect.value;
    clearAiSettingsFeedback();
    renderAiSettingsDialog();
  });
  document.querySelectorAll('[name="aiProvider"]').forEach((radio) => {
    radio.addEventListener("change", () => selectAiProvider(radio.value));
  });
  elements.aiSettingsDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (state.aiSettingsDialogMode === "onboarding") {
      const selectedProvider = document.querySelector('[name="aiProvider"]:checked');
      (selectedProvider || document.querySelector('[name="aiProvider"]'))?.focus();
      return;
    }
    closeAiSettingsDialog();
  });

  document.querySelectorAll("[data-media-view]").forEach((button) => {
    button.addEventListener("click", () => setMediaViewMode(button.dataset.mediaView));
  });
  document.querySelectorAll("[data-study-mode]").forEach((button) => {
    button.addEventListener("click", () => setGlobalStudyMode(button.dataset.studyMode));
  });
  document.querySelectorAll("[data-review-scope]").forEach((select) => {
    select.addEventListener("change", () => setReviewScope(select.value));
  });
  elements.materialCompletionButton.addEventListener("click", () => toggleMaterialCompletion(state.material));
  elements.closeCompletionCelebrationButton.addEventListener("click", closeCompletionCelebration);
  elements.completionCelebration.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeCompletionCelebration();
  });
  elements.segmentListButton.addEventListener("click", () => openSegmentDrawer());
  elements.closeSegmentDrawerButton.addEventListener("click", () => closeSegmentDrawer());
  elements.segmentDrawerScrim.addEventListener("click", () => closeSegmentDrawer());
  elements.resumeButton.addEventListener("click", resumeLastPosition);
  elements.playButton.addEventListener("click", togglePlayback);
  elements.replayButton.addEventListener("click", replayCurrent);
  elements.previousButton.addEventListener("click", () => navigateUnit(-1, true));
  elements.nextButton.addEventListener("click", () => navigateUnit(1, true));
  elements.bottomNextButton.addEventListener("click", advanceFromBottom);
  elements.loopButton.addEventListener("click", toggleLoop);
  elements.unitPlaybackTrack.addEventListener("pointerdown", startPlaybackSeek);
  elements.unitPlaybackTrack.addEventListener("pointermove", continuePlaybackSeek);
  elements.unitPlaybackTrack.addEventListener("pointerup", finishPlaybackSeek);
  elements.unitPlaybackTrack.addEventListener("pointercancel", finishPlaybackSeek);
  elements.unitPlaybackTrack.addEventListener("keydown", handlePlaybackSeekKeyboard);
  elements.revealButton.addEventListener("click", revealAnswer);
  elements.markReviewButton.addEventListener("click", toggleCurrentReview);
  elements.editTranscriptButton.addEventListener("click", openTranscriptEditor);
  elements.cancelEditButton.addEventListener("click", closeTranscriptEditor);
  elements.saveTranscriptButton.addEventListener("click", saveTranscriptEdit);
  elements.retryAnalysisButton.addEventListener("click", retryAnalysis);
  elements.diffText.addEventListener("pointerup", scheduleSelectionAction);
  elements.diffText.addEventListener("keyup", scheduleSelectionAction);
  elements.sentenceBreakdownList.addEventListener("pointerup", scheduleSelectionAction);
  elements.sentenceBreakdownList.addEventListener("keyup", scheduleSelectionAction);
  elements.selectionAskButton.addEventListener("click", askAboutSelection);
  elements.closeAskPanelButton.addEventListener("click", collapseAskRail);
  elements.askRailToggle.addEventListener("click", expandAskRail);
  elements.toastActionButton.addEventListener("click", runToastAction);
  elements.cancelDeleteMaterialButton.addEventListener("click", () => closeDeleteMaterialDialog());
  elements.confirmDeleteMaterialButton.addEventListener("click", confirmDeleteMaterial);
  elements.deleteMaterialDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDeleteMaterialDialog();
  });
  elements.trashButton.addEventListener("click", openTrashDialog);
  elements.closeTrashButton.addEventListener("click", () => closeTrashDialog());
  elements.trashDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeTrashDialog();
  });
  elements.dictationInput.addEventListener("input", scheduleDictationSave);
  elements.paneResizer.addEventListener("pointerdown", startPaneResize);
  elements.paneResizer.addEventListener("pointermove", continuePaneResize);
  elements.paneResizer.addEventListener("pointerup", finishPaneResize);
  elements.paneResizer.addEventListener("pointercancel", finishPaneResize);
  elements.paneResizer.addEventListener("dblclick", resetPaneRatio);
  elements.paneResizer.addEventListener("keydown", handlePaneResizerKeyboard);
  window.addEventListener("resize", schedulePaneResizeRefresh);
  window.addEventListener("resize", scheduleAskPanelReposition);
  window.addEventListener("scroll", handleViewportScroll, true);
  window.addEventListener("pagehide", disposeMedia);
  window.addEventListener("beforeunload", disposeMedia);
  document.addEventListener("visibilitychange", handleDocumentVisibility);
  document.addEventListener("keydown", handleKeyboard);
}

async function loadSystemStatus() {
  try {
    state.status = await api("/api/status");
    const tools = state.status.tools;
    const missing = [];
    if (!tools.ffmpeg || !tools.ffprobe) missing.push("FFmpeg");
    if (!tools.whisper) missing.push("Whisper CLI");
    if (!tools.whisperModel) missing.push("Whisper 模型");
    const larkReady = tools.lark && tools.larkUserReady;
    elements.systemStatus.classList.toggle("is-ready", missing.length === 0);
    elements.systemStatus.classList.toggle("has-warning", missing.length > 0);
    elements.systemStatus.querySelector("span:last-child").textContent = missing.length
      ? `待配置：${missing.join("、")}`
      : larkReady
        ? "本机能力已就绪"
        : "本地文件已就绪 · 飞书导入未配置";
  } catch {
    elements.systemStatus.classList.add("has-warning");
    elements.systemStatus.querySelector("span:last-child").textContent = "无法读取本机状态";
  }
}

async function loadAiSettings({ openWhenUnconfigured = false, preserveDraft = false } = {}) {
  state.aiSettingsLoading = true;
  state.aiSettingsLoadError = "";
  renderAiSettingsRail();
  renderAiSettingsDialog();
  try {
    const payload = await api("/api/ai-settings");
    state.aiSettings = normalizeAiSettingsPayload(payload);
    state.aiSettingsLoaded = true;
    reconcileAiSettingsDraft({ preserveDraft });
  } catch (error) {
    state.aiSettingsLoaded = false;
    state.aiSettingsLoadError = `无法读取本机 AI 状态：${error.message}。请确认本地服务仍在运行，然后重新检查。`;
  } finally {
    state.aiSettingsLoading = false;
    renderAiSettingsRail();
    renderAiSettingsDialog();
  }
  if (openWhenUnconfigured && (!state.aiSettingsLoaded || !state.aiSettings.settings.configured)) {
    openAiSettingsDialog({ onboarding: true });
  }
  return state.aiSettingsLoaded;
}

function reconcileAiSettingsDraft({ preserveDraft = false } = {}) {
  const configured = state.aiSettings.settings;
  let provider = preserveDraft ? state.aiSettingsDraftProvider : "";
  let model = preserveDraft ? state.aiSettingsDraftModel : "";
  if (!AI_PROVIDER_IDS.includes(provider) && configured.configured) {
    provider = configured.provider || "";
    model = configured.model || "";
  }
  if (!AI_PROVIDER_IDS.includes(provider)) {
    state.aiSettingsDraftProvider = "";
    state.aiSettingsDraftModel = "";
    return;
  }
  const models = state.aiSettings.providers[provider].models;
  if (!models.some((item) => item.id === model)) {
    const configuredModel = configured.provider === provider ? configured.model : "";
    model = models.some((item) => item.id === configuredModel) ? configuredModel : models[0]?.id || "";
  }
  state.aiSettingsDraftProvider = provider;
  state.aiSettingsDraftModel = model;
}

function openAiSettingsDialog({ onboarding = false } = {}) {
  state.aiSettingsDialogMode = onboarding ? "onboarding" : "settings";
  state.aiSettingsActionError = "";
  state.aiSettingsTestMessage = "";
  state.aiSettingsTestSucceeded = false;
  if (!onboarding) reconcileAiSettingsDraft();
  renderAiSettingsDialog();
  if (!elements.aiSettingsDialog.open) elements.aiSettingsDialog.showModal();
  requestAnimationFrame(() => {
    const target = state.aiSettingsDraftProvider
      ? document.querySelector(`[name="aiProvider"][value="${state.aiSettingsDraftProvider}"]`)
      : document.querySelector('[name="aiProvider"]');
    target?.focus();
  });
}

function closeAiSettingsDialog() {
  if (state.aiSettingsDialogMode === "onboarding" && !state.aiSettings.settings.configured) return;
  if (elements.aiSettingsDialog.open) elements.aiSettingsDialog.close();
  state.aiSettingsDialogMode = "settings";
  state.aiSettingsActionError = "";
  state.aiSettingsTestMessage = "";
  state.aiSettingsTestSucceeded = false;
}

function selectAiProvider(provider) {
  if (!AI_PROVIDER_IDS.includes(provider)) return;
  state.aiSettingsDraftProvider = provider;
  const models = state.aiSettings.providers[provider].models;
  const configuredModel = state.aiSettings.settings.provider === provider ? state.aiSettings.settings.model : "";
  const currentModel = state.aiSettingsDraftModel;
  state.aiSettingsDraftModel = models.some((item) => item.id === currentModel)
    ? currentModel
    : models.some((item) => item.id === configuredModel)
      ? configuredModel
      : models[0]?.id || "";
  clearAiSettingsFeedback();
  renderAiSettingsDialog();
}

async function refreshAiSettings() {
  if (state.aiSettingsLoading || state.aiSettingsSaving || state.aiSettingsTesting) return;
  clearAiSettingsFeedback();
  await loadAiSettings({ preserveDraft: true });
}

async function testAiSettings() {
  if (state.aiSettingsTesting || state.aiSettingsSaving) return;
  clearAiSettingsFeedback();
  const provider = state.aiSettingsDraftProvider;
  const model = state.aiSettingsDraftModel;
  const problem = aiSelectionProblem(state.aiSettings, provider, model);
  if (problem) {
    state.aiSettingsActionError = problem;
    renderAiSettingsDialog();
    return;
  }
  state.aiSettingsTesting = true;
  renderAiSettingsDialog();
  try {
    const payload = await api("/api/ai-settings/test", {
      method: "POST",
      body: { provider, model },
    });
    if (payload.ok === false) throw new Error(payload.error || payload.message || "连接测试失败");
    state.aiSettingsTestSucceeded = true;
    state.aiSettingsTestMessage = `${aiProviderLabel(provider)} / ${findAiModel(state.aiSettings, provider, model)?.label || model} 连接成功，可以保存。`;
  } catch (error) {
    state.aiSettingsTestSucceeded = false;
    state.aiSettingsTestMessage = `连接失败：${error.message}。请检查本机安装与登录后重试。`;
  } finally {
    state.aiSettingsTesting = false;
    renderAiSettingsDialog();
  }
}

async function saveAiSettings(event) {
  event.preventDefault();
  if (state.aiSettingsSaving || state.aiSettingsTesting) return;
  clearAiSettingsFeedback();
  const provider = state.aiSettingsDraftProvider;
  const model = state.aiSettingsDraftModel;
  const problem = aiSelectionProblem(state.aiSettings, provider, model);
  if (problem) {
    state.aiSettingsActionError = problem;
    renderAiSettingsDialog();
    return;
  }
  state.aiSettingsSaving = true;
  renderAiSettingsDialog();
  try {
    const payload = await api("/api/ai-settings", {
      method: "PATCH",
      body: { provider, model },
    });
    if (payload.ok === false) throw new Error(payload.error || payload.message || "保存失败");
    const returnedSettings = payload.settings || {};
    state.aiSettings = normalizeAiSettingsPayload({
      settings: {
        configured: true,
        provider: returnedSettings.provider || provider,
        model: returnedSettings.model || model,
      },
      providers: payload.providers || state.aiSettings.providers,
    });
    state.aiSettingsLoaded = true;
    reconcileAiSettingsDraft();
    state.aiSettingsDialogMode = "settings";
    renderAiSettingsRail();
    if (elements.aiSettingsDialog.open) elements.aiSettingsDialog.close();
    showToast(`已切换到 ${aiProviderLabel(provider)} / ${findAiModel(state.aiSettings, provider, model)?.label || model}，只影响之后的新讲解`);
  } catch (error) {
    state.aiSettingsActionError = `保存失败：${error.message}。当前选择尚未生效，请检查后重试。`;
  } finally {
    state.aiSettingsSaving = false;
    renderAiSettingsRail();
    renderAiSettingsDialog();
  }
}

function clearAiSettingsFeedback() {
  state.aiSettingsActionError = "";
  state.aiSettingsTestMessage = "";
  state.aiSettingsTestSucceeded = false;
}

function renderAiSettingsRail() {
  if (!elements.aiSettingsRailButton) return;
  const label = state.aiSettingsLoading && !state.aiSettingsLoaded
    ? "AI讲解 · 正在检查"
    : state.aiSettingsLoadError
      ? "AI讲解 · 无法检查"
      : aiSettingsRailLabel(state.aiSettings);
  const { provider, model, configured } = state.aiSettings.settings;
  const ready = configured && isAiSelectionReady(state.aiSettings, provider, model);
  elements.aiSettingsRailLabel.textContent = label;
  elements.aiSettingsRailHint.textContent = ready
    ? "已就绪 · 仅影响新任务"
    : configured
      ? "账户状态有变化，点击检查"
      : "选择自己的 AI 账户";
  elements.aiSettingsRailButton.classList.toggle("is-ready", ready);
  elements.aiSettingsRailButton.classList.toggle("has-warning", !ready && !state.aiSettingsLoading);
  elements.aiSettingsRailButton.setAttribute("aria-label", `${label}，打开设置`);
  elements.aiSettingsRailButton.title = `${label}，打开设置`;
}

function renderAiSettingsDialog() {
  if (!elements.aiSettingsDialog) return;
  const onboarding = state.aiSettingsDialogMode === "onboarding" && !state.aiSettings.settings.configured;
  elements.aiSettingsDialogTitle.textContent = onboarding ? "先选择 AI 讲解账户" : "AI 讲解设置";
  elements.closeAiSettingsButton.classList.toggle("is-hidden", onboarding);
  elements.cancelAiSettingsButton.classList.toggle("is-hidden", onboarding);
  elements.cancelAiSettingsButton.textContent = "取消";
  elements.aiProviderFieldset.disabled = state.aiSettingsLoading || state.aiSettingsSaving || state.aiSettingsTesting;
  elements.refreshAiSettingsButton.disabled = state.aiSettingsLoading || state.aiSettingsSaving || state.aiSettingsTesting;
  elements.refreshAiSettingsButton.textContent = state.aiSettingsLoading ? "正在检查…" : "重新检查";

  for (const provider of AI_PROVIDER_IDS) {
    const capability = state.aiSettings.providers[provider];
    const radio = document.querySelector(`[name="aiProvider"][value="${provider}"]`);
    const option = document.querySelector(`[data-ai-provider-option="${provider}"]`);
    const badge = provider === "codex" ? elements.aiCodexStatus : elements.aiCursorStatus;
    const selected = state.aiSettingsDraftProvider === provider;
    if (radio) radio.checked = selected;
    option?.classList.toggle("is-selected", selected);
    option?.classList.toggle("is-ready", capability.installed && capability.authenticated && capability.models.length > 0);
    const status = state.aiSettingsLoading && !state.aiSettingsLoaded
      ? "检查中"
      : !capability.installed
        ? "未安装"
        : !capability.authenticated
          ? "未登录"
          : capability.models.length
            ? `已登录 · ${capability.models.length} 个模型`
            : "未读取到模型";
    badge.textContent = status;
  }

  renderAiAccountState();
  renderAiModelOptions();

  const selectionReady = isAiSelectionReady(
    state.aiSettings,
    state.aiSettingsDraftProvider,
    state.aiSettingsDraftModel,
  );
  elements.testAiSettingsButton.disabled = !selectionReady || state.aiSettingsLoading || state.aiSettingsSaving || state.aiSettingsTesting;
  elements.testAiSettingsButton.textContent = state.aiSettingsTesting ? "正在测试…" : "测试连接";
  elements.saveAiSettingsButton.disabled = !selectionReady || state.aiSettingsLoading || state.aiSettingsSaving || state.aiSettingsTesting;
  elements.saveAiSettingsButton.textContent = state.aiSettingsSaving ? "正在保存…" : onboarding ? "保存并开始" : "保存设置";

  elements.aiSettingsLoadError.textContent = state.aiSettingsLoadError;
  elements.aiSettingsLoadError.classList.toggle("is-hidden", !state.aiSettingsLoadError);
  elements.aiSettingsError.textContent = state.aiSettingsActionError;
  elements.aiSettingsError.classList.toggle("is-hidden", !state.aiSettingsActionError);
  elements.aiSettingsTestResult.textContent = state.aiSettingsTestMessage;
  elements.aiSettingsTestResult.classList.toggle("is-hidden", !state.aiSettingsTestMessage);
  elements.aiSettingsTestResult.classList.toggle("is-success", state.aiSettingsTestSucceeded);
  elements.aiSettingsTestResult.classList.toggle("is-error", Boolean(state.aiSettingsTestMessage) && !state.aiSettingsTestSucceeded);
}

function renderAiAccountState() {
  const provider = state.aiSettingsDraftProvider;
  if (!AI_PROVIDER_IDS.includes(provider)) {
    elements.aiAccountStateMessage.textContent = "请选择 Codex 或 Cursor。应用只会使用这台电脑上已经安装并登录的账户。";
    return;
  }
  const capability = state.aiSettings.providers[provider];
  const label = aiProviderLabel(provider);
  if (capability.error) {
    elements.aiAccountStateMessage.textContent = `${capability.error} 请处理后点击“重新检查”。`;
    return;
  }
  if (!capability.installed) {
    elements.aiAccountStateMessage.textContent = `未找到 ${label} Agent CLI。请先完成本机安装，再点击“重新检查”。`;
    return;
  }
  if (!capability.authenticated) {
    elements.aiAccountStateMessage.textContent = `已找到 ${label} Agent CLI，但账号尚未登录。请先在本机完成登录，再点击“重新检查”。`;
    return;
  }
  if (!capability.models.length) {
    elements.aiAccountStateMessage.textContent = `${label} 已登录，但没有读取到可用模型。请点击“重新检查”；如果仍为空，请确认账户权限。`;
    return;
  }
  elements.aiAccountStateMessage.textContent = `${label} 已安装并登录，已从当前账户读取 ${capability.models.length} 个可用模型。`;
}

function renderAiModelOptions() {
  const provider = state.aiSettingsDraftProvider;
  const capability = state.aiSettings.providers[provider];
  const models = capability?.models || [];
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = provider ? "暂无可用模型" : "请先选择可用账户";
  const fragment = document.createDocumentFragment();
  fragment.append(placeholder);
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label;
    fragment.append(option);
  }
  elements.aiModelSelect.replaceChildren(fragment);
  elements.aiModelSelect.value = models.some((item) => item.id === state.aiSettingsDraftModel)
    ? state.aiSettingsDraftModel
    : "";
  elements.aiModelSelect.disabled = state.aiSettingsLoading
    || state.aiSettingsSaving
    || state.aiSettingsTesting
    || !capability?.installed
    || !capability?.authenticated
    || !models.length;
  const selectedModel = models.find((item) => item.id === elements.aiModelSelect.value);
  const reasoning = selectedModel?.reasoningLevels?.length
    ? ` 可用推理强度：${selectedModel.reasoningLevels.join("、")}。`
    : "";
  elements.aiModelDescription.textContent = selectedModel
    ? `${selectedModel.description || "模型列表来自当前账户的本机 CLI。"}${reasoning}`
    : "模型列表来自所选账户的本机 CLI，会随账号和版本动态更新。";
}

async function loadMaterials() {
  const payload = await api("/api/materials");
  state.materials = payload.materials;
  normalizeStoredReviewScope();
  renderGlobalStudyControls();
  renderMaterialList();
}

function inReviewMode() {
  return state.studyPreferences.mode === STUDY_MODE_REVIEW;
}

function normalizeStoredReviewScope() {
  const scope = state.studyPreferences.reviewScope;
  if (scope.kind !== "material") return;
  if (state.materials.some((material) => material.id === scope.materialId)) return;
  state.studyPreferences = saveStudyPreferences(globalThis.localStorage, updateStudyPreferences(state.studyPreferences, {
    type: "set-review-scope",
    scope: { kind: "all" },
  }));
  commitReviewStudyState();
}

function commitReviewStudyState() {
  state.committedStudyPreferences = state.studyPreferences;
  state.committedReviewQueue = [...state.reviewQueue];
  state.committedReviewQueueIndex = state.reviewQueueIndex;
}

function restoreCommittedReviewStudyState() {
  state.studyPreferences = saveStudyPreferences(globalThis.localStorage, state.committedStudyPreferences);
  state.reviewQueue = [...state.committedReviewQueue];
  state.reviewQueueIndex = Math.min(
    Math.max(0, state.committedReviewQueueIndex),
    Math.max(0, state.reviewQueue.length - 1),
  );
  state.reviewOnly = inReviewMode();
  renderGlobalStudyControls();
}

function renderGlobalStudyControls() {
  const reviewMode = inReviewMode();
  document.querySelectorAll("[data-study-mode]").forEach((button) => {
    const active = button.dataset.studyMode === state.studyPreferences.mode;
    button.setAttribute("aria-pressed", String(active));
    button.classList.toggle("is-active", active);
  });
  const readyMaterials = orderedMaterials().filter((material) => material.status === "ready");
  document.querySelectorAll(".review-scope-control").forEach((control) => {
    control.classList.toggle("is-hidden", !reviewMode);
  });
  document.querySelectorAll("[data-review-scope]").forEach((select) => {
    const selectedValue = state.studyPreferences.reviewScope.kind === "material"
      ? state.studyPreferences.reviewScope.materialId
      : "all";
    const fragment = document.createDocumentFragment();
    const allOption = document.createElement("option");
    allOption.value = "all";
    allOption.textContent = "全部材料";
    fragment.append(allOption);
    readyMaterials.forEach((material) => {
      const option = document.createElement("option");
      option.value = material.id;
      option.textContent = material.title;
      fragment.append(option);
    });
    select.replaceChildren(fragment);
    select.value = readyMaterials.some((material) => material.id === selectedValue) ? selectedValue : "all";
    select.disabled = state.reviewQueueLoading;
  });
  state.reviewOnly = reviewMode;
}

async function setGlobalStudyMode(mode) {
  if (![STUDY_MODE_INTENSIVE, STUDY_MODE_REVIEW].includes(mode)) return;
  if (state.studyPreferences.mode === mode) return;
  const preferenceOperationId = ++state.studyPreferenceOperationId;
  state.reviewQueueRequestId += 1;
  state.reviewActivationRequestId += 1;
  state.materialOpenRequestId += 1;
  pauseMedia();
  state.completionPlaybackPass = null;
  const requestedPreferences = saveStudyPreferences(globalThis.localStorage, updateStudyPreferences(state.studyPreferences, {
    type: "set-mode",
    mode,
  }));
  state.studyPreferences = requestedPreferences;
  renderGlobalStudyControls();
  if (mode === STUDY_MODE_REVIEW) {
    const switched = await enterReviewMode({ autoOpen: true, preferredMaterialId: state.material?.id });
    if (preferenceOperationId !== state.studyPreferenceOperationId) return;
    if (!switched && inReviewMode() && state.studyPreferences === requestedPreferences) {
      restoreCommittedReviewStudyState();
      if (state.material) renderTraining();
    }
    return;
  }
  state.reviewOnly = false;
  state.reviewQueue = [];
  state.reviewQueueIndex = 0;
  commitReviewStudyState();
  if (!state.material) return;
  state.index = resolveLatestStudyIndex(
    state.material[DEFAULT_STUDY_MODE] || [],
    state.material.progress || {},
    loadStudyPosition(DEFAULT_STUDY_MODE),
  );
  state.revealed = false;
  renderTraining();
  if (elements.segmentDrawer.classList.contains("is-open")) renderSegmentDirectory();
  requestAnimationFrame(() => scrollTrainingWorkspaceToTop());
  showToast("已切换到精听模式");
}

async function setReviewScope(value) {
  const preferenceOperationId = ++state.studyPreferenceOperationId;
  const scope = value && value !== "all" ? { kind: "material", materialId: value } : { kind: "all" };
  const requestedPreferences = saveStudyPreferences(globalThis.localStorage, updateStudyPreferences(state.studyPreferences, {
    type: "set-review-scope",
    scope,
  }));
  state.studyPreferences = requestedPreferences;
  renderGlobalStudyControls();
  if (!inReviewMode()) return;
  const changed = await enterReviewMode({ autoOpen: true, preferredMaterialId: value === "all" ? state.material?.id : value });
  if (preferenceOperationId !== state.studyPreferenceOperationId) return;
  if (!changed && state.studyPreferences === requestedPreferences) {
    restoreCommittedReviewStudyState();
  }
}

async function refreshReviewQueue({ preferredKey = "", preferredMaterialId = "" } = {}) {
  const requestId = ++state.reviewQueueRequestId;
  state.reviewQueueLoading = true;
  renderGlobalStudyControls();
  try {
    const scope = state.studyPreferences.reviewScope;
    const query = scope.kind === "material" ? `?materialId=${encodeURIComponent(scope.materialId)}` : "";
    const payload = await api(`/api/review-queue${query}`);
    if (requestId !== state.reviewQueueRequestId) return false;
    state.reviewQueue = Array.isArray(payload.items) ? payload.items : [];
    let index = preferredKey ? state.reviewQueue.findIndex((item) => item.key === preferredKey) : -1;
    if (index < 0 && preferredMaterialId) index = state.reviewQueue.findIndex((item) => item.materialId === preferredMaterialId);
    state.reviewQueueIndex = index >= 0 ? index : Math.min(state.reviewQueueIndex, Math.max(0, state.reviewQueue.length - 1));
    return true;
  } catch (error) {
    if (requestId === state.reviewQueueRequestId) showToast(`复习内容读取失败：${error.message}`);
    return false;
  } finally {
    if (requestId === state.reviewQueueRequestId) {
      state.reviewQueueLoading = false;
      renderGlobalStudyControls();
    }
  }
}

async function enterReviewMode({ autoOpen = false, preferredMaterialId = "" } = {}) {
  state.reviewOnly = true;
  const currentKey = currentReviewQueueItem()?.key || "";
  const refreshed = await refreshReviewQueue({ preferredKey: currentKey, preferredMaterialId });
  if (!refreshed || !inReviewMode()) return false;
  if (!state.reviewQueue.length) {
    if (state.material) {
      state.revealed = false;
      renderCurrentUnit();
    }
    showToast(state.studyPreferences.reviewScope.kind === "material" ? "这份材料还没有加入复习的内容" : "还没有加入复习的内容");
    commitReviewStudyState();
    return true;
  }
  if (autoOpen || state.material) {
    const activated = await activateReviewQueueIndex(state.reviewQueueIndex, { autoplay: false, resetScroll: true });
    if (!activated || !inReviewMode()) return false;
  }
  showToast("已切换到复习模式");
  return true;
}

function currentReviewQueueItem() {
  if (!inReviewMode() || !state.reviewQueue.length) return null;
  state.reviewQueueIndex = Math.min(Math.max(0, state.reviewQueueIndex), state.reviewQueue.length - 1);
  return state.reviewQueue[state.reviewQueueIndex] || null;
}

async function activateReviewQueueIndex(index, { autoplay = false, resetScroll = true } = {}) {
  if (!inReviewMode() || !state.reviewQueue.length) return false;
  const activationRequestId = ++state.reviewActivationRequestId;
  const nextIndex = Math.min(Math.max(0, index), state.reviewQueue.length - 1);
  const item = state.reviewQueue[nextIndex];
  if (state.material?.id !== item.materialId) {
    const opened = await openMaterial(item.materialId, {
      preserveReviewScope: true,
      skipReviewQueueLoad: true,
      reviewQueueIndex: nextIndex,
      preserveSegmentDrawerState: true,
      deferReviewStateCommit: true,
    });
    if (!opened || activationRequestId !== state.reviewActivationRequestId || !inReviewMode()) {
      return false;
    }
  } else {
    if (activationRequestId !== state.reviewActivationRequestId || !inReviewMode()) return false;
    state.reviewQueueIndex = nextIndex;
    state.index = Math.max(0, state.material.paragraphs.findIndex((paragraph) => paragraph.id === item.paragraphId));
    state.revealed = false;
    renderTraining();
    if (elements.segmentDrawer.classList.contains("is-open")) renderSegmentDirectory();
  }
  if (activationRequestId !== state.reviewActivationRequestId || !inReviewMode()) return false;
  commitReviewStudyState();
  if (resetScroll) requestAnimationFrame(() => scrollTrainingWorkspaceToTop());
  if (autoplay) playUnitFromStart();
  return true;
}

async function loadTrash() {
  const payload = await api("/api/trash");
  state.trash = Array.isArray(payload.trash) ? payload.trash : [];
  renderTrash();
}

async function openTrashDialog() {
  state.trashDialogOpener = document.activeElement;
  state.trashLoading = true;
  renderTrash();
  if (!elements.trashDialog.open) elements.trashDialog.showModal();
  requestAnimationFrame(() => elements.closeTrashButton.focus());
  try {
    await loadTrash();
  } catch (error) {
    showToast(`垃圾桶暂时无法读取：${error.message}`);
  } finally {
    state.trashLoading = false;
    renderTrash();
  }
}

function closeTrashDialog(restoreFocus = true) {
  const opener = state.trashDialogOpener;
  if (elements.trashDialog.open) elements.trashDialog.close();
  state.trashDialogOpener = null;
  if (restoreFocus && opener?.isConnected) requestAnimationFrame(() => opener.focus());
}

function renderTrash() {
  const count = state.trash.length;
  elements.trashCount.textContent = String(count);
  elements.trashCount.setAttribute("aria-label", `${count} 份已删除材料`);
  elements.trashCount.classList.toggle("is-hidden", count === 0);
  elements.trashButton.setAttribute("aria-label", count ? `打开垃圾桶，${count} 份材料可恢复` : "打开垃圾桶");
  elements.trashList.replaceChildren();

  if (state.trashLoading) {
    const loading = document.createElement("p");
    loading.className = "trash-empty";
    loading.textContent = "正在读取垃圾桶…";
    elements.trashList.append(loading);
    return;
  }

  if (!count) {
    const empty = document.createElement("p");
    empty.className = "trash-empty";
    empty.textContent = "垃圾桶是空的。";
    elements.trashList.append(empty);
    return;
  }

  for (const entry of state.trash) {
    const item = document.createElement("article");
    item.className = "trash-item";
    const details = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = entry.title || "未命名材料";
    const meta = document.createElement("p");
    const daysRemaining = Math.max(0, Math.ceil((Date.parse(entry.expiresAt) - Date.now()) / (24 * 60 * 60 * 1000)));
    meta.textContent = `删除于 ${formatTrashDate(entry.deletedAt)} · ${daysRemaining > 0 ? `还剩 ${daysRemaining} 天` : "即将永久删除"}`;
    details.append(title, meta);

    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.className = "trash-restore-button";
    const restoring = state.restoringTrashIds.has(entry.id);
    restoreButton.disabled = restoring;
    restoreButton.textContent = restoring ? "恢复中…" : "恢复";
    restoreButton.setAttribute("aria-label", `恢复材料：${entry.title || "未命名材料"}`);
    restoreButton.addEventListener("click", () => restoreTrashMaterial(entry.id));
    item.append(details, restoreButton);
    elements.trashList.append(item);
  }
}

async function restoreTrashMaterial(materialId) {
  if (state.restoringTrashIds.has(materialId)) return;
  state.restoringTrashIds.add(materialId);
  renderTrash();
  try {
    await api(`/api/trash/${encodeURIComponent(materialId)}/restore`, { method: "POST" });
    state.trash = state.trash.filter((entry) => entry.id !== materialId);
    await loadMaterials();
    showToast("材料已恢复到材料库");
  } catch (error) {
    showToast(`恢复失败：${error.message}`);
    await loadTrash().catch(() => {});
  } finally {
    state.restoringTrashIds.delete(materialId);
    renderTrash();
  }
}

async function loadLearnerProfile() {
  try {
    const payload = await api("/api/learner-profile");
    state.learnerProfile = payload.profile;
  } catch {
    state.learnerProfile = { version: 1, updatedAt: null, tooSimple: [] };
  }
}

function renderMaterialList() {
  elements.materialList.replaceChildren();
  if (!state.materials.length) {
    const empty = document.createElement("p");
    empty.className = "empty-library";
    empty.textContent = "导入第一段真实会议，材料会保存在这里。";
    elements.materialList.append(empty);
    return;
  }
  for (const material of orderedMaterials()) {
    const item = document.createElement("article");
    item.className = "material-item";
    item.dataset.materialId = material.id;
    const pinned = materialIsPinned(material.id);
    item.classList.toggle("is-pinned", pinned);
    if (state.material?.id === material.id) item.classList.add("is-active");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "material-open-button";
    button.setAttribute("aria-label", `打开材料：${material.title}`);
    const title = document.createElement("strong");
    title.className = "material-item-title";
    title.textContent = material.title;
    title.title = "双击重命名";
    const meta = document.createElement("span");
    meta.className = "material-item-meta";
    meta.textContent = material.status === "ready"
      ? `${formatDuration(material.duration)} · ${material.paragraphCount} 个自然分段 · ${material.reviewCount} 待复习`
      : material.stage;
    if (material.status !== "ready") meta.classList.add("material-state");
    button.append(title);
    const summary = document.createElement("div");
    summary.className = "material-item-summary";
    summary.append(meta);
    if (material.status === "ready") {
      const progress = document.createElement("span");
      progress.className = "material-study-progress";
      const progressMeta = document.createElement("span");
      progressMeta.className = "material-study-progress-meta";
      const label = document.createElement("span");
      label.textContent = "学习进度";
      const value = document.createElement("strong");
      value.textContent = `${material.progressPercent}% · 已听 ${material.heardUnitCount}/${material.totalUnitCount} 个片段`;
      progressMeta.append(label, value);
      const track = document.createElement("span");
      track.className = "material-study-progress-track";
      const fill = document.createElement("i");
      fill.style.transform = `scaleX(${Math.max(0, Math.min(100, material.progressPercent)) / 100})`;
      track.append(fill);
      progress.append(progressMeta, track);
      summary.append(progress);
    }
    const titleEditor = document.createElement("input");
    titleEditor.type = "text";
    titleEditor.className = "material-title-editor is-hidden";
    titleEditor.maxLength = 160;
    titleEditor.value = material.title;
    titleEditor.setAttribute("aria-label", `重命名材料：${material.title}`);
    titleEditor.autocomplete = "off";

    let titleClickTimer = null;
    let skipRenameBlur = false;
    let renameSaving = false;
    const cancelRename = ({ restoreFocus = false } = {}) => {
      titleEditor.value = material.title;
      titleEditor.disabled = false;
      titleEditor.classList.add("is-hidden");
      item.classList.remove("is-renaming");
      renameSaving = false;
      if (restoreFocus) button.focus();
    };
    const saveRename = async () => {
      if (skipRenameBlur) {
        skipRenameBlur = false;
        return;
      }
      if (renameSaving) return;
      const nextTitle = titleEditor.value.trim();
      if (!nextTitle) {
        cancelRename();
        showToast("材料标题不能为空");
        return;
      }
      if (nextTitle === material.title) {
        cancelRename();
        return;
      }
      renameSaving = true;
      titleEditor.disabled = true;
      try {
        const payload = await api(`/api/materials/${encodeURIComponent(material.id)}`, {
          method: "PATCH",
          body: { title: nextTitle },
        });
        state.materials = state.materials.map((entry) => (
          entry.id === material.id ? { ...entry, ...payload.material } : entry
        ));
        if (state.material?.id === material.id) {
          state.material.title = payload.material.title;
          elements.materialTitle.textContent = payload.material.title;
        }
        renderMaterialList();
        renderGlobalStudyControls();
        showToast("材料标题已更新");
      } catch (error) {
        renameSaving = false;
        titleEditor.disabled = false;
        titleEditor.focus();
        titleEditor.select();
        showToast(`重命名失败：${error.message}`);
      }
    };
    const startRename = () => {
      clearTimeout(titleClickTimer);
      item.classList.add("is-renaming");
      titleEditor.value = material.title;
      titleEditor.classList.remove("is-hidden");
      requestAnimationFrame(() => {
        titleEditor.focus();
        titleEditor.select();
      });
    };

    title.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.detail !== 1) return;
      clearTimeout(titleClickTimer);
      titleClickTimer = setTimeout(() => openMaterial(material.id), 500);
    });
    title.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      startRename();
    });
    titleEditor.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        titleEditor.blur();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        skipRenameBlur = true;
        cancelRename({ restoreFocus: true });
      }
    });
    titleEditor.addEventListener("blur", saveRename);
    button.addEventListener("click", () => {
      if (!item.classList.contains("is-renaming")) openMaterial(material.id);
    });

    const controls = document.createElement("div");
    controls.className = "material-item-controls";
    const completionButton = document.createElement("button");
    completionButton.type = "button";
    completionButton.className = "material-completion-toggle";
    completionButton.setAttribute("aria-pressed", String(material.completed === true));
    completionButton.setAttribute("aria-label", material.completed === true
      ? `将材料标记为未学完：${material.title}`
      : `将材料标记为已学完：${material.title}`);
    completionButton.title = material.completed === true ? "改为未学完" : "标记已学完";
    completionButton.textContent = material.completed === true ? "已学完" : "未学完";
    completionButton.addEventListener("click", () => toggleMaterialCompletion(material));
    const pinButton = document.createElement("button");
    pinButton.type = "button";
    pinButton.className = "material-pin-button";
    pinButton.setAttribute("aria-pressed", String(pinned));
    pinButton.setAttribute("aria-label", pinned ? `取消置顶：${material.title}` : `置顶：${material.title}`);
    pinButton.title = pinned ? "取消置顶" : "置顶";
    pinButton.textContent = pinned ? "已置顶" : "置顶";
    pinButton.addEventListener("click", () => toggleMaterialPin(material.id));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "material-delete-button";
    deleteButton.setAttribute("aria-label", `删除材料：${material.title}`);
    deleteButton.title = "删除材料";
    deleteButton.textContent = "删除";
    deleteButton.addEventListener("click", () => openDeleteMaterialDialog(material, deleteButton));

    const dragHandle = document.createElement("button");
    dragHandle.type = "button";
    dragHandle.className = "material-drag-handle";
    dragHandle.draggable = true;
    dragHandle.setAttribute("aria-label", `拖动调整顺序：${material.title}`);
    dragHandle.title = "拖动调整顺序；按 Option + ↑/↓ 移动";
    dragHandle.textContent = "⠿";
    dragHandle.addEventListener("keydown", (event) => handleMaterialOrderKeyboard(event, material.id));
    dragHandle.addEventListener("dragstart", (event) => startMaterialDrag(event, material.id));
    dragHandle.addEventListener("dragend", finishMaterialDrag);
    controls.append(completionButton, pinButton, deleteButton, dragHandle);

    item.append(button, titleEditor, summary, controls);
    summary.addEventListener("click", () => {
      if (!item.classList.contains("is-renaming")) openMaterial(material.id);
    });
    item.addEventListener("dragover", (event) => updateMaterialDropTarget(event, material.id, item));
    item.addEventListener("dragleave", (event) => {
      if (!item.contains(event.relatedTarget)) item.classList.remove("is-drop-before", "is-drop-after");
    });
    item.addEventListener("drop", (event) => dropMaterial(event, material.id, item));
    elements.materialList.append(item);
  }
}

function openDeleteMaterialDialog(material, opener) {
  state.pendingDeleteMaterialId = material.id;
  state.deleteDialogOpener = opener;
  elements.deleteMaterialName.textContent = `“${material.title}”`;
  elements.deleteMaterialError.textContent = "";
  elements.deleteMaterialError.classList.add("is-hidden");
  setDeleteMaterialDialogBusy(false);
  elements.deleteMaterialDialog.showModal();
  requestAnimationFrame(() => elements.cancelDeleteMaterialButton.focus());
}

function closeDeleteMaterialDialog(restoreFocus = true) {
  const opener = state.deleteDialogOpener;
  if (elements.deleteMaterialDialog.open) elements.deleteMaterialDialog.close();
  state.pendingDeleteMaterialId = null;
  state.deleteDialogOpener = null;
  elements.deleteMaterialError.textContent = "";
  elements.deleteMaterialError.classList.add("is-hidden");
  setDeleteMaterialDialogBusy(false);
  if (restoreFocus && opener?.isConnected) requestAnimationFrame(() => opener.focus());
}

function setDeleteMaterialDialogBusy(busy) {
  elements.cancelDeleteMaterialButton.disabled = busy;
  elements.confirmDeleteMaterialButton.disabled = busy;
  elements.confirmDeleteMaterialButton.textContent = busy ? "正在移动…" : "移入垃圾桶";
}

async function confirmDeleteMaterial() {
  const materialId = state.pendingDeleteMaterialId;
  if (!materialId) return;
  const reviewModeAtDelete = inReviewMode();
  const previousReviewKey = currentReviewQueueItem()?.key || "";
  const previousReviewIndex = state.reviewQueueIndex;
  setDeleteMaterialDialogBusy(true);
  elements.deleteMaterialError.classList.add("is-hidden");
  let payload;
  try {
    payload = await api(`/api/materials/${encodeURIComponent(materialId)}`, { method: "DELETE" });
  } catch (error) {
    elements.deleteMaterialError.textContent = error.message;
    elements.deleteMaterialError.classList.remove("is-hidden");
    setDeleteMaterialDialogBusy(false);
    return;
  }

  stopClientJobTrackingForMaterial(materialId);
  state.materials = state.materials.filter((material) => material.id !== materialId);
  normalizeStoredReviewScope();
  renderGlobalStudyControls();
  if (payload.trashEntry) {
    state.trash = [payload.trashEntry, ...state.trash.filter((entry) => entry.id !== materialId)];
    renderTrash();
  }
  const deletedCurrentMaterial = state.material?.id === materialId;
  closeDeleteMaterialDialog(false);
  if (deletedCurrentMaterial) showHome();
  else renderMaterialList();
  if (reviewModeAtDelete) {
    const refreshed = await refreshReviewQueue({
      preferredKey: previousReviewKey,
      preferredMaterialId: deletedCurrentMaterial ? "" : state.material?.id || "",
    });
    if (refreshed && state.reviewQueue.length) {
      const preservedIndex = previousReviewKey
        ? state.reviewQueue.findIndex((item) => item.key === previousReviewKey)
        : -1;
      const targetIndex = preservedIndex >= 0
        ? preservedIndex
        : Math.min(Math.max(0, previousReviewIndex), state.reviewQueue.length - 1);
      await activateReviewQueueIndex(targetIndex, { autoplay: false, resetScroll: false });
    } else if (refreshed) {
      commitReviewStudyState();
      if (state.material) renderCurrentUnit();
    }
  }
  showToast("已移入垃圾桶，30 天内可以恢复", {
    label: "撤销",
    onAction: () => restoreTrashMaterial(materialId),
  });
}

function stopClientJobTrackingForMaterial(materialId) {
  if (state.activeJobMaterialId !== materialId) return;
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.activeJobId = null;
  state.activeJobMaterialId = null;
  setImportBusy(false);
  elements.jobPanel.classList.add("is-hidden");
}

function loadLibraryPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(LIBRARY_PREFERENCES_STORAGE_KEY) || "null");
    return {
      order: [...new Set(Array.isArray(saved?.order) ? saved.order.filter((id) => typeof id === "string") : [])],
      pinned: [...new Set(Array.isArray(saved?.pinned) ? saved.pinned.filter((id) => typeof id === "string") : [])],
    };
  } catch {
    return { order: [], pinned: [] };
  }
}

function loadLibraryRailCollapsed() {
  try {
    return localStorage.getItem(LIBRARY_RAIL_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function applyLibraryRailState() {
  const collapsed = Boolean(state.libraryRailCollapsed);
  elements.appShell.classList.toggle("is-library-collapsed", collapsed);
  elements.libraryRail.dataset.collapsed = String(collapsed);
  elements.libraryRail.setAttribute("aria-label", collapsed ? "精听材料库，已收起" : "精听材料库");
  elements.libraryRailToggle.setAttribute("aria-expanded", String(!collapsed));
  const label = collapsed ? "展开材料库" : "收起材料库";
  elements.libraryRailToggle.setAttribute("aria-label", label);
  elements.libraryRailToggle.title = label;
}

function toggleLibraryRail() {
  state.libraryRailCollapsed = !state.libraryRailCollapsed;
  try {
    localStorage.setItem(LIBRARY_RAIL_COLLAPSED_STORAGE_KEY, String(state.libraryRailCollapsed));
  } catch {
    // Collapsing remains available for this visit when browser storage is unavailable.
  }
  applyLibraryRailState();
  hideSelectionAction();
  requestAnimationFrame(() => {
    schedulePaneResizeRefresh();
    scheduleAskPanelReposition();
  });
}

function saveLibraryPreferences() {
  try { localStorage.setItem(LIBRARY_PREFERENCES_STORAGE_KEY, JSON.stringify(state.libraryPreferences)); } catch { /* Local persistence is optional. */ }
}

function materialIsPinned(materialId) {
  return state.libraryPreferences.pinned.includes(materialId);
}

function orderedMaterials() {
  const materialById = new Map(state.materials.map((material) => [material.id, material]));
  const defaultOrder = [...state.materials].sort((a, b) => {
    const timeDifference = (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
    return timeDifference || a.id.localeCompare(b.id);
  });
  const savedIds = state.libraryPreferences.order.filter((id) => materialById.has(id));
  const savedSet = new Set(savedIds);
  const newlyAdded = defaultOrder.filter((material) => !savedSet.has(material.id));
  const merged = [...newlyAdded, ...savedIds.map((id) => materialById.get(id))];
  return [
    ...merged.filter((material) => materialIsPinned(material.id)),
    ...merged.filter((material) => !materialIsPinned(material.id)),
  ];
}

function toggleMaterialPin(materialId) {
  const pinned = new Set(state.libraryPreferences.pinned);
  const willPin = !pinned.has(materialId);
  if (willPin) pinned.add(materialId);
  else pinned.delete(materialId);

  const currentOrder = orderedMaterials().map((material) => material.id).filter((id) => id !== materialId);
  const nextOrder = willPin
    ? [materialId, ...currentOrder]
    : [
      ...currentOrder.filter((id) => pinned.has(id)),
      materialId,
      ...currentOrder.filter((id) => !pinned.has(id)),
    ];
  state.libraryPreferences = { order: nextOrder, pinned: [...pinned] };
  saveLibraryPreferences();
  renderMaterialList();
  showToast(willPin ? "材料已置顶" : "已取消置顶");
}

function startMaterialDrag(event, materialId) {
  state.draggedMaterialId = materialId;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", materialId);
  event.currentTarget.closest(".material-item")?.classList.add("is-drag-source");
}

function updateMaterialDropTarget(event, targetId, item) {
  const sourceId = state.draggedMaterialId;
  if (!sourceId || sourceId === targetId || materialIsPinned(sourceId) !== materialIsPinned(targetId)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  clearMaterialDropIndicators();
  const after = event.clientY > item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2;
  item.classList.add(after ? "is-drop-after" : "is-drop-before");
}

function dropMaterial(event, targetId, item) {
  const sourceId = state.draggedMaterialId || event.dataTransfer.getData("text/plain");
  if (!sourceId || sourceId === targetId || materialIsPinned(sourceId) !== materialIsPinned(targetId)) return finishMaterialDrag();
  event.preventDefault();
  const after = item.classList.contains("is-drop-after");
  reorderMaterial(sourceId, targetId, after);
  finishMaterialDrag();
}

function reorderMaterial(sourceId, targetId, after) {
  const order = orderedMaterials().map((material) => material.id).filter((id) => id !== sourceId);
  const targetIndex = order.indexOf(targetId);
  if (targetIndex < 0) return;
  order.splice(targetIndex + (after ? 1 : 0), 0, sourceId);
  state.libraryPreferences.order = order;
  saveLibraryPreferences();
  renderMaterialList();
  showToast("材料顺序已保存");
}

function handleMaterialOrderKeyboard(event, materialId) {
  if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const group = orderedMaterials().filter((material) => materialIsPinned(material.id) === materialIsPinned(materialId));
  const index = group.findIndex((material) => material.id === materialId);
  const targetIndex = index + (event.key === "ArrowDown" ? 1 : -1);
  if (!group[targetIndex]) return showToast(event.key === "ArrowDown" ? "已经在当前分组最后" : "已经在当前分组最前");
  reorderMaterial(materialId, group[targetIndex].id, event.key === "ArrowDown");
  requestAnimationFrame(() => elements.materialList.querySelector(`[data-material-id="${CSS.escape(materialId)}"] .material-drag-handle`)?.focus());
}

function clearMaterialDropIndicators() {
  elements.materialList.querySelectorAll(".material-item").forEach((item) => item.classList.remove("is-drop-before", "is-drop-after"));
}

function finishMaterialDrag() {
  state.draggedMaterialId = null;
  clearMaterialDropIndicators();
  elements.materialList.querySelectorAll(".is-drag-source").forEach((item) => item.classList.remove("is-drag-source"));
}

function switchImportTab(tab) {
  const lark = tab === "lark";
  elements.larkTab.classList.toggle("is-active", lark);
  elements.fileTab.classList.toggle("is-active", !lark);
  elements.larkTab.setAttribute("aria-selected", String(lark));
  elements.fileTab.setAttribute("aria-selected", String(!lark));
  elements.larkImport.classList.toggle("is-hidden", !lark);
  elements.fileImport.classList.toggle("is-hidden", lark);
  if (!lark) requestAnimationFrame(() => elements.dropZone.focus());
}

async function importLark() {
  const url = elements.larkUrl.value.trim();
  if (!url) return showToast("请先粘贴飞书妙记链接");
  setImportBusy(true);
  try {
    const payload = await api("/api/import/lark", { method: "POST", body: { url } });
    state.activeJobId = payload.job.id;
    state.activeJobMaterialId = payload.material.id;
    elements.jobPanel.classList.remove("is-hidden");
    updateJobPanel(payload.job);
    await loadMaterials();
    pollJob(payload.job.id);
  } catch (error) {
    showToast(error.message);
    setImportBusy(false);
  }
}

function uploadFile(file) {
  file = normalizePastedMediaFile(file);
  if (!file) return showToast("请选择 MP3、M4A、WAV、MP4 或 MOV 文件");
  setImportBusy(true);
  elements.jobPanel.classList.remove("is-hidden");
  elements.jobStage.textContent = "正在保存到本机";
  elements.jobDetail.textContent = file.name;

  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/import/file?filename=${encodeURIComponent(file.name)}`);
  xhr.upload.addEventListener("progress", (event) => {
    if (!event.lengthComputable) return;
    const value = Math.min(0.12, (event.loaded / event.total) * 0.12);
    renderJobProgress(value, `正在保存到本机`, `${Math.round((event.loaded / event.total) * 100)}% 已上传`);
  });
  xhr.addEventListener("load", async () => {
    try {
      const payload = JSON.parse(xhr.responseText);
      if (xhr.status >= 400) throw new Error(payload.error || "文件导入失败");
      state.activeJobId = payload.job.id;
      state.activeJobMaterialId = payload.material.id;
      updateJobPanel(payload.job);
      await loadMaterials();
      pollJob(payload.job.id);
    } catch (error) {
      showToast(error.message);
      setImportBusy(false);
    }
  });
  xhr.addEventListener("error", () => {
    showToast("无法把文件保存到本地服务");
    setImportBusy(false);
  });
  xhr.send(file);
}

function handleFilePaste(event) {
  const localPanelVisible = !elements.homeView.classList.contains("is-hidden")
    && !elements.fileImport.classList.contains("is-hidden");
  if (!localPanelVisible || event.defaultPrevented) return;

  const file = extractPastedMediaFile(event.clipboardData);
  if (!file) {
    const message = clipboardContainsFiles(event.clipboardData)
      ? "剪贴板里的文件格式不支持，请使用 MP3、M4A、WAV、MP4 或 MOV"
      : "没有检测到音频文件。请在语音备忘录中选中录音并复制，再回到这里按 ⌘V";
    showToast(message);
    return;
  }

  event.preventDefault();
  if (elements.fileInput.disabled) return showToast("当前材料仍在处理中，请完成后再粘贴新的录音");
  elements.dropZone.classList.add("is-pasting");
  setTimeout(() => elements.dropZone.classList.remove("is-pasting"), 420);
  showToast(`已粘贴“${file.name}”，正在保存到本机`);
  uploadFile(file);
}

function pollJob(jobId) {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(async () => {
    if (state.activeJobId !== jobId) return;
    try {
      const payload = await api(`/api/jobs/${jobId}`);
      updateJobPanel(payload.job);
      await loadMaterials();
      if (payload.job.status === "completed") {
        state.activeJobId = null;
        state.activeJobMaterialId = null;
        setImportBusy(false);
        showToast("材料已经准备好，可以开始精听");
        return openMaterial(payload.job.materialId);
      }
      if (payload.job.status === "failed") {
        state.activeJobId = null;
        state.activeJobMaterialId = null;
        setImportBusy(false);
        return showToast(payload.job.error || "处理失败");
      }
      pollJob(jobId);
    } catch (error) {
      setImportBusy(false);
      showToast(error.message);
    }
  }, 1500);
}

function updateJobPanel(job) {
  renderJobProgress(job.progress || 0, job.stage, job.error || "可以离开此页面，处理完成后材料会保存在本机。");
}

function renderJobProgress(progress, stage, detail) {
  const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
  elements.jobStage.textContent = stage;
  elements.jobPercent.textContent = `${percent}%`;
  elements.jobProgress.style.width = `${percent}%`;
  elements.jobDetail.textContent = detail;
}

function setImportBusy(busy) {
  elements.importLarkButton.disabled = busy;
  elements.fileInput.disabled = busy;
  elements.dropZone.classList.toggle("is-busy", busy);
  elements.dropZone.setAttribute("aria-disabled", String(busy));
}

async function openMaterial(id, options = {}) {
  const openRequestId = ++state.materialOpenRequestId;
  clearPhraseExposureTracking();
  const previousMaterial = state.material;
  const askRailWasCollapsed = state.askRailCollapsed;
  const askRailWasVisible = !elements.askPanel.classList.contains("is-hidden")
    || !elements.askRailToggle.classList.contains("is-hidden");
  pauseMedia();
  state.completionPlaybackPass = null;
  hideAskRail();
  const segmentDrawerWasOpen = elements.segmentDrawer.classList.contains("is-open");
  closeSegmentDrawer(false);
  if (inReviewMode() && !options.skipReviewQueueLoad) {
    const refreshed = await refreshReviewQueue({ preferredMaterialId: id });
    if (!refreshed || openRequestId !== state.materialOpenRequestId) {
      restoreMaterialOpenUiAfterFailure({ openRequestId, previousMaterial, askRailWasCollapsed, askRailWasVisible, segmentDrawerWasOpen });
      return false;
    }
  }

  let targetMaterialId = id;
  let reviewQueueIndex = Number.isInteger(options.reviewQueueIndex) ? options.reviewQueueIndex : -1;
  if (inReviewMode() && state.reviewQueue.length) {
    if (reviewQueueIndex < 0) reviewQueueIndex = state.reviewQueue.findIndex((item) => item.materialId === id);
    if (reviewQueueIndex < 0) reviewQueueIndex = Math.min(Math.max(0, state.reviewQueueIndex), state.reviewQueue.length - 1);
    targetMaterialId = state.reviewQueue[reviewQueueIndex]?.materialId || id;
  }

  let payload;
  try {
    payload = await api(`/api/materials/${targetMaterialId}`);
  } catch (error) {
    if (openRequestId === state.materialOpenRequestId) {
      restoreMaterialOpenUiAfterFailure({ openRequestId, previousMaterial, askRailWasCollapsed, askRailWasVisible, segmentDrawerWasOpen });
      showToast(`材料读取失败：${error.message}`);
    }
    return false;
  }
  if (openRequestId !== state.materialOpenRequestId) return false;
  state.material = payload.material;
  if (state.material.status !== "ready" || !state.material.sentences.length) {
    showHome();
    showToast(state.material.error || state.material.stage || "材料仍在处理");
    return;
  }
  state.loop = false;
  state.mediaViewMode = loadMaterialMediaView(state.material);
  renderLoopState();
  state.revealed = false;
  state.mode = DEFAULT_STUDY_MODE;
  state.reviewOnly = inReviewMode();
  if (inReviewMode()) {
    if (reviewQueueIndex < 0) reviewQueueIndex = state.reviewQueue.findIndex((item) => item.materialId === targetMaterialId);
    state.reviewQueueIndex = reviewQueueIndex >= 0 ? reviewQueueIndex : 0;
    const reviewItem = currentReviewQueueItem();
    state.index = Math.max(0, state.material.paragraphs.findIndex((paragraph) => paragraph.id === reviewItem?.paragraphId));
  } else {
    state.index = resolveLatestStudyIndex(
      state.material[DEFAULT_STUDY_MODE] || [],
      state.material.progress || {},
      loadStudyPosition(DEFAULT_STUDY_MODE),
    );
  }
  state.heardSaving.clear();
  elements.homeView.classList.add("is-hidden");
  elements.trainingView.classList.remove("is-hidden");
  document.body.classList.add("is-training");
  history.replaceState(null, "", `?material=${encodeURIComponent(targetMaterialId)}`);
  renderMaterialList();
  renderGlobalStudyControls();
  setupMedia();
  renderTraining();
  if (!options.preserveSegmentDrawerState || segmentDrawerWasOpen) applyInitialSegmentDrawerState();
  scheduleAnalysisStatusPoll();
  if (inReviewMode() && !options.deferReviewStateCommit) commitReviewStudyState();
  requestAnimationFrame(() => {
    applyPaneRatio(state.paneRatio);
    scrollTrainingWorkspaceToTop();
  });
  return true;
}

function restoreMaterialOpenUiAfterFailure({
  openRequestId,
  previousMaterial,
  askRailWasCollapsed,
  askRailWasVisible,
  segmentDrawerWasOpen,
}) {
  if (openRequestId !== state.materialOpenRequestId || state.material !== previousMaterial || !previousMaterial) return;
  state.askRailCollapsed = askRailWasCollapsed;
  if (askRailWasVisible) renderAskRail({ preserveScroll: true });
  if (segmentDrawerWasOpen) openSegmentDrawer({ focus: false });
}

function showHome() {
  state.committedStudyPreferences = state.studyPreferences;
  state.committedReviewQueue = [];
  state.committedReviewQueueIndex = 0;
  state.studyPreferenceOperationId += 1;
  state.reviewQueueRequestId += 1;
  state.reviewActivationRequestId += 1;
  state.materialOpenRequestId += 1;
  clearTimeout(state.analysisPollTimer);
  state.analysisPollTimer = null;
  clearPhraseExposureTracking();
  hideAskRail();
  closeSegmentDrawer(false);
  disposeMedia();
  document.body.classList.remove("is-training");
  elements.trainingView.classList.add("is-hidden");
  elements.homeView.classList.remove("is-hidden");
  history.replaceState(null, "", location.pathname);
  state.material = null;
  state.completionPlaybackPass = null;
  renderMaterialList();
  renderGlobalStudyControls();
}

function setupMedia() {
  disposeMedia();
  elements.mediaStage.replaceChildren();
  const tag = state.material.media?.kind === "video" ? "video" : "audio";
  const media = document.createElement(tag);
  media.preload = "metadata";
  media.src = `/api/materials/${state.material.id}/media`;
  media.playsInline = true;
  media.playbackRate = state.speed;
  media.addEventListener("timeupdate", handleMediaTimeUpdate);
  media.addEventListener("ended", () => enforceUnitBoundary(true));
  media.addEventListener("loadedmetadata", updateUnitPlaybackProgress);
  media.addEventListener("seeked", updateUnitPlaybackProgress);
  media.addEventListener("play", () => { elements.playButton.textContent = "暂停"; });
  media.addEventListener("pause", () => {
    elements.playButton.textContent = "播放";
    clearSentencePlaybackState();
  });
  media.addEventListener("error", () => showToast("原始媒体无法播放，请重新导入"));
  elements.mediaStage.append(media);
  state.media = media;
}

function renderTraining() {
  const material = state.material;
  elements.materialTitle.textContent = material.title;
  elements.materialMeta.textContent = `${formatDuration(material.duration)} · ${material.paragraphs.length} 个自然分段`;
  elements.overviewBlock.classList.toggle("is-hidden", !material.overview?.summaryZh);
  elements.overviewText.textContent = material.overview?.summaryZh || "";
  const needsSpokenFormRefresh = material.analysisStatus !== "processing"
    && material.sentences.some((sentence) => sentence.analysis && !Array.isArray(sentence.analysis.spokenFormNotes));
  const showAnalysisAction = material.analysisStatus === "failed" || needsSpokenFormRefresh;
  elements.analysisRetry.classList.toggle("is-hidden", !showAnalysisAction);
  elements.analysisRetry.querySelector("span").textContent = material.analysisStatus === "failed"
    ? "AI 讲解尚未生成，但原声精听可以继续。"
    : "这份旧材料还没有口语结构说明，可以补充生成。";
  elements.retryAnalysisButton.textContent = material.analysisStatus === "failed" ? "重新生成讲解" : "补充口语结构说明";
  renderMaterialCompletionState();
  renderMediaViewState();
  renderGlobalStudyControls();
  renderCurrentUnit();
  updateResumeButton();
  renderAskRail({ preserveScroll: true });
}

function materialHasVisualMedia(material = state.material) {
  return material?.media?.kind === "video";
}

function mediaViewStorageKey(materialId) {
  return `${MEDIA_VIEW_STORAGE_PREFIX}:${materialId}`;
}

function loadMaterialMediaView(material) {
  if (!materialHasVisualMedia(material)) return MEDIA_VIEW_LISTEN;
  try {
    return localStorage.getItem(mediaViewStorageKey(material.id)) === MEDIA_VIEW_LISTEN
      ? MEDIA_VIEW_LISTEN
      : MEDIA_VIEW_VISUAL;
  } catch {
    return MEDIA_VIEW_VISUAL;
  }
}

function renderMediaViewState() {
  const hasVisualMedia = materialHasVisualMedia();
  const listenOnly = !hasVisualMedia || state.mediaViewMode === MEDIA_VIEW_LISTEN;
  state.mediaViewMode = listenOnly ? MEDIA_VIEW_LISTEN : MEDIA_VIEW_VISUAL;
  elements.trainingView.dataset.mediaView = state.mediaViewMode;
  elements.trainingView.classList.toggle("is-listen-only", listenOnly);
  const progressSlot = listenOnly ? elements.listenOnlyProgressSlot : elements.practiceProgressSlot;
  if (elements.practiceProgress.parentElement !== progressSlot) progressSlot.append(elements.practiceProgress);
  elements.mediaViewSwitch.classList.toggle("is-hidden", !hasVisualMedia);
  elements.mediaViewSwitch.querySelectorAll("[data-media-view]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.mediaView === state.mediaViewMode));
  });
  elements.mediaStage.setAttribute("aria-hidden", String(listenOnly));
  elements.mediaColumn.setAttribute("aria-label", listenOnly ? "当前片段音频播放控制" : "原始录屏与播放控制");
  elements.paneResizer.inert = listenOnly;
  elements.segmentListButton.classList.toggle("is-hidden", listenOnly);
  elements.overviewBlock.classList.toggle("is-hidden", listenOnly || !state.material?.overview?.summaryZh);
  if (listenOnly && elements.segmentDrawer.classList.contains("is-open")) closeSegmentDrawer(false);
}

function setMediaViewMode(requestedMode) {
  if (!state.material) return;
  const hasVisualMedia = materialHasVisualMedia();
  const nextMode = hasVisualMedia && requestedMode === MEDIA_VIEW_VISUAL
    ? MEDIA_VIEW_VISUAL
    : MEDIA_VIEW_LISTEN;
  if (state.mediaViewMode === nextMode) return;
  const practiceScrollTop = elements.practiceColumn?.scrollTop || 0;
  const windowScrollY = window.scrollY;
  state.mediaViewMode = nextMode;
  if (hasVisualMedia) {
    try {
      localStorage.setItem(mediaViewStorageKey(state.material.id), nextMode);
    } catch {
      // The layout still changes for this visit when storage is unavailable.
    }
  }
  renderMediaViewState();
  requestAnimationFrame(() => {
    applyPaneRatio(state.paneRatio);
    if (window.matchMedia("(min-width: 1061px)").matches) {
      elements.practiceColumn.scrollTop = practiceScrollTop;
    } else {
      window.scrollTo({ top: windowScrollY, behavior: "auto" });
    }
  });
  showToast(nextMode === MEDIA_VIEW_LISTEN
    ? "已切换到纯听，画面已隐藏，原声继续播放"
    : "已切换到有画面");
}

function renderMaterialCompletionState() {
  const completed = state.material?.completed === true;
  elements.materialCompletionButton.setAttribute("aria-pressed", String(completed));
  elements.materialCompletionButton.textContent = completed ? "✓ 已学完 · 改为未学完" : "标记已学完";
  elements.materialCompletionButton.title = completed ? "手动改回未学完后，需要重新完整听完最后一段才会自动完成" : "手动把这份材料标记为已学完";
}

async function toggleMaterialCompletion(material) {
  if (!material?.id || state.completionSaving) return;
  const completed = material.completed !== true;
  if (!completed) {
    pauseMedia();
    state.completionPlaybackPass = null;
  }
  state.completionSaving = true;
  if (state.material?.id === material.id) elements.materialCompletionButton.disabled = true;
  try {
    const payload = await api(`/api/materials/${material.id}/learning-state`, {
      method: "PATCH",
      body: { completed },
    });
    applyMaterialLearningState(material.id, payload.material);
    if (completed) {
      clearCompletionResetAt(material.id);
    } else {
      saveCompletionResetAt(material.id, new Date().toISOString());
      state.completionCelebratedMaterialIds.delete(material.id);
    }
    renderMaterialList();
    if (state.material?.id === material.id) renderMaterialCompletionState();
    showToast(completed ? "已标记为学完" : "已改为未学完；完整重播最后一段后会再次自动完成");
  } catch (error) {
    showToast(`状态保存失败：${error.message}`);
  } finally {
    state.completionSaving = false;
    if (state.material?.id === material.id) elements.materialCompletionButton.disabled = false;
  }
}

function applyMaterialLearningState(materialId, summary) {
  const completed = summary?.completed === true;
  const completedAt = completed ? summary?.completedAt || new Date().toISOString() : null;
  state.materials = state.materials.map((material) => material.id === materialId
    ? { ...material, completed, completedAt }
    : material);
  if (state.material?.id === materialId) {
    state.material.completed = completed;
    state.material.completedAt = completedAt;
  }
  state.reviewQueue = state.reviewQueue.map((item) => item.materialId === materialId
    ? { ...item, materialCompleted: completed, materialCompletedAt: completedAt }
    : item);
}

function completionResetKey(materialId) {
  return `meeting-listening-completion-reset:${materialId}`;
}

function loadCompletionResetAt(materialId) {
  try {
    const value = localStorage.getItem(completionResetKey(materialId));
    return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  } catch {
    return null;
  }
}

function saveCompletionResetAt(materialId, timestamp) {
  try { localStorage.setItem(completionResetKey(materialId), timestamp); } catch { /* Reset replay guard remains active for this visit through the current pass. */ }
}

function clearCompletionResetAt(materialId) {
  try { localStorage.removeItem(completionResetKey(materialId)); } catch { /* Optional local replay guard. */ }
}

function showCompletionCelebration({ materialId, title }) {
  if (!materialId || state.material?.id !== materialId || state.completionCelebratedMaterialIds.has(materialId)) return;
  state.completionCelebratedMaterialIds.add(materialId);
  elements.completionCelebrationTitle.textContent = `恭喜你，“${title || state.material.title}”已经学完啦！`;
  if (!elements.completionCelebration.open) elements.completionCelebration.showModal();
  requestAnimationFrame(() => elements.closeCompletionCelebrationButton.focus());
}

function closeCompletionCelebration() {
  if (elements.completionCelebration.open) elements.completionCelebration.close();
}

function paneMetrics() {
  if (getComputedStyle(elements.paneResizer).display === "none") return null;
  const gridRect = elements.trainingGrid.getBoundingClientRect();
  const resizerRect = elements.paneResizer.getBoundingClientRect();
  const gridStyle = getComputedStyle(elements.trainingGrid);
  const columnGap = Number.parseFloat(gridStyle.columnGap) || 0;
  const availableWidth = gridRect.width - resizerRect.width - columnGap * 2;
  if (availableWidth <= 0) return null;
  const minimumMediaWidth = 300;
  const minimumPracticeWidth = 320;
  return {
    gridRect,
    resizerWidth: resizerRect.width,
    columnGap,
    availableWidth,
    minimumRatio: Math.max(0.3, minimumMediaWidth / availableWidth),
    maximumRatio: Math.min(0.7, (availableWidth - minimumPracticeWidth) / availableWidth),
  };
}

function applyPaneRatio(ratio, persist = false) {
  const metrics = paneMetrics();
  if (!metrics) return;
  const safeMaximum = Math.max(metrics.minimumRatio, metrics.maximumRatio);
  const clampedRatio = Math.max(metrics.minimumRatio, Math.min(safeMaximum, Number(ratio) || DEFAULT_PANE_RATIO));
  state.paneRatio = clampedRatio;
  elements.trainingGrid.style.setProperty("--media-pane-width", `${clampedRatio * metrics.availableWidth}px`);
  elements.paneResizer.setAttribute("aria-valuemin", String(Math.round(metrics.minimumRatio * 100)));
  elements.paneResizer.setAttribute("aria-valuemax", String(Math.round(safeMaximum * 100)));
  elements.paneResizer.setAttribute("aria-valuenow", String(Math.round(clampedRatio * 100)));
  if (persist) savePaneRatio(clampedRatio);
}

function startPaneResize(event) {
  if (event.button !== 0 || !paneMetrics()) return;
  event.preventDefault();
  state.paneResizePointerId = event.pointerId;
  elements.paneResizer.setPointerCapture(event.pointerId);
  elements.paneResizer.classList.add("is-dragging");
  document.body.classList.add("is-resizing-panes");
  updatePaneRatioFromPointer(event.clientX);
}

function continuePaneResize(event) {
  if (state.paneResizePointerId !== event.pointerId) return;
  updatePaneRatioFromPointer(event.clientX);
}

function finishPaneResize(event) {
  if (state.paneResizePointerId !== event.pointerId) return;
  if (elements.paneResizer.hasPointerCapture(event.pointerId)) {
    elements.paneResizer.releasePointerCapture(event.pointerId);
  }
  state.paneResizePointerId = null;
  elements.paneResizer.classList.remove("is-dragging");
  document.body.classList.remove("is-resizing-panes");
  savePaneRatio(state.paneRatio);
}

function updatePaneRatioFromPointer(clientX) {
  const metrics = paneMetrics();
  if (!metrics) return;
  const mediaWidth = clientX - metrics.gridRect.left - metrics.columnGap - metrics.resizerWidth / 2;
  applyPaneRatio(mediaWidth / metrics.availableWidth);
}

function handlePaneResizerKeyboard(event) {
  const metrics = paneMetrics();
  if (!metrics) return;
  const resizeKeys = ["Home", "ArrowLeft", "ArrowRight"];
  if (!resizeKeys.includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Home") {
    resetPaneRatio();
    return;
  }
  const direction = event.key === "ArrowRight" ? 1 : -1;
  const step = (event.shiftKey ? 48 : 20) / metrics.availableWidth;
  applyPaneRatio(state.paneRatio + direction * step, true);
}

function resetPaneRatio() {
  applyPaneRatio(DEFAULT_PANE_RATIO, true);
}

let paneResizeFrame;
function schedulePaneResizeRefresh() {
  cancelAnimationFrame(paneResizeFrame);
  paneResizeFrame = requestAnimationFrame(() => {
    syncSegmentDrawerPresentation();
    applyPaneRatio(state.paneRatio);
  });
}

function loadPaneRatio() {
  try {
    const value = Number(localStorage.getItem(PANE_RATIO_STORAGE_KEY));
    return Number.isFinite(value) && value >= 0.3 && value <= 0.7 ? value : DEFAULT_PANE_RATIO;
  } catch {
    return DEFAULT_PANE_RATIO;
  }
}

function savePaneRatio(value) {
  try { localStorage.setItem(PANE_RATIO_STORAGE_KEY, String(value)); } catch { /* Local persistence is optional. */ }
}

function currentUnits() {
  const units = state.material?.paragraphs || [];
  if (!inReviewMode()) return units;
  const paragraphIds = new Set(state.reviewQueue
    .filter((item) => item.materialId === state.material?.id)
    .map((item) => item.paragraphId));
  return units.filter((unit) => paragraphIds.has(unit.id));
}

function reviewItems(material = state.material) {
  return material?.reviewItems || [];
}

function sentenceNeedsReview(sentenceId) {
  return state.material?.progress?.[sentenceId]?.status === "review"
    || reviewItems().some((item) => item.sentenceId === sentenceId && (item.kind === "phrase" || item.kind === "qa"));
}

function paragraphContainsReview(paragraph) {
  const paragraphIds = [paragraph.id, ...(paragraph.mergedFromParagraphIds || [])];
  return reviewItems().some((item) => item.kind === "paragraph" && paragraphIds.includes(item.paragraphId))
    || unitReviewSentenceIds(paragraph).some((sentenceId) => sentenceNeedsReview(sentenceId));
}

function unitNeedsReview(unit) {
  return paragraphContainsReview(unit);
}

function currentUnit() {
  if (inReviewMode()) {
    const item = currentReviewQueueItem();
    if (!item || item.materialId !== state.material?.id) return null;
    return state.material.paragraphs.find((paragraph) => paragraph.id === item.paragraphId) || null;
  }
  const units = currentUnits();
  if (!units.length) return null;
  state.index = Math.min(Math.max(0, state.index), units.length - 1);
  return units[state.index];
}

function currentPlaybackRange(unit = currentUnit()) {
  if (!unit) return null;
  const trailingContextSentenceIds = unitTrailingContextSentenceIds(unit);
  const hasTrailingContext = trailingContextSentenceIds.length > 0;
  const preciseRange = resolveParagraphPlaybackRange({
    unit,
    sentences: state.material?.sentences,
    mediaDuration: state.media?.duration,
  });
  const standard = {
    start: preciseRange.start,
    contentStart: preciseRange.contentStart,
    contentEnd: preciseRange.contentEnd,
    end: preciseRange.end,
    label: hasTrailingContext ? "当前自然分段 · 结尾含简短回应" : "当前自然分段",
    contextKind: null,
    hasTrailingContext,
    trailingContextSentenceIds,
    contextSentenceIds: [...unitSentenceIds(unit), ...trailingContextSentenceIds],
  };
  const leadIn = resolveParagraphLeadIn({ unit, paragraphs: state.material.paragraphs });
  if (!leadIn.seconds) return standard;
  const previous = state.material.paragraphs.find((paragraph) => paragraph.id === leadIn.previousParagraphId);
  const start = Math.min(standard.start, leadIn.start);
  const leadInSeconds = Math.max(0, standard.contentStart - start);
  return {
    ...standard,
    start,
    label: `当前自然分段 · 前 ${formatLeadInSeconds(leadInSeconds)} 秒为上文${hasTrailingContext ? " · 结尾含简短回应" : ""}`,
    contextKind: "lead-in",
    leadInSeconds,
    contextSentenceIds: [
      ...(previous?.sentenceIds?.slice(-1) || []),
      ...standard.contextSentenceIds,
    ],
  };
}

function formatLeadInSeconds(seconds) {
  return Number(seconds).toFixed(1).replace(/\.0$/, "");
}

function renderCurrentUnit() {
  const units = currentUnits();
  const unit = currentUnit();
  stopPronunciation();
  if (!unit) {
    clearPhraseExposureTracking();
    pauseMedia();
    elements.segmentContinuation.classList.add("is-hidden");
    updateUnitPlaybackProgress();
    renderPracticeProgress(0, 0);
    renderAskRail({ preserveScroll: true });
    if (inReviewMode() && !state.reviewQueueLoading) showToast("当前范围没有标记为需复习的片段");
    return;
  }

  const ids = unitSentenceIds(unit);
  const progress = state.material.progress || {};
  const savedDictation = ids.map((id) => progress[id]?.dictation).find(Boolean) || "";
  const savedParagraphReview = findParagraphReview(unit.id);

  pauseMedia();
  state.playbackPassEligible = false;
  state.completionPlaybackPass = null;
  const playbackRange = currentPlaybackRange(unit);
  if (state.media?.readyState >= 1) state.media.currentTime = Math.max(0, playbackRange.start - 0.08);
  const sequencePosition = inReviewMode() ? state.reviewQueueIndex + 1 : state.index + 1;
  const sequenceLength = inReviewMode() ? state.reviewQueue.length : units.length;
  renderPracticeProgress(sequencePosition, sequenceLength);
  elements.unitSpeaker.textContent = unit.speaker || "Speaker";
  elements.unitTime.textContent = playbackRange.contextKind === "lead-in"
    ? `${formatClock(playbackRange.start)} – ${formatClock(playbackRange.end)} · 正文 ${formatClock(playbackRange.contentStart)} 起`
    : `${formatClock(playbackRange.start)} – ${formatClock(playbackRange.end)}`;
  elements.unitPlaybackLabel.textContent = playbackRange.label;
  elements.unitPlaybackTrack.setAttribute("aria-label", `拖动定位${elements.unitPlaybackLabel.textContent}`);
  elements.answerSpeaker.textContent = `${unit.speaker || "Speaker"} · ${unit.wordCount || 0} words`;
  elements.dictationInput.value = savedDictation;
  elements.answerArea.classList.toggle("is-hidden", !state.revealed);
  elements.revealButton.classList.toggle("is-hidden", state.revealed);
  elements.editTranscriptButton.classList.add("is-hidden");
  elements.editTranscriptPanel.classList.add("is-hidden");
  elements.markReviewButton.classList.toggle("is-selected", Boolean(savedParagraphReview));
  elements.markReviewButton.setAttribute("aria-pressed", String(Boolean(savedParagraphReview)));
  elements.markReviewLabel.textContent = savedParagraphReview ? "已加入本段复习" : "加入本段复习";
  elements.markReviewHint.textContent = savedParagraphReview ? "会出现在复习模式中" : "需要再听时点这里";
  renderSegmentContinuation(unit, units);
  hideSelectionAction();
  elements.sentenceContext.classList.add("is-hidden");
  renderAnalysis(unit);
  renderDiff(elements.dictationInput.value, unit.text);
  updateUnitPlaybackProgress();
  if (elements.segmentDrawer.classList.contains("is-open")) renderSegmentDirectory();
  renderAskRail({ preserveScroll: true });
  scheduleAskPanelReposition();
}

function renderAnalysis(unit) {
  const sentenceItems = unit.sentenceIds
    .map((id) => state.material.sentences.find((sentence) => sentence.id === id));
  const analysisProgressText = ["pending", "processing"].includes(state.material.analysisStatus)
    ? `${state.material.stage || "所选 AI 正在生成讲解"}。原声和逐字稿已经可以练习，生成完成后这里会自动更新。`
    : "这处暂时没有生成讲解。";
  const fragment = document.createDocumentFragment();
  sentenceItems.forEach((sentence, index) => {
    try {
      if (!sentence) throw new Error(`Missing sentence at index ${index}`);
      fragment.append(createSentenceBreakdown(sentence, index, sentenceItems.length, analysisProgressText));
    } catch (error) {
      console.error("Failed to render sentence breakdown", {
        error,
        materialId: state.material?.id,
        paragraphId: unit.id,
        sentenceId: sentence?.id || unit.sentenceIds[index],
      });
      fragment.append(createSentenceRenderFallback({
        sentence,
        sentenceId: unit.sentenceIds[index],
        index,
        total: sentenceItems.length,
        unit,
      }));
    }
  });
  unitTrailingContextSentenceIds(unit)
    .map((id) => state.material.sentences.find((sentence) => sentence.id === id))
    .filter(Boolean)
    .forEach((sentence) => {
      try {
        fragment.append(createTrailingContextTurn(sentence));
      } catch (error) {
        console.error("Failed to render trailing context", {
          error,
          materialId: state.material?.id,
          paragraphId: unit.id,
          sentenceId: sentence.id,
        });
      }
    });
  elements.sentenceBreakdownList.replaceChildren(fragment);
  renderAskTextAnchors();
  schedulePhraseExposureTracking();
  scheduleAskPanelReposition();
}

function createSentenceRenderFallback({ sentence, sentenceId, index, total, unit }) {
  const article = document.createElement("article");
  article.className = "sentence-study-item is-render-error";
  article.dataset.sentenceId = sentence?.id || sentenceId || "";

  const header = document.createElement("header");
  const sequence = document.createElement("span");
  sequence.className = "sentence-study-sequence";
  sequence.textContent = String(index + 1).padStart(2, "0");

  const content = document.createElement("div");
  const meta = document.createElement("p");
  meta.className = "sentence-study-meta";
  meta.textContent = total > 1 && sentence
    ? `${sentence.speaker || "Speaker"} · ${formatClock(sentence.start)}–${formatClock(sentence.end)}`
    : sentence?.speaker || unit.speaker || "Speaker";
  const original = document.createElement("p");
  original.className = "sentence-study-original";
  original.textContent = sentence?.text || "这句原文暂时没有载入。";
  content.append(meta, original);
  header.append(sequence, content);

  const notice = document.createElement("div");
  notice.className = "sentence-render-error";
  const copy = document.createElement("p");
  copy.textContent = "这句讲解刚才没有显示完整，其他句子仍可继续学习。";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "text-button";
  retry.textContent = "重新显示";
  retry.addEventListener("click", () => {
    const activeUnit = currentUnit();
    if (activeUnit?.id === unit.id) renderAnalysis(activeUnit);
  });
  notice.append(copy, retry);
  article.append(header, notice);
  return article;
}

function createTrailingContextTurn(sentence) {
  const aside = document.createElement("aside");
  aside.className = "sentence-backchannel-context";
  aside.dataset.sentenceId = sentence.id;

  const marker = document.createElement("span");
  marker.className = "sentence-backchannel-marker";
  marker.textContent = "简短回应";

  const content = document.createElement("div");
  const meta = document.createElement("p");
  meta.className = "sentence-backchannel-meta";
  meta.textContent = `${sentence.speaker || "Speaker"} · ${formatClock(sentence.start)}–${formatClock(sentence.end)}`;
  const original = document.createElement("p");
  original.className = "sentence-backchannel-original askable-sentence";
  original.dataset.sentenceId = sentence.id;
  original.dataset.askSurface = "original";
  original.tabIndex = 0;
  original.textContent = sentence.text;
  content.append(meta, original);

  aside.append(marker, content);
  const audioButton = createSentenceAudioButton(sentence);
  if (audioButton) aside.append(audioButton);
  const savedNotes = createSavedLearningNotes(sentence.id, []);
  if (savedNotes) aside.append(savedNotes);
  return aside;
}

function createSentenceBreakdown(sentence, index, total, analysisProgressText) {
  const article = document.createElement("article");
  article.className = "sentence-study-item";
  article.dataset.sentenceId = sentence.id;
  const header = document.createElement("header");
  const sequence = document.createElement("span");
  sequence.className = "sentence-study-sequence";
  sequence.textContent = String(index + 1).padStart(2, "0");
  const originalGroup = document.createElement("div");
  const metaRow = document.createElement("div");
  metaRow.className = "sentence-study-meta-row";
  const meta = document.createElement("p");
  meta.className = "sentence-study-meta";
  meta.textContent = total > 1
    ? `${sentence.speaker || "Speaker"} · ${formatClock(sentence.start)}–${formatClock(sentence.end)}`
    : `${sentence.speaker || "Speaker"}`;
  const audioButton = createSentenceAudioButton(sentence);
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "text-button sentence-transcript-edit-button";
  editButton.textContent = "修正这句";
  editButton.setAttribute("aria-label", `修正第 ${index + 1} 句原文`);
  const original = document.createElement("p");
  original.className = "sentence-study-original askable-sentence";
  original.dataset.sentenceId = sentence.id;
  original.dataset.askSurface = "original";
  original.tabIndex = 0;
  original.title = "双击可修正这句原文";
  original.textContent = sentence.text;
  const openEditor = () => openSentenceTranscriptEditor({
    article,
    sentence,
    original,
    editButton,
    index,
    total,
  });
  editButton.addEventListener("click", openEditor);
  original.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    window.getSelection()?.removeAllRanges();
    state.selectionContext = null;
    hideSelectionAction();
    openEditor();
  });
  const editActions = document.createElement("div");
  editActions.className = "sentence-transcript-entry-actions";
  editActions.append(editButton);
  metaRow.append(meta);
  if (audioButton) metaRow.append(audioButton);
  originalGroup.append(metaRow, original, editActions);
  header.append(sequence, originalGroup);
  article.append(header);

  const analysis = sentence.analysis;
  if (!analysis) {
    const pending = document.createElement("p");
    pending.className = "sentence-analysis-pending";
    pending.textContent = analysisProgressText;
    article.append(pending);
    return article;
  }

  if (analysis.translationZh) article.append(createSentenceDetail("中文意思", analysis.translationZh, "translation"));
  if (analysis.explanationZh) article.append(createSentenceDetail("表达与语法", analysis.explanationZh, "explanation"));

  const notes = uniqueSpokenFormNotes((analysis.spokenFormNotes || []).map((note) => ({ ...note, sentenceId: sentence.id })));
  if (notes.length) {
    const noteSection = document.createElement("section");
    noteSection.className = "sentence-knowledge-section";
    const label = document.createElement("span");
    label.className = "sentence-detail-label";
    label.textContent = "口语与转写说明";
    const list = document.createElement("div");
    list.className = "sentence-note-list";
    notes.forEach((note) => list.append(createSentenceNote(note, {
      article,
      sentence,
      original,
      editButton,
      index,
      total,
    })));
    noteSection.append(label, list);
    article.append(noteSection);
  }

  const phrases = uniquePhrases((analysis.phrases || []).map((phrase) => ({ ...phrase, sentenceId: sentence.id })))
    .filter((phrase) => !isPhraseTooSimple(phrase.text));
  if (phrases.length) {
    const phraseSection = document.createElement("section");
    phraseSection.className = "sentence-knowledge-section";
    const label = document.createElement("span");
    label.className = "sentence-detail-label";
    label.textContent = "可复用表达";
    const list = document.createElement("div");
    list.className = "sentence-phrase-list";
    phrases.forEach((phrase) => list.append(createSentencePhrase(phrase)));
    phraseSection.append(label, list);
    article.append(phraseSection);
  }

  const savedNotes = createSavedLearningNotes(sentence.id, phrases);
  if (savedNotes) article.append(savedNotes);
  return article;
}

function openSentenceTranscriptEditor({
  article,
  sentence,
  original,
  editButton,
  index,
  total,
  suggestedText = "",
  suggestionHint = "",
}) {
  const normalizedSuggestion = String(suggestedText || "").trim();
  const suggestionCopy = suggestionHint
    || "已带入讲解中的建议修正。请结合原声核对，确认无误后再保存；此时尚未修改原文。";
  const existingEditor = article.querySelector(".sentence-transcript-editor");
  if (existingEditor) {
    if (normalizedSuggestion) {
      const existingTextarea = existingEditor.querySelector("textarea");
      const existingHint = existingEditor.querySelector(".sentence-transcript-edit-hint");
      if (existingTextarea) {
        existingTextarea.value = normalizedSuggestion;
        existingTextarea.dispatchEvent(new Event("input", { bubbles: true }));
        existingTextarea.focus();
        existingTextarea.setSelectionRange(existingTextarea.value.length, existingTextarea.value.length);
      }
      if (existingHint) {
        existingHint.classList.add("is-suggestion");
        existingHint.textContent = suggestionCopy;
      }
    }
    return;
  }
  const editor = document.createElement("form");
  editor.className = "sentence-transcript-editor";
  const label = document.createElement("label");
  label.textContent = "修正这句原文";
  const textarea = document.createElement("textarea");
  textarea.value = normalizedSuggestion || sentence.text;
  textarea.rows = Math.max(2, Math.min(6, Math.ceil(textarea.value.length / 70)));
  textarea.setAttribute("aria-label", `第 ${index + 1} 句修正后的英文原文`);
  const hint = document.createElement("p");
  hint.className = "sentence-transcript-edit-hint";
  hint.classList.toggle("is-suggestion", Boolean(normalizedSuggestion));
  hint.textContent = normalizedSuggestion
    ? suggestionCopy
    : "只修改本机逐字稿；原声时间和说话人不变，本句讲解会重新生成。";
  const status = document.createElement("p");
  status.className = "sentence-transcript-edit-status";
  status.setAttribute("role", "status");
  const actions = document.createElement("div");
  actions.className = "sentence-transcript-edit-actions";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "quiet-button";
  cancelButton.textContent = "取消";
  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  saveButton.className = "primary-button";
  saveButton.textContent = "保存并更新讲解";
  actions.append(cancelButton, saveButton);
  label.append(textarea);
  editor.append(label, hint, status, actions);

  const syncSaveState = () => {
    const nextText = textarea.value.trim();
    saveButton.disabled = editor.classList.contains("is-saving") || !nextText || nextText === sentence.text;
  };
  const close = () => {
    editor.remove();
    original.classList.remove("is-hidden");
    editButton.disabled = false;
    editButton.focus();
  };
  cancelButton.addEventListener("click", close);
  textarea.addEventListener("input", syncSaveState);
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !saveButton.disabled) {
      event.preventDefault();
      editor.requestSubmit();
    }
  });
  editor.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saveButton.disabled) return;
    const nextText = textarea.value.trim();
    const practiceColumn = elements.practiceColumn;
    const previousScrollTop = practiceColumn?.scrollTop || 0;
    editor.classList.add("is-saving");
    textarea.disabled = true;
    cancelButton.disabled = true;
    saveButton.disabled = true;
    saveButton.textContent = "保存中…";
    status.textContent = "正在保存到本机";
    const materialId = state.material.id;
    try {
      const payload = await api(`/api/materials/${materialId}/sentences/${sentence.id}`, {
        method: "PATCH",
        body: { text: nextText, expectedText: sentence.text },
      });
      if (state.material?.id !== materialId) {
        showToast("这句原文已保存在原材料中，并开始更新讲解");
        return;
      }
      state.material = payload.material;
      if (payload.job) {
        state.activeJobId = payload.job.id;
        state.material.analysisStatus = "processing";
        state.material.stage = payload.job.stage || "正在重新生成本句讲解";
        scheduleAnalysisStatusPoll(500);
      }
      const updatedSentence = state.material.sentences.find((item) => item.id === sentence.id);
      const replacement = createSentenceBreakdown(
        updatedSentence,
        index,
        total,
        "本句讲解正在更新。原声和修正后的逐字稿已经可以继续练习。",
      );
      if (article.isConnected) {
        article.replaceWith(replacement);
        replacement.querySelector(".sentence-transcript-edit-button")?.focus({ preventScroll: true });
        if (practiceColumn) practiceColumn.scrollTop = previousScrollTop;
      }
      showToast("这句原文已修正，正在更新本句讲解");
    } catch (error) {
      editor.classList.remove("is-saving");
      textarea.disabled = false;
      cancelButton.disabled = false;
      saveButton.textContent = "保存并更新讲解";
      const latestText = error.status === 409 && typeof error.payload?.currentText === "string"
        ? error.payload.currentText
        : "";
      if (latestText) {
        sentence.text = latestText;
        original.textContent = latestText;
        const currentSentence = state.material?.sentences?.find((item) => item.id === sentence.id);
        if (currentSentence) currentSentence.text = latestText;
        status.textContent = `已载入最新原文：“${latestText}”。你的输入仍保留，核对后可直接再次保存。`;
      } else {
        status.textContent = error.message;
      }
      syncSaveState();
      textarea.focus();
    }
  });

  original.classList.add("is-hidden");
  editButton.disabled = true;
  original.after(editor);
  syncSaveState();
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function createSentenceAudioButton(sentence) {
  if (!hasReliableSentencePlayback(sentence, state.media?.duration)) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sentence-audio-button";
  button.dataset.sentenceId = sentence.id;
  const playbackRange = resolveSentencePlaybackRange({
    sentence,
    sentences: state.material?.sentences,
    mediaDuration: state.media?.duration,
  });
  button.dataset.playLabel = playbackRange.expanded
    ? "播放本句完整原声，含前后衔接"
    : `播放第 ${formatClock(playbackRange.contentStart)} 到 ${formatClock(playbackRange.contentEnd)} 的本句原声`;
  button.setAttribute("aria-label", button.dataset.playLabel);
  button.setAttribute("aria-pressed", "false");
  button.dataset.playTitle = playbackRange.expanded ? "播放本句完整原声（含前后衔接）" : "播放本句原声";
  button.title = button.dataset.playTitle;
  button.append(createSpeakerIcon());
  button.addEventListener("pointerup", (event) => event.stopPropagation());
  button.addEventListener("click", () => toggleSentencePlayback(sentence, button));
  return button;
}

function createSentenceDetail(labelText, text, kind) {
  const section = document.createElement("section");
  section.className = `sentence-detail is-${kind}`;
  const label = document.createElement("span");
  label.className = "sentence-detail-label";
  label.textContent = labelText;
  const copy = document.createElement("p");
  copy.textContent = text;
  section.append(label, copy);
  return section;
}

function createSentenceNote(note, editorContext = null) {
  const item = document.createElement("article");
  item.className = `sentence-note is-${note.kind}`;
  const heading = document.createElement("div");
  const kind = document.createElement("span");
  kind.textContent = note.kind === "grammar"
    ? "语法问题"
    : note.kind === "mistranscription" ? "疑似转写错误" : "口语痕迹";
  const quote = document.createElement("strong");
  quote.className = "askable-sentence";
  quote.dataset.sentenceId = note.sentenceId;
  quote.dataset.askSurface = "note-source";
  quote.textContent = `“${note.sourceText}”`;
  heading.append(kind, quote);
  const explanation = document.createElement("p");
  explanation.textContent = note.explanationZh;
  item.append(heading, explanation);
  if (note.correctedEnglish) {
    const correction = document.createElement("div");
    correction.className = "sentence-note-correction";
    const correctionHeading = document.createElement("div");
    correctionHeading.className = "sentence-note-correction-heading";
    const correctionLabel = document.createElement("span");
    correctionLabel.textContent = note.kind === "grammar"
      ? "清晰、正确的表达"
      : note.kind === "mistranscription" ? "说话人实际最可能说的是" : "去掉口语痕迹后";
    const adoptButton = document.createElement("button");
    adoptButton.type = "button";
    adoptButton.className = "text-button sentence-note-adopt-button";
    adoptButton.textContent = "采用此修正";
    adoptButton.setAttribute("aria-label", `采用此修正：${note.correctedEnglish}`);
    adoptButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!editorContext) {
        showToast("暂时找不到这句原文，请刷新后再试");
        return;
      }
      openSentenceTranscriptEditor({
        ...editorContext,
        suggestedText: note.correctedEnglish,
        suggestionHint: "已带入讲解中的建议修正。请结合原声核对，确认无误后再点“保存并更新讲解”；此时尚未修改原文。",
      });
    });
    const correctedEnglish = document.createElement("p");
    correctedEnglish.className = "askable-sentence sentence-note-correction-text";
    correctedEnglish.dataset.sentenceId = note.sentenceId;
    correctedEnglish.dataset.askSurface = "note-correction";
    correctedEnglish.textContent = note.correctedEnglish;
    correctionHeading.append(correctionLabel, adoptButton);
    correction.append(correctionHeading, correctedEnglish);
    item.append(correction);
  }
  return item;
}

function createSentencePhrase(phrase) {
  const row = document.createElement("div");
  row.className = "sentence-phrase-row";
  row.dataset.phraseSentenceId = phrase.sentenceId;
  row.dataset.phraseText = phrase.text;
  const guideKey = phraseGuideScopedKey(state.material?.id, phrase.sentenceId, phrase.text);
  row.dataset.phraseGuideKey = guideKey;
  const content = document.createElement("div");
  const term = document.createElement("strong");
  term.className = "askable-sentence";
  term.dataset.sentenceId = phrase.sentenceId;
  term.dataset.askSurface = "phrase";
  term.textContent = phrase.text;
  const heading = document.createElement("div");
  heading.className = "sentence-phrase-heading";
  const copy = document.createElement("p");
  const phraseDetails = [phrase.meaningZh, phrase.usageZh]
    .filter(Boolean)
    .map((value) => String(value).replace(/[。.!！?？]+$/u, ""));
  copy.textContent = phraseDetails.length ? `${phraseDetails.join("。")}。` : "";
  const guideButton = document.createElement("button");
  guideButton.type = "button";
  guideButton.className = "text-button phrase-guide-toggle";
  guideButton.addEventListener("click", () => {
    if (state.expandedPhraseGuideKeys.has(guideKey)) state.expandedPhraseGuideKeys.delete(guideKey);
    else state.expandedPhraseGuideKeys.add(guideKey);
    syncPhraseGuideDisclosure(row, guideButton, phrase);
    if (state.expandedPhraseGuideKeys.has(guideKey)
      && !findPhraseGuide(phrase)
      && state.phraseGuideRequests.get(guideKey)?.status !== "pending") {
      void requestPhraseGuide(phrase);
    }
  });
  heading.append(term, guideButton);
  content.append(heading, copy);
  const history = createPhraseQuestionHistory(phrase);
  if (history) content.append(history);
  const actions = document.createElement("div");
  actions.className = "phrase-actions";
  const reviewButton = document.createElement("button");
  reviewButton.type = "button";
  reviewButton.className = "text-button";
  const saved = findPhraseReview(phrase.sentenceId, phrase.text);
  reviewButton.textContent = saved ? "已加入复习" : "加入复习";
  reviewButton.classList.toggle("is-saved", Boolean(saved));
  reviewButton.addEventListener("click", () => togglePhraseReview(phrase, reviewButton));
  const askButton = document.createElement("button");
  askButton.type = "button";
  askButton.className = "text-button";
  askButton.textContent = "深入问问";
  askButton.addEventListener("click", () => openAskPanel({
    sentenceId: phrase.sentenceId,
    sourceText: phrase.text,
    question: `“${phrase.text}”在这句话里是什么意思，适合在什么职场场景使用？`,
  }, askButton));
  actions.append(reviewButton, askButton);
  row.append(content, actions);
  syncPhraseGuideDisclosure(row, guideButton, phrase);
  return row;
}

function phraseGuideScopedKey(materialId, sentenceId, phraseText) {
  return [materialId || "", sentenceId || "", normalizeReviewText(phraseText)].join("|");
}

function findPhraseGuide(phrase, material = state.material) {
  const phraseKey = `${phrase.sentenceId}|${normalizeReviewText(phrase.text)}`;
  return (material?.phraseGuides || []).find((guide) => (
    guide.key === phraseKey
    || (guide.sentenceId === phrase.sentenceId && normalizeReviewText(guide.phraseText) === normalizeReviewText(phrase.text))
  )) || null;
}

function syncPhraseGuideDisclosure(row, button, phrase) {
  const guideKey = row.dataset.phraseGuideKey;
  const expanded = state.expandedPhraseGuideKeys.has(guideKey);
  const guide = findPhraseGuide(phrase);
  const requestState = state.phraseGuideRequests.get(guideKey);
  const panelId = phraseGuidePanelId(guideKey);
  button.textContent = expanded ? "收起讲解" : "展开讲解";
  button.setAttribute("aria-expanded", String(expanded));
  button.setAttribute("aria-controls", panelId);
  row.querySelector(".sentence-phrase-guide")?.remove();
  if (!expanded) return;
  const panel = createPhraseGuidePanel(phrase, guide, requestState, panelId);
  row.append(panel);
}

function phraseGuidePanelId(guideKey) {
  let hash = 2166136261;
  for (const character of String(guideKey || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `phrase-guide-${(hash >>> 0).toString(36)}`;
}

function createPhraseGuidePanel(phrase, guide, requestState, panelId) {
  const panel = document.createElement("section");
  panel.className = "sentence-phrase-guide";
  panel.id = panelId;
  panel.setAttribute("aria-label", `${phrase.text} 的展开讲解`);
  panel.setAttribute("aria-live", "polite");
  panel.setAttribute("aria-busy", String(!guide && requestState?.status === "pending"));
  if (!guide && requestState?.status === "pending") {
    const pending = document.createElement("p");
    pending.className = "phrase-guide-status is-pending";
    pending.setAttribute("role", "status");
    pending.textContent = "所选 AI 正在整理用法、搭配和更多职场例句…";
    panel.append(pending);
    return panel;
  }
  if (!guide && requestState?.status === "error") {
    const error = document.createElement("p");
    error.className = "phrase-guide-status is-error";
    error.setAttribute("role", "status");
    error.textContent = requestState.error || "这次没有生成成功。";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "text-button";
    retry.textContent = "重试";
    retry.addEventListener("click", () => void requestPhraseGuide(phrase));
    panel.append(error, retry);
    return panel;
  }
  if (!guide) {
    const ready = document.createElement("p");
    ready.className = "phrase-guide-status";
    ready.textContent = "展开后会结合当前原句，补充实际用法和更多职场例句。";
    panel.append(ready);
    return panel;
  }

  appendPhraseGuideSection(panel, "怎么用", guide.usageZh);
  if (guide.patternZh) appendPhraseGuideSection(panel, "搭配与句型", guide.patternZh);
  if (Array.isArray(guide.alternatives) && guide.alternatives.length) {
    const section = createPhraseGuideSection("类似表达");
    const list = document.createElement("ul");
    guide.alternatives.forEach((alternative) => {
      const item = document.createElement("li");
      const term = document.createElement("strong");
      term.textContent = alternative.text;
      const difference = document.createElement("span");
      difference.textContent = alternative.differenceZh;
      item.append(term, difference);
      list.append(item);
    });
    section.append(list);
    panel.append(section);
  }
  if (Array.isArray(guide.examples) && guide.examples.length) {
    const section = createPhraseGuideSection("更多职场例句");
    const list = document.createElement("ol");
    guide.examples.forEach((example) => {
      const item = document.createElement("li");
      const english = document.createElement("p");
      english.textContent = example.english;
      const meaning = document.createElement("p");
      meaning.textContent = example.meaningZh;
      item.append(english, meaning);
      list.append(item);
    });
    section.append(list);
    panel.append(section);
  }
  return panel;
}

function createPhraseGuideSection(labelText) {
  const section = document.createElement("div");
  section.className = "phrase-guide-section";
  const label = document.createElement("strong");
  label.textContent = labelText;
  section.append(label);
  return section;
}

function appendPhraseGuideSection(panel, labelText, copyText) {
  if (!copyText) return;
  const section = createPhraseGuideSection(labelText);
  const copy = document.createElement("p");
  copy.textContent = copyText;
  section.append(copy);
  panel.append(section);
}

function refreshVisiblePhraseGuide(phrase) {
  const guideKey = phraseGuideScopedKey(state.material?.id, phrase.sentenceId, phrase.text);
  const row = [...document.querySelectorAll(".sentence-phrase-row")]
    .find((candidate) => candidate.dataset.phraseGuideKey === guideKey);
  const button = row?.querySelector(".phrase-guide-toggle");
  if (row && button) syncPhraseGuideDisclosure(row, button, phrase);
}

async function requestPhraseGuide(phrase) {
  const materialId = state.material?.id;
  if (!materialId) return;
  const sentence = state.material.sentences.find((item) => item.id === phrase.sentenceId);
  if (!sentence) return showToast("没有找到这个表达对应的原句");
  const guideKey = phraseGuideScopedKey(materialId, phrase.sentenceId, phrase.text);
  if (state.phraseGuideRequests.get(guideKey)?.status === "pending") return;
  const requestToken = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  state.phraseGuideRequests.set(guideKey, { status: "pending", requestToken, error: "" });
  refreshVisiblePhraseGuide(phrase);
  try {
    const payload = await api(`/api/materials/${materialId}/phrase-guides`, {
      method: "POST",
      body: {
        sentenceId: phrase.sentenceId,
        phraseText: phrase.text,
        expectedSentenceText: sentence.text,
      },
    });
    const latest = state.phraseGuideRequests.get(guideKey);
    if (latest?.requestToken !== requestToken) return;
    const phraseGuide = payload.phraseGuide;
    if (!phraseGuide) throw new Error("所选 AI 没有返回表达讲解，请重试");
    state.phraseGuideRequests.delete(guideKey);
    if (state.material?.id === materialId) {
      state.material.phraseGuides = Array.isArray(state.material.phraseGuides) ? state.material.phraseGuides : [];
      const index = state.material.phraseGuides.findIndex((guide) => (
        guide.key === phraseGuide.key
        || (guide.sentenceId === phraseGuide.sentenceId
          && normalizeReviewText(guide.phraseText) === normalizeReviewText(phraseGuide.phraseText))
      ));
      if (index >= 0) state.material.phraseGuides[index] = phraseGuide;
      else state.material.phraseGuides.push(phraseGuide);
      refreshVisiblePhraseGuide(phrase);
    }
  } catch (error) {
    const latest = state.phraseGuideRequests.get(guideKey);
    if (latest?.requestToken !== requestToken) return;
    state.phraseGuideRequests.set(guideKey, {
      status: "error",
      requestToken,
      error: error.message || "展开讲解生成失败",
    });
    if (state.material?.id === materialId) refreshVisiblePhraseGuide(phrase);
  }
}

function questionHistoryItems(material = state.material) {
  const historyItems = Array.isArray(material?.qaHistory) ? material.qaHistory : [];
  const items = [];
  const historyIds = new Set();
  const compositeKeys = new Set();
  for (const item of historyItems) {
    const key = questionHistoryKey(item);
    if (item.id && historyIds.has(item.id)) continue;
    items.push({ ...item, materialId: material?.id || "", isLegacyReview: false });
    if (item.id) historyIds.add(item.id);
    if (key) compositeKeys.add(key);
  }
  for (const item of reviewItems(material).filter((candidate) => candidate.kind === "qa")) {
    const key = questionHistoryKey(item);
    // A review linked to a real history record is not a second copy of that
    // record. This also prevents a deliberately deleted history record from
    // being recreated by its still-saved review item.
    if (item.historyId || !key || compositeKeys.has(key)) continue;
    items.push({ ...item, materialId: material?.id || "", isLegacyReview: true });
    compositeKeys.add(key);
  }
  return items.sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0));
}

function questionHistoryKey(item) {
  const sentenceId = String(item?.sentenceId || "");
  const sourceText = normalizeReviewText(item?.sourceText || "");
  const question = normalizeReviewText(item?.question || "");
  return sentenceId && sourceText && question ? `${sentenceId}|${sourceText}|${question}` : "";
}

function createPhraseQuestionHistory(phrase) {
  const sourceKey = normalizeReviewText(phrase.text);
  const items = questionHistoryItems().filter((item) => (
    item.sentenceId === phrase.sentenceId && normalizeReviewText(item.sourceText) === sourceKey
  ));
  return createQuestionHistorySection(items, "phrase-question-history");
}

function createSavedLearningNotes(sentenceId, phrases = []) {
  const phraseKeys = new Set(phrases.map((phrase) => normalizeReviewText(phrase.text)));
  const notes = questionHistoryItems().filter((item) => (
    item.sentenceId === sentenceId && !phraseKeys.has(normalizeReviewText(item.sourceText))
  ));
  if (!notes.length) return null;
  return createQuestionHistorySection(notes, "sentence-question-history");
}

function createQuestionHistorySection(notes, className) {
  if (!notes.length) return null;
  const section = document.createElement("details");
  section.className = `question-history ${className}`;
  const sectionKey = questionHistorySectionKey(notes, className);
  section.open = !state.collapsedQuestionHistoryKeys.has(sectionKey);
  const summary = document.createElement("summary");
  summary.className = "question-history-heading";
  const sectionLabel = document.createElement("span");
  sectionLabel.className = "question-history-label";
  sectionLabel.textContent = `我的问问记录 · ${notes.length}`;
  const toggleCopy = document.createElement("span");
  toggleCopy.className = "question-history-toggle-copy";
  const renderSectionState = () => {
    toggleCopy.textContent = section.open ? "收起全部" : "展开全部";
  };
  renderSectionState();
  summary.append(sectionLabel, toggleCopy);
  section.append(summary);
  section.addEventListener("toggle", () => {
    if (section.open) state.collapsedQuestionHistoryKeys.delete(sectionKey);
    else state.collapsedQuestionHistoryKeys.add(sectionKey);
    renderSectionState();
  });
  notes.forEach((note, index) => section.append(createQuestionHistoryRecord(note, index === 0)));
  return section;
}

function questionHistorySectionKey(notes, className) {
  const first = notes[0] || {};
  const phraseScope = className === "phrase-question-history" ? normalizeReviewText(first.sourceText) : "";
  return [state.material?.id || "", className, first.sentenceId || "", phraseScope].join("|");
}

function createQuestionHistoryRecord(note, open) {
  const details = document.createElement("details");
  details.className = "question-history-record";
  details.open = open;
  const summary = document.createElement("summary");
  const questionMark = document.createElement("span");
  questionMark.textContent = "问";
  const question = document.createElement("strong");
  question.textContent = note.question;
  summary.append(questionMark, question);
  const body = document.createElement("div");
  body.className = "question-history-body";
  if (note.transcriptStatus === "likely_mistranscribed" && note.likelySpokenEnglish) {
    const reconstruction = document.createElement("div");
    reconstruction.className = "question-history-reconstruction";
    const label = document.createElement("span");
    label.textContent = "说话人实际最可能说的是";
    const english = document.createElement("p");
    english.textContent = note.likelySpokenEnglish;
    reconstruction.append(label, english);
    if (note.intendedMeaningZh) {
      const meaning = document.createElement("p");
      meaning.textContent = note.intendedMeaningZh;
      reconstruction.append(meaning);
    }
    body.append(reconstruction);
  }
  const answer = document.createElement("p");
  answer.className = "question-history-answer";
  renderPronounceableText(answer, note.answerZh || note.learningSummaryZh, note.learningTargetText || note.sourceText);
  body.append(answer);
  if (note.learningSummaryZh && normalizeReviewText(note.learningSummaryZh) !== normalizeReviewText(note.answerZh)) {
    const learningSummary = document.createElement("div");
    learningSummary.className = "question-history-summary";
    const label = document.createElement("span");
    label.textContent = "知识点总结";
    const copy = document.createElement("p");
    renderPronounceableText(copy, note.learningSummaryZh, note.learningTargetText || note.sourceText);
    learningSummary.append(label, copy);
    body.append(learningSummary);
  }
  if (note.grammarPointZh) {
    const grammar = document.createElement("div");
    grammar.className = "question-history-grammar";
    const label = document.createElement("span");
    label.textContent = "语法点";
    const copy = document.createElement("p");
    copy.textContent = note.grammarPointZh;
    grammar.append(label, copy);
    body.append(grammar);
  }
  const actions = document.createElement("div");
  actions.className = "question-history-actions";
  const askButton = document.createElement("button");
  askButton.type = "button";
  askButton.className = "text-button";
  askButton.textContent = "继续问问";
  askButton.addEventListener("click", () => openAskPanel({
    sentenceId: note.sentenceId,
    sourceText: note.sourceText,
    question: note.question,
  }, askButton));
  const reviewButton = document.createElement("button");
  reviewButton.type = "button";
  reviewButton.className = "text-button";
  const saved = findQuestionHistoryReview(note);
  reviewButton.textContent = saved ? "已加入复习" : "加入复习";
  reviewButton.classList.toggle("is-saved", Boolean(saved));
  reviewButton.addEventListener("click", () => toggleQuestionHistoryReview(note, reviewButton));
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "text-button question-history-delete";
  deleteButton.textContent = "删除记录";
  deleteButton.addEventListener("click", () => deleteQuestionHistoryRecord(note, deleteButton));
  actions.append(askButton, reviewButton, deleteButton);
  body.append(actions);
  details.append(summary, body);
  return details;
}

function findQuestionHistoryReview(note, material = state.material) {
  if (note.isLegacyReview) return reviewItems(material).find((item) => item.id === note.id);
  const key = questionHistoryKey(note);
  return reviewItems(material).find((item) => (
    item.kind === "qa"
    && (item.historyId === note.id || (!item.historyId && questionHistoryKey(item) === key))
  ));
}

async function toggleQuestionHistoryReview(note, button, materialId = note.materialId || state.material?.id) {
  if (!materialId) return;
  const previousReviewKey = currentReviewQueueItem()?.key || "";
  const previousReviewIndex = state.reviewQueueIndex;
  button.disabled = true;
  try {
    const material = state.material?.id === materialId ? state.material : null;
    const saved = findQuestionHistoryReview(note, material);
    if (saved) {
      const payload = await api(`/api/materials/${materialId}/review-items/${saved.id}`, { method: "DELETE" });
      if (state.material?.id === materialId) state.material = payload.material;
      showToast("已从复习中移除，问问记录仍会保留");
    } else {
      const payload = await api(`/api/materials/${materialId}/review-items`, {
        method: "POST",
        body: {
          kind: "qa",
          historyId: note.isLegacyReview ? undefined : note.id,
          sentenceId: note.sentenceId,
          sourceText: note.learningTargetText || note.sourceText,
          question: note.question,
          answerZh: note.answerZh,
          learningSummaryZh: note.learningSummaryZh,
          grammarPointZh: note.grammarPointZh || "",
        },
      });
      if (state.material?.id === materialId) state.material = payload.material;
      showToast("已把这条问问记录加入对应自然句复习");
    }
    if (state.material?.id === materialId && currentUnit()) {
      renderAnalysis(currentUnit());
      renderAskRail({ preserveScroll: true });
    }
    await syncReviewQueueAfterReviewMutation({ previousReviewKey, previousReviewIndex, materialId });
    loadMaterials();
  } catch (error) {
    button.disabled = false;
    showToast(error.message);
  }
}

async function deleteQuestionHistoryRecord(note, button, materialId = note.materialId || state.material?.id) {
  if (!materialId) return;
  if (button.dataset.confirming !== "true") {
    button.dataset.confirming = "true";
    button.textContent = "确认删除";
    button.classList.add("is-confirming");
    window.setTimeout(() => {
      if (!button.isConnected || button.disabled) return;
      button.dataset.confirming = "false";
      button.textContent = "删除记录";
      button.classList.remove("is-confirming");
    }, 5000);
    return;
  }

  button.disabled = true;
  const previousReviewKey = currentReviewQueueItem()?.key || "";
  const previousReviewIndex = state.reviewQueueIndex;
  const material = state.material?.id === materialId ? state.material : null;
  const linkedReviewWillRemain = !note.isLegacyReview && Boolean(findQuestionHistoryReview(note, material));
  try {
    const endpoint = note.isLegacyReview
      ? `/api/materials/${materialId}/review-items/${note.id}`
      : `/api/materials/${materialId}/qa-history/${note.id}`;
    const payload = await api(endpoint, { method: "DELETE" });
    if (state.material?.id === materialId) state.material = payload.material;
    for (const [cardId, card] of state.askThreads) {
      if (card.materialId === materialId && card.historyId === note.id) state.askThreads.delete(cardId);
    }
    if (note.isLegacyReview) showToast("旧版问问记录已删除，并已从复习中移除");
    else if (linkedReviewWillRemain) showToast("问问记录已删除，已加入复习的内容仍保留");
    else showToast("问问记录已删除");
    if (state.material?.id === materialId && currentUnit()) {
      renderAnalysis(currentUnit());
      renderAskRail({ preserveScroll: true });
    }
    if (note.isLegacyReview) {
      await syncReviewQueueAfterReviewMutation({ previousReviewKey, previousReviewIndex, materialId });
    }
    loadMaterials();
  } catch (error) {
    button.disabled = false;
    button.dataset.confirming = "false";
    button.textContent = "删除记录";
    button.classList.remove("is-confirming");
    showToast(error.message);
  }
}

function revealAnswer() {
  state.revealed = true;
  elements.answerArea.classList.remove("is-hidden");
  elements.revealButton.classList.add("is-hidden");
  renderDiff(elements.dictationInput.value, currentUnit().text);
  renderAskTextAnchors();
  renderSegmentContinuation(currentUnit(), currentUnits());
  schedulePhraseExposureTracking();
}

function phraseExposureKey(materialId, sentenceId, phraseText) {
  return [materialId || "", sentenceId || "", normalizeReviewText(phraseText)].join("|");
}

function clearPhraseExposureTracking() {
  state.phraseExposureObserver?.disconnect();
  state.phraseExposureObserver = null;
  state.phraseExposureTimers.forEach((timer) => clearTimeout(timer));
  state.phraseExposureTimers.clear();
}

function schedulePhraseExposureTracking() {
  clearPhraseExposureTracking();
  if (!state.revealed || !state.material || !currentUnit() || typeof IntersectionObserver !== "function") return;
  const materialId = state.material.id;
  const unitSentenceIdSet = new Set(unitSentenceIds(currentUnit()));
  const rows = [...elements.sentenceBreakdownList.querySelectorAll(".sentence-phrase-row[data-phrase-sentence-id]")]
    .filter((row) => unitSentenceIdSet.has(row.dataset.phraseSentenceId));
  if (!rows.length) return;
  const root = globalThis.matchMedia?.("(min-width: 1061px)")?.matches ? elements.practiceColumn : null;
  state.phraseExposureObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const row = entry.target;
      const key = phraseExposureKey(materialId, row.dataset.phraseSentenceId, row.dataset.phraseText);
      const existingTimer = state.phraseExposureTimers.get(row);
      if (!entry.isIntersecting || entry.intersectionRatio < PHRASE_EXPOSURE_MIN_RATIO) {
        if (existingTimer) clearTimeout(existingTimer);
        state.phraseExposureTimers.delete(row);
        return;
      }
      if (existingTimer || state.phraseExposureRecorded.has(key) || state.phraseExposurePending.has(key)) return;
      const timer = setTimeout(() => {
        state.phraseExposureTimers.delete(row);
        const current = currentUnit();
        if (!row.isConnected
          || !state.revealed
          || state.material?.id !== materialId
          || !current
          || !unitSentenceIds(current).includes(row.dataset.phraseSentenceId)) return;
        void recordPhraseExposure({
          materialId,
          sentenceId: row.dataset.phraseSentenceId,
          phraseText: row.dataset.phraseText,
          key,
        });
      }, PHRASE_EXPOSURE_DELAY_MS);
      state.phraseExposureTimers.set(row, timer);
    });
  }, { root, threshold: [0, PHRASE_EXPOSURE_MIN_RATIO] });
  rows.forEach((row) => state.phraseExposureObserver.observe(row));
}

async function recordPhraseExposure({ materialId, sentenceId, phraseText, key }) {
  if (state.phraseExposureRecorded.has(key) || state.phraseExposurePending.has(key)) return;
  state.phraseExposurePending.add(key);
  try {
    const payload = await api("/api/learner-profile/phrase-signals", {
      method: "POST",
      body: {
        event: "exposed",
        materialId,
        sentenceId,
        phraseText,
        sessionId: PHRASE_SIGNAL_SESSION_ID,
      },
    });
    state.phraseExposureRecorded.add(key);
    if (payload.profile) state.learnerProfile = payload.profile;
  } catch (error) {
    console.warn("Failed to record phrase exposure", { materialId, sentenceId, error });
  } finally {
    state.phraseExposurePending.delete(key);
  }
}

function renderSegmentContinuation(unit = currentUnit(), units = currentUnits()) {
  const visible = Boolean(state.revealed && unit && units.length);
  elements.segmentContinuation.classList.toggle("is-hidden", !visible);
  if (!visible) return;

  const currentIndex = inReviewMode()
    ? state.reviewQueueIndex
    : units.findIndex((candidate) => candidate.id === unit.id);
  const total = inReviewMode() ? state.reviewQueue.length : units.length;
  const resolvedIndex = currentIndex >= 0 ? currentIndex : Math.min(Math.max(0, state.index), total - 1);
  const canAdvance = resolvedIndex < total - 1;
  elements.bottomNextButton.classList.toggle("is-hidden", !canAdvance);
  elements.segmentCompleteState.classList.toggle("is-hidden", canAdvance);

  if (canAdvance) {
    const nextPosition = resolvedIndex + 2;
    elements.bottomNextEyebrow.textContent = inReviewMode() ? "继续本轮复习" : "继续精听";
    elements.bottomNextLabel.textContent = inReviewMode() ? "下一条需复习片段" : "下一段";
    elements.bottomNextHint.textContent = `第 ${nextPosition} / ${total} 段 · 回到顶部并自动播放原声`;
    elements.bottomNextButton.setAttribute("aria-label", `进入第 ${nextPosition} 段并自动播放原声`);
  } else {
    elements.segmentCompleteLabel.textContent = inReviewMode() ? "本轮复习已到最后一段" : "已到最后一段";
  }
}

function advanceFromBottom() {
  const units = currentUnits();
  const unit = currentUnit();
  if (!unit || !units.length) return;
  if (inReviewMode()) {
    if (state.reviewQueueIndex >= state.reviewQueue.length - 1) return;
    void activateReviewQueueIndex(state.reviewQueueIndex + 1, { autoplay: true, resetScroll: false }).then((activated) => {
      if (!activated) return;
      const position = state.reviewQueueIndex + 1;
      requestAnimationFrame(() => {
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        scrollTrainingWorkspaceToTop({ behavior: reducedMotion ? "auto" : "smooth" });
        elements.listenPrompt.focus({ preventScroll: true });
        elements.unitNavigationStatus.textContent = `已进入第 ${position} / ${state.reviewQueue.length} 条复习内容，正在播放原声`;
      });
    });
    return;
  }
  const currentIndex = units.findIndex((candidate) => candidate.id === unit.id);
  const resolvedIndex = currentIndex >= 0 ? currentIndex : Math.min(Math.max(0, state.index), units.length - 1);
  if (resolvedIndex >= units.length - 1) return;

  state.index = resolvedIndex;
  navigateUnit(1, true, { resetScroll: false });
  const position = state.index + 1;
  const total = currentUnits().length;
  requestAnimationFrame(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollTrainingWorkspaceToTop({ behavior: reducedMotion ? "auto" : "smooth" });
    elements.listenPrompt.focus({ preventScroll: true });
    elements.unitNavigationStatus.textContent = `已进入第 ${position} / ${total} 段，正在播放原声`;
  });
}

function scrollTrainingWorkspaceToTop({ behavior = "auto" } = {}) {
  if (window.matchMedia("(min-width: 1061px)").matches) {
    window.scrollTo({ top: 0, behavior: "auto" });
    elements.mediaColumn.scrollTo({ top: 0, behavior });
    elements.practiceColumn.scrollTo({ top: 0, behavior });
    return;
  }
  elements.trainingGrid.scrollIntoView({ behavior, block: "start" });
}

function renderSentenceContext(unit) {
  const visible = state.mode === "sentences";
  elements.sentenceContext.classList.toggle("is-hidden", !visible);
  if (!visible) return;
  const index = state.material.sentences.findIndex((sentence) => sentence.id === unit.id);
  const previous = state.material.sentences[index - 1]?.text || "";
  const next = state.material.sentences[index + 1]?.text || "";
  elements.previousSentenceContext.textContent = previous ? `上一句 · ${previous}` : "";
  elements.currentSentenceContext.textContent = `当前句 · ${unit.text}`;
  elements.nextSentenceContext.textContent = next ? `下一句 · ${next}` : "";
  elements.previousSentenceContext.classList.toggle("is-hidden", !previous);
  elements.nextSentenceContext.classList.toggle("is-hidden", !next);
}

function findPhraseReview(sentenceId, sourceText) {
  const key = normalizeReviewText(sourceText);
  return reviewItems().find((item) => item.kind === "phrase" && item.sentenceId === sentenceId && normalizeReviewText(item.sourceText) === key);
}

function findParagraphReview(paragraphId) {
  return reviewItems().find((item) => item.kind === "paragraph" && item.paragraphId === paragraphId);
}

async function togglePhraseReview(phrase, button) {
  const materialId = state.material?.id;
  const previousReviewKey = currentReviewQueueItem()?.key || "";
  const previousReviewIndex = state.reviewQueueIndex;
  if (!materialId) return;
  button.disabled = true;
  try {
    const saved = findPhraseReview(phrase.sentenceId, phrase.text);
    if (saved) {
      const payload = await api(`/api/materials/${materialId}/review-items/${saved.id}`, { method: "DELETE" });
      state.material = payload.material;
      showToast("已从复习中移除");
    } else {
      const payload = await api(`/api/materials/${materialId}/review-items`, {
        method: "POST",
        body: {
          kind: "phrase",
          sentenceId: phrase.sentenceId,
          sourceText: phrase.text,
          meaningZh: phrase.meaningZh || "这个表达值得结合原句复习。",
          usageZh: phrase.usageZh || "",
        },
      });
      state.material = payload.material;
      showToast("已按自然句加入复习");
    }
    renderCurrentUnit();
    await syncReviewQueueAfterReviewMutation({ previousReviewKey, previousReviewIndex, materialId });
    loadMaterials();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function syncReviewQueueAfterReviewMutation({ previousReviewKey = "", previousReviewIndex = 0, materialId = "" } = {}) {
  if (!inReviewMode()) return true;
  const refreshed = await refreshReviewQueue({ preferredKey: previousReviewKey, preferredMaterialId: materialId });
  if (!refreshed || !inReviewMode()) return false;
  if (!state.reviewQueue.length) {
    state.revealed = false;
    commitReviewStudyState();
    renderCurrentUnit();
    return true;
  }
  const preservedIndex = previousReviewKey
    ? state.reviewQueue.findIndex((item) => item.key === previousReviewKey)
    : -1;
  const targetIndex = preservedIndex >= 0
    ? preservedIndex
    : Math.min(Math.max(0, previousReviewIndex), state.reviewQueue.length - 1);
  return activateReviewQueueIndex(targetIndex, { autoplay: false, resetScroll: false });
}

async function markPhraseTooSimple(phrase, button) {
  const sentence = state.material.sentences.find((item) => item.id === phrase.sentenceId);
  if (!sentence) return showToast("没有找到知识点对应的原句");
  button.disabled = true;
  try {
    const payload = await api("/api/learner-profile/too-simple", {
      method: "POST",
      body: {
        materialId: state.material.id,
        sentenceId: phrase.sentenceId,
        text: phrase.text,
        meaningZh: phrase.meaningZh || "",
        usageZh: phrase.usageZh || "",
      },
    });
    state.learnerProfile = payload.profile;
    renderAnalysis(currentUnit());
    const sampleCount = state.learnerProfile.tooSimple.length;
    showToast(`已记住这个难度样本（累计 ${sampleCount} 个），今后会减少类似基础表达`, {
      label: "撤销",
      onAction: () => undoTooSimpleFeedback(payload.feedback.id),
    });
  } catch (error) {
    button.disabled = false;
    showToast(error.message);
  }
}

async function undoTooSimpleFeedback(feedbackId) {
  try {
    const payload = await api(`/api/learner-profile/too-simple/${feedbackId}`, { method: "DELETE" });
    state.learnerProfile = payload.profile;
    renderAnalysis(currentUnit());
    showToast("已撤销，这个知识点会重新显示");
  } catch (error) {
    showToast(error.message);
  }
}

function scheduleSelectionAction() {
  requestAnimationFrame(updateSelectionAction);
}

function defaultSelectionQuestion(sourceText) {
  return `“${sourceText}”怎么发音，以及在这里是什么意思？`;
}

function updateSelectionAction() {
  const selection = window.getSelection();
  const selectedText = String(selection?.toString() || "").replace(/\s+/g, " ").trim();
  if (!selection || selection.rangeCount !== 1 || !selectedText || selectedText.length > 300) return hideSelectionAction();
  const range = selection.getRangeAt(0);
  const startSentence = closestAskableSentence(range.startContainer);
  const endSentence = closestAskableSentence(range.endContainer);
  const isSupportedSurface = startSentence && (
    elements.sentenceBreakdownList.contains(startSentence)
    || elements.diffText.contains(startSentence)
  );
  if (!startSentence || startSentence !== endSentence || !isSupportedSurface) {
    hideSelectionAction();
    if (startSentence && endSentence && startSentence !== endSentence) showToast("请一次选择同一句里的内容");
    return;
  }
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return hideSelectionAction();
  const textAnchor = createAskTextAnchor(startSentence, range);
  if (!textAnchor) return hideSelectionAction();
  state.selectionContext = {
    sentenceId: startSentence.dataset.sentenceId,
    sourceText: selectedText,
    question: defaultSelectionQuestion(selectedText),
    anchorSurface: askAnchorSurface(startSentence),
    ...textAnchor,
    anchorRect: snapshotRect(rect),
    returnFocus: startSentence,
  };
  elements.selectionAskButton.style.left = `${Math.max(12, Math.min(window.innerWidth - 104, rect.left + rect.width / 2 - 43))}px`;
  elements.selectionAskButton.style.top = `${Math.max(12, rect.top - 43)}px`;
  elements.selectionAskButton.classList.remove("is-hidden");
}

function createAskTextAnchor(surface, range) {
  if (!surface?.contains(range.startContainer) || !surface.contains(range.endContainer)) return null;
  const surfaceText = surface.textContent || "";
  const before = document.createRange();
  before.selectNodeContents(surface);
  before.setEnd(range.startContainer, range.startOffset);
  let anchorStart = before.toString().length;
  let anchorEnd = anchorStart + range.toString().length;
  const rawExact = surfaceText.slice(anchorStart, anchorEnd);
  const leadingWhitespace = rawExact.match(/^\s*/u)?.[0].length || 0;
  const trailingWhitespace = rawExact.match(/\s*$/u)?.[0].length || 0;
  anchorStart += leadingWhitespace;
  anchorEnd -= trailingWhitespace;
  const anchorExact = surfaceText.slice(anchorStart, anchorEnd);
  if (!anchorExact || anchorEnd <= anchorStart || anchorExact.length > 500) return null;
  return {
    anchorSurfaceText: surfaceText,
    anchorStart,
    anchorEnd,
    anchorExact,
    prefix: surfaceText.slice(Math.max(0, anchorStart - 64), anchorStart),
    suffix: surfaceText.slice(anchorEnd, anchorEnd + 64),
  };
}

function createWholeSurfaceAnchor(surface) {
  const anchorSurfaceText = surface?.textContent || "";
  if (!anchorSurfaceText || anchorSurfaceText.length > 500) return null;
  return {
    anchorSurfaceText,
    anchorStart: 0,
    anchorEnd: anchorSurfaceText.length,
    anchorExact: anchorSurfaceText,
    prefix: "",
    suffix: "",
  };
}

function askTextAnchorPayload(anchor) {
  if (!anchor?.anchorSurface
    || !anchor.anchorSurfaceText
    || !anchor.anchorExact
    || !Number.isInteger(anchor.anchorStart)
    || !Number.isInteger(anchor.anchorEnd)) return {};
  return {
    anchorSurface: anchor.anchorSurface,
    anchorSurfaceText: anchor.anchorSurfaceText,
    anchorStart: anchor.anchorStart,
    anchorEnd: anchor.anchorEnd,
    anchorExact: anchor.anchorExact,
    prefix: anchor.prefix || "",
    suffix: anchor.suffix || "",
  };
}

function closestAskableSentence(node) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return element?.closest?.(".askable-sentence") || null;
}

function hideSelectionAction() {
  elements.selectionAskButton.classList.add("is-hidden");
}

function askAboutSelection() {
  if (!state.selectionContext) return;
  const context = state.selectionContext;
  hideSelectionAction();
  window.getSelection()?.removeAllRanges();
  openAskPanel(context);
}

function openAskPanel(context, anchorElement = null) {
  if (!state.material) return;
  stopPronunciation();
  const sentence = state.material.sentences.find((item) => item.id === context.sentenceId);
  if (!sentence) return showToast("没有找到这处原文对应的自然句");
  const sourceText = String(context.sourceText || "").trim();
  if (!sourceText) return showToast("请先选择或指定想问的内容");
  const initialAnchor = resolveInitialAskAnchor(context, anchorElement);
  const textAnchor = context.anchorExact
    ? {
      anchorSurfaceText: context.anchorSurfaceText,
      anchorStart: context.anchorStart,
      anchorEnd: context.anchorEnd,
      anchorExact: context.anchorExact,
      prefix: context.prefix ?? context.anchorPrefix ?? "",
      suffix: context.suffix ?? context.anchorSuffix ?? "",
    }
    : createWholeSurfaceAnchor(initialAnchor);
  const cardId = createAskCardId();
  const card = {
    cardId,
    materialId: state.material.id,
    sentenceId: sentence.id,
    sentenceText: sentence.text,
    sourceText,
    learningTargetText: sourceText,
    anchorSurface: context.anchorSurface || askAnchorSurface(initialAnchor),
    ...(textAnchor || {}),
    question: typeof context.question === "string" ? context.question : defaultSelectionQuestion(sourceText),
    status: "draft",
    error: "",
    createdAt: new Date().toISOString(),
    requestToken: "",
    returnFocus: context.returnFocus || anchorElement || initialAnchor || null,
    speaker: sentence.speaker || "",
    start: sentence.start,
    end: sentence.end,
  };
  state.askThreads.set(cardId, card);
  state.activeAskThreadId = cardId;
  state.askRailCollapsed = false;
  setAskAnchorElement(initialAnchor);
  if (window.innerWidth < 1880 && elements.segmentDrawer.classList.contains("is-open")) closeSegmentDrawer(false);
  renderAskRail({ preserveScroll: true, focusCardId: cardId });
}

function createAskCardId() {
  return `ask-${Date.now()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}

function askCardsForMaterial(material = state.material) {
  if (!material?.id) return [];
  const unit = material.id === state.material?.id ? currentUnit() : null;
  return mergeAskThreadCards({
    materialId: material.id,
    sentenceIds: unit ? unitSentenceIds(unit) : [],
    historyItems: questionHistoryItems(material),
    transientCards: state.askThreads,
  });
}

function askCardById(cardId, material = state.material) {
  return askCardsForMaterial(material).find((card) => card.cardId === cardId) || null;
}

function hideAskRail() {
  if (!elements.askPanel.classList.contains("is-hidden")) {
    state.askRailScrollTop = elements.askThreadList.scrollTop;
  }
  elements.askPanel.classList.add("is-hidden");
  elements.askRailToggle.classList.add("is-hidden");
  elements.trainingView.classList.remove("has-ask-thread");
  document.body.classList.remove("has-ask-thread");
  setAskAnchorElement(null);
  schedulePaneResizeRefresh();
}

function collapseAskRail(restoreFocus = true) {
  const activeCard = askCardById(state.activeAskThreadId);
  state.askRailScrollTop = elements.askThreadList.scrollTop;
  state.askRailCollapsed = true;
  renderAskRail({ preserveScroll: true });
  if (restoreFocus && activeCard?.returnFocus?.isConnected) {
    activeCard.returnFocus.focus?.({ preventScroll: true });
  }
}

function expandAskRail() {
  if (!state.material || !askCardsForMaterial().length) return;
  state.askRailCollapsed = false;
  renderAskRail({ preserveScroll: true });
  requestAnimationFrame(() => elements.closeAskPanelButton.focus({ preventScroll: true }));
}

function renderAskRail({ preserveScroll = false, focusCardId = "" } = {}) {
  const material = state.material;
  if (!material || elements.trainingView.classList.contains("is-hidden")) {
    hideAskRail();
    return;
  }
  const cards = askCardsForMaterial(material);
  if (!cards.length) {
    state.activeAskThreadId = null;
    elements.askThreadList.replaceChildren();
    elements.askRailTotalCount.textContent = "0 条问问";
    elements.askRailToggleCount.textContent = "0";
    elements.askRailPendingCount.classList.add("is-hidden");
    elements.askRailTogglePending.classList.add("is-hidden");
    renderAskTextAnchors([]);
    hideAskRail();
    return;
  }
  if (!cards.some((card) => card.cardId === state.activeAskThreadId)) {
    state.activeAskThreadId = cards[0].cardId;
  }
  const previousScrollTop = preserveScroll ? elements.askThreadList.scrollTop || state.askRailScrollTop : 0;
  const focusedCardId = document.activeElement?.closest?.("[data-ask-card-id]")?.dataset.askCardId || "";
  const focusedAction = document.activeElement?.dataset?.askAction || "";
  const selectionStart = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement.selectionStart : null;
  const selectionEnd = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement.selectionEnd : null;
  const counts = countAskThreadCards(cards);
  elements.askRailTotalCount.textContent = `${counts.total} 条问问`;
  elements.askRailToggleCount.textContent = String(counts.total);
  elements.askRailPendingCount.textContent = `${counts.pending} 条生成中`;
  elements.askRailPendingCount.classList.toggle("is-hidden", counts.pending === 0);
  elements.askRailTogglePending.classList.toggle("is-hidden", counts.pending === 0);
  elements.askThreadEmpty.classList.toggle("is-hidden", cards.length > 0);
  const fragment = document.createDocumentFragment();
  cards.forEach((card, index) => fragment.append(renderAskThreadCard(card, index)));
  elements.askThreadList.replaceChildren(fragment);
  renderAskTextAnchors(cards);
  syncActiveAskThreadPresentation();
  if (state.askRailCollapsed) {
    elements.askPanel.classList.add("is-hidden");
    elements.askRailToggle.classList.remove("is-hidden");
    elements.askRailToggle.setAttribute("aria-expanded", "false");
    elements.trainingView.classList.remove("has-ask-thread");
    document.body.classList.remove("has-ask-thread");
  } else {
    elements.askPanel.classList.remove("is-hidden");
    elements.askRailToggle.classList.add("is-hidden");
    elements.askRailToggle.setAttribute("aria-expanded", "true");
    elements.trainingView.classList.add("has-ask-thread");
    document.body.classList.add("has-ask-thread");
  }
  requestAnimationFrame(() => {
    elements.askThreadList.scrollTop = previousScrollTop;
    const targetCardId = focusCardId || focusedCardId;
    const target = targetCardId
      ? elements.askThreadList.querySelector(`[data-ask-card-id="${CSS.escape(targetCardId)}"]`)
      : null;
    if (focusCardId && target) {
      target.open = true;
      target.querySelector("textarea")?.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest" });
    } else if (target && focusedAction) {
      const control = target.querySelector(`[data-ask-action="${CSS.escape(focusedAction)}"]`);
      control?.focus({ preventScroll: true });
      if (control instanceof HTMLTextAreaElement && selectionStart !== null) {
        control.setSelectionRange(selectionStart, selectionEnd);
      }
    }
    state.askRailScrollTop = elements.askThreadList.scrollTop;
    schedulePaneResizeRefresh();
    scheduleAskPanelReposition();
  });
}

function renderAskThreadCard(card, index) {
  const details = document.createElement("details");
  details.className = `ask-thread-card is-${card.status || "complete"}`;
  details.classList.toggle("is-active", card.cardId === state.activeAskThreadId);
  details.dataset.askCardId = card.cardId;
  details.open = !state.collapsedAskThreadIds.has(card.cardId)
    && (card.cardId === state.activeAskThreadId || card.status !== "complete" || index === 0);
  details.addEventListener("toggle", () => {
    if (details.open) {
      state.collapsedAskThreadIds.delete(card.cardId);
      state.activeAskThreadId = card.cardId;
      syncActiveAskThreadPresentation();
      scheduleAskPanelReposition();
    } else {
      state.collapsedAskThreadIds.add(card.cardId);
    }
  });
  details.addEventListener("pointerdown", () => {
    state.activeAskThreadId = card.cardId;
    syncActiveAskThreadPresentation();
    scheduleAskPanelReposition();
  });

  const summary = document.createElement("summary");
  summary.className = "ask-thread-card-summary";
  const summaryCopy = document.createElement("span");
  summaryCopy.className = "ask-thread-card-summary-copy";
  const kicker = document.createElement("span");
  kicker.className = "ask-thread-card-kicker";
  kicker.textContent = card.status === "pending" ? "正在回答" : card.status === "error" ? "回答失败" : "问问这处";
  const quote = document.createElement("strong");
  quote.className = "ask-thread-quote";
  quote.textContent = card.learningTargetText || card.sourceText || "这处表达";
  summaryCopy.append(kicker, quote);
  const status = document.createElement("span");
  status.className = `ask-thread-card-status is-${card.status || "complete"}`;
  status.textContent = card.status === "pending" ? "生成中" : card.status === "error" ? "重试" : card.status === "draft" ? "待提问" : "已回答";
  summary.append(summaryCopy, status);

  const body = document.createElement("div");
  body.className = "ask-thread-card-body";
  const source = document.createElement("div");
  source.className = "ask-thread-source";
  const sentenceText = card.sentenceText || card.record?.sentenceText || "";
  if (sentenceText) {
    const sourceText = document.createElement("p");
    sourceText.textContent = sentenceText;
    source.append(sourceText);
  }
  const sourceMeta = document.createElement("span");
  sourceMeta.className = "ask-thread-source-meta";
  const speaker = card.speaker || card.record?.speaker || "";
  const start = Number(card.start ?? card.record?.start);
  sourceMeta.textContent = [speaker, Number.isFinite(start) ? formatClock(start) : ""].filter(Boolean).join(" · ") || "对应原句";
  source.append(sourceMeta);
  body.append(source);

  const question = String(card.question || card.record?.question || "").trim();
  if (card.status === "draft" || card.status === "error") {
    const draft = document.createElement("div");
    draft.className = "ask-thread-draft";
    const label = document.createElement("label");
    label.textContent = "你还想知道什么？";
    const textarea = document.createElement("textarea");
    textarea.value = question;
    textarea.rows = 4;
    textarea.dataset.askAction = "question";
    textarea.addEventListener("input", () => {
      const latest = state.askThreads.get(card.cardId);
      if (latest) latest.question = textarea.value;
    });
    textarea.addEventListener("keydown", (event) => {
      const isComposing = event.isComposing || event.keyCode === 229;
      if (event.key !== "Enter" || event.shiftKey || isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      const latest = state.askThreads.get(card.cardId);
      if (latest) latest.question = textarea.value;
      void submitLearningQuestion(card.cardId);
    });
    label.append(textarea);
    draft.append(label);
    body.append(draft);
  } else if (question) {
    const questionCopy = document.createElement("p");
    questionCopy.className = "ask-thread-question";
    questionCopy.textContent = question;
    body.append(questionCopy);
  }

  if (card.status === "pending") {
    const pending = document.createElement("p");
    pending.className = "ask-thread-status-message is-pending";
    pending.textContent = "所选 AI 正在结合原句和前后语境回答。你可以继续问下一处。";
    body.append(pending);
  }
  if (card.status === "error") {
    const error = document.createElement("p");
    error.className = "ask-thread-status-message is-error";
    error.textContent = card.error || "这次没有回答成功，可以单独重试这张卡片。";
    body.append(error);
  }

  const note = card.record || card.historyItem || (card.status === "complete" ? card : null);
  if (note && card.status === "complete") {
    if (note.transcriptStatus === "likely_mistranscribed" && note.likelySpokenEnglish) {
      const reconstruction = document.createElement("div");
      reconstruction.className = "ask-thread-reconstruction";
      const label = document.createElement("strong");
      label.textContent = "说话人实际最可能说的是";
      const english = document.createElement("p");
      english.textContent = note.likelySpokenEnglish;
      reconstruction.append(label, english);
      if (note.intendedMeaningZh) {
        const meaning = document.createElement("p");
        meaning.textContent = note.intendedMeaningZh;
        reconstruction.append(meaning);
      }
      body.append(reconstruction);
    }
    const answer = document.createElement("div");
    answer.className = "ask-thread-answer";
    renderPronounceableText(answer, note.answerZh || note.learningSummaryZh || "", note.learningTargetText || note.sourceText || card.sourceText);
    body.append(answer);
    if (note.learningSummaryZh && normalizeReviewText(note.learningSummaryZh) !== normalizeReviewText(note.answerZh)) {
      const knowledge = document.createElement("div");
      knowledge.className = "ask-thread-knowledge";
      const label = document.createElement("strong");
      label.textContent = "知识点总结";
      const copy = document.createElement("p");
      renderPronounceableText(copy, note.learningSummaryZh, note.learningTargetText || note.sourceText || card.sourceText);
      knowledge.append(label, copy);
      body.append(knowledge);
    }
    if (note.grammarPointZh) {
      const grammar = document.createElement("div");
      grammar.className = "ask-thread-grammar";
      const label = document.createElement("strong");
      label.textContent = "语法点";
      const copy = document.createElement("p");
      copy.textContent = note.grammarPointZh;
      grammar.append(label, copy);
      body.append(grammar);
    }
  }

  const actions = document.createElement("div");
  actions.className = "ask-thread-actions";
  const addAction = (label, action, handler) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    button.textContent = label;
    button.dataset.askAction = action;
    button.addEventListener("click", handler);
    actions.append(button);
    return button;
  };
  if (card.status === "draft" || card.status === "error") {
    addAction(card.status === "error" ? "重试" : "问 AI", card.status === "error" ? "retry" : "submit", () => submitLearningQuestion(card.cardId));
    addAction("移除卡片", "dismiss", () => dismissAskThread(card.cardId));
  }
  if (card.status === "complete" && note) {
    addAction("定位原句", "locate", () => returnToAskSource(card.cardId));
    addAction("继续问", "continue", (event) => openAskPanel({
      sentenceId: note.sentenceId || card.sentenceId,
      sourceText: note.learningTargetText || note.sourceText || card.sourceText,
      question: "",
      anchorSurface: note.anchorSurface || card.anchorSurface || "",
      anchorSurfaceText: note.anchorSurfaceText || card.anchorSurfaceText || "",
      anchorStart: note.anchorStart ?? card.anchorStart,
      anchorEnd: note.anchorEnd ?? card.anchorEnd,
      anchorExact: note.anchorExact || card.anchorExact || "",
      prefix: note.prefix ?? card.prefix ?? "",
      suffix: note.suffix ?? card.suffix ?? "",
    }, event.currentTarget));
    const review = findQuestionHistoryReview(note);
    const reviewButton = addAction(review ? "已加入复习" : "加入复习", "review", (event) => {
      toggleQuestionHistoryReview(note, event.currentTarget, card.materialId);
    });
    reviewButton.classList.toggle("is-saved", Boolean(review));
    addAction("删除记录", "delete", (event) => deleteQuestionHistoryRecord(note, event.currentTarget, card.materialId));
  }
  body.append(actions);
  details.append(summary, body);
  return details;
}

function dismissAskThread(cardId) {
  const card = state.askThreads.get(cardId);
  if (!card || card.status === "pending") return;
  state.askThreads.delete(cardId);
  state.collapsedAskThreadIds.delete(cardId);
  if (state.activeAskThreadId === cardId) state.activeAskThreadId = null;
  renderAskRail({ preserveScroll: true });
}

async function submitLearningQuestion(cardId) {
  const card = state.askThreads.get(cardId);
  if (!card || !["draft", "error"].includes(card.status)) return;
  const question = String(card.question || "").trim();
  if (!question) return showToast("请输入你想继续了解的问题");
  const requestToken = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const materialId = card.materialId;
  Object.assign(card, { question, status: "pending", error: "", requestToken });
  state.activeAskThreadId = cardId;
  stopPronunciation();
  renderAskRail({ preserveScroll: true });
  try {
    const payload = await api(`/api/materials/${materialId}/ask`, {
      method: "POST",
      body: {
        sentenceId: card.sentenceId,
        selectedText: card.sourceText,
        question,
        ...askTextAnchorPayload(card),
      },
    });
    const latest = state.askThreads.get(cardId);
    if (!isAskRequestTokenCurrent(latest, requestToken, materialId)) return;
    const historyItem = payload.historyItem || { ...payload.answer, id: "", createdAt: new Date().toISOString() };
    Object.assign(latest, {
      status: "complete",
      historyId: historyItem.id || "",
      historyItem: { ...historyItem, materialId },
      answer: payload.answer,
      error: "",
    });
    if (payload.historyItem) {
      state.askThreads.delete(cardId);
      if (state.material?.id === materialId) {
        state.material.qaHistory = Array.isArray(state.material.qaHistory) ? state.material.qaHistory : [];
        if (!state.material.qaHistory.some((item) => item.id === payload.historyItem.id)) {
          state.material.qaHistory.push(payload.historyItem);
        }
        const historyCardId = `history:${payload.historyItem.id}`;
        if (state.activeAskThreadId === cardId) state.activeAskThreadId = historyCardId;
        if (state.revealed && currentUnit()) renderAnalysis(currentUnit());
      }
    }
    renderAskRail({ preserveScroll: true });
  } catch (error) {
    const latest = state.askThreads.get(cardId);
    if (!isAskRequestTokenCurrent(latest, requestToken, materialId)) return;
    Object.assign(latest, { status: "error", error: error.message || "回答失败" });
    renderAskRail({ preserveScroll: true, focusCardId: cardId });
  }
}

function resolveInitialAskAnchor(context, anchorElement) {
  const phraseSource = anchorElement?.closest?.(".sentence-phrase-row")?.querySelector(".askable-sentence");
  if (phraseSource?.isConnected) return phraseSource;
  const returnAnchor = context.returnFocus?.closest?.(".askable-sentence");
  if (returnAnchor?.isConnected) return returnAnchor;
  const directAnchor = anchorElement?.closest?.(".askable-sentence");
  if (directAnchor?.isConnected) return directAnchor;
  return anchorElement?.closest?.(".sentence-study-item")?.querySelector(".sentence-study-original") || null;
}

function renderAskTextAnchors(cards = askCardsForMaterial()) {
  const surfaces = [...document.querySelectorAll(".askable-sentence[data-sentence-id]")];
  surfaces.forEach(clearAskTextAnchorSurface);
  const plainSurfaces = surfaces.filter((surface) => (
    askAnchorSurface(surface) !== "dictation-diff"
    && !surface.querySelector("*")
  ));
  const legacySurfaceByCardId = new Map();
  cards.filter((card) => !card.anchorSurface).forEach((card) => {
    const candidates = plainSurfaces.filter((surface) => (
      surface.dataset.sentenceId === card.sentenceId
      && resolveTextAnchor(surface.textContent || "", card)
    ));
    const exactSurfaceMatches = candidates.filter((surface) => (
      normalizeReviewText(surface.textContent) === normalizeReviewText(card.sourceText)
    ));
    const resolvedSurface = exactSurfaceMatches.length === 1
      ? exactSurfaceMatches[0]
      : candidates.length === 1 ? candidates[0] : null;
    if (resolvedSurface) legacySurfaceByCardId.set(card.cardId, resolvedSurface);
  });

  plainSurfaces.forEach((surface) => {
    const surfaceText = surface.textContent || "";
    const surfaceKind = askAnchorSurface(surface);
    const relevantCards = cards.filter((card) => (
      card.sentenceId === surface.dataset.sentenceId
      && (card.anchorSurface
        ? card.anchorSurface === surfaceKind
        : legacySurfaceByCardId.get(card.cardId) === surface)
    ));
    const segments = segmentTextAnchors(surfaceText, relevantCards.map((card) => ({
      ...card,
      id: card.cardId,
    })));
    if (!segments.some((segment) => segment.anchorIds.length)) return;
    const fragment = document.createDocumentFragment();
    segments.forEach((segment) => {
      if (!segment.anchorIds.length) {
        fragment.append(document.createTextNode(segment.text));
        return;
      }
      fragment.append(createAskTextAnchorMarker(segment.text, segment.anchorIds));
    });
    surface.replaceChildren(fragment);
  });
  surfaces.filter((surface) => askAnchorSurface(surface) === "dictation-diff").forEach((surface) => {
    const surfaceText = surface.textContent || "";
    const relevantCards = cards.filter((card) => (
      card.sentenceId === surface.dataset.sentenceId
      && card.anchorSurface === "dictation-diff"
    ));
    const anchorSegments = segmentTextAnchors(surfaceText, relevantCards.map((card) => ({
      ...card,
      id: card.cardId,
    })));
    if (!anchorSegments.some((segment) => segment.anchorIds.length)) return;
    renderStructuredAskTextAnchorSurface(surface, surfaceText, anchorSegments);
  });
  syncActiveAskThreadPresentation();
}

function clearAskTextAnchorSurface(surface) {
  surface.querySelectorAll(".ask-text-anchor").forEach((marker) => {
    const semanticClass = marker.classList.contains("is-missed")
      ? "is-missed"
      : marker.classList.contains("is-match") ? "is-match" : "";
    if (askAnchorSurface(surface) === "dictation-diff" && semanticClass) {
      const semanticSpan = document.createElement("span");
      semanticSpan.className = semanticClass;
      semanticSpan.textContent = marker.textContent || "";
      marker.replaceWith(semanticSpan);
    } else {
      marker.replaceWith(document.createTextNode(marker.textContent || ""));
    }
  });
  surface.normalize();
}

function createAskTextAnchorMarker(text, cardIds, semanticClass = "") {
  const marker = document.createElement("span");
  marker.className = "ask-text-anchor";
  if (semanticClass) marker.classList.add(semanticClass);
  marker.textContent = text;
  marker.dataset.askCardIds = cardIds.join(" ");
  if (cardIds.length === 1) marker.dataset.askCardId = cardIds[0];
  marker.tabIndex = 0;
  marker.setAttribute("role", "button");
  marker.setAttribute("aria-label", `打开与“${text}”相关的问问`);
  marker.addEventListener("click", (event) => activateAskTextAnchor(event.currentTarget));
  marker.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    activateAskTextAnchor(event.currentTarget);
  });
  return marker;
}

function renderStructuredAskTextAnchorSurface(surface, surfaceText, anchorSegments) {
  const semanticRanges = [];
  let cursor = 0;
  [...surface.childNodes].forEach((node) => {
    const text = node.textContent || "";
    const semanticClass = node.nodeType === Node.ELEMENT_NODE
      ? node.classList.contains("is-missed")
        ? "is-missed"
        : node.classList.contains("is-match") ? "is-match" : ""
      : "";
    if (semanticClass && text) semanticRanges.push({ start: cursor, end: cursor + text.length, semanticClass });
    cursor += text.length;
  });
  const boundaries = [...new Set([
    0,
    surfaceText.length,
    ...semanticRanges.flatMap(({ start, end }) => [start, end]),
    ...anchorSegments.flatMap(({ start, end }) => [start, end]),
  ])].sort((left, right) => left - right);
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (end <= start) continue;
    const text = surfaceText.slice(start, end);
    const semanticClass = semanticRanges.find((range) => range.start <= start && range.end >= end)?.semanticClass || "";
    const cardIds = anchorSegments.find((segment) => segment.start <= start && segment.end >= end)?.anchorIds || [];
    if (cardIds.length) {
      fragment.append(createAskTextAnchorMarker(text, cardIds, semanticClass));
    } else if (semanticClass) {
      const semanticSpan = document.createElement("span");
      semanticSpan.className = semanticClass;
      semanticSpan.textContent = text;
      fragment.append(semanticSpan);
    } else {
      fragment.append(document.createTextNode(text));
    }
  }
  surface.replaceChildren(fragment);
}

function askTextAnchorCardIds(marker) {
  return String(marker?.dataset?.askCardIds || "").split(/\s+/).filter(Boolean);
}

function findAskTextAnchorElement(cardId) {
  if (!cardId) return null;
  return [...document.querySelectorAll(".ask-text-anchor[data-ask-card-ids]")]
    .find((marker) => askTextAnchorCardIds(marker).includes(cardId) && marker.getClientRects().length) || null;
}

function activateAskTextAnchor(marker) {
  const cardIds = askTextAnchorCardIds(marker);
  if (!cardIds.length) return;
  const cardId = cardIds.includes(state.activeAskThreadId) ? state.activeAskThreadId : cardIds[0];
  if (!askCardById(cardId)) return;
  state.activeAskThreadId = cardId;
  state.askRailCollapsed = false;
  renderAskRail({ preserveScroll: true, focusCardId: cardId });
}

function syncActiveAskThreadPresentation() {
  document.querySelectorAll(".ask-thread-card[data-ask-card-id]").forEach((card) => {
    card.classList.toggle("is-active", card.dataset.askCardId === state.activeAskThreadId);
  });
  document.querySelectorAll(".ask-text-anchor[data-ask-card-ids]").forEach((marker) => {
    marker.classList.toggle("is-active", askTextAnchorCardIds(marker).includes(state.activeAskThreadId));
  });
  const card = askCardById(state.activeAskThreadId);
  const preciseAnchor = findAskTextAnchorElement(state.activeAskThreadId);
  setAskAnchorElement(preciseAnchor || (!card?.anchorExact ? resolveAskAnchorElement(card) : null));
}

function resolveAskAnchorElement(card = askCardById(state.activeAskThreadId)) {
  if (!card) return null;
  const preciseAnchor = findAskTextAnchorElement(card.cardId);
  if (preciseAnchor) return preciseAnchor;
  if (state.askAnchorElement?.isConnected
    && state.askAnchorElement.dataset.sentenceId === card.sentenceId
    && !state.askAnchorElement.classList.contains("ask-text-anchor")
    && !card.anchorExact
    && state.askAnchorElement.getClientRects().length) {
    return state.askAnchorElement;
  }
  const sourceKey = normalizeReviewText(card.learningTargetText || card.sourceText || "");
  const anchorSurface = card.anchorSurface || "";
  const candidates = [...document.querySelectorAll(".askable-sentence[data-sentence-id]")]
    .filter((element) => element.dataset.sentenceId === card.sentenceId && element.getClientRects().length);
  const sameSurface = anchorSurface ? candidates.filter((element) => askAnchorSurface(element) === anchorSurface) : [];
  const preferred = sameSurface.length ? sameSurface : candidates;
  const exact = preferred.find((element) => normalizeReviewText(element.textContent) === sourceKey);
  const containing = preferred.find((element) => normalizeReviewText(element.textContent).includes(sourceKey));
  return exact || containing || preferred.find((element) => element.classList.contains("sentence-study-original")) || preferred[0] || null;
}

function scheduleAskPanelReposition() {
  if (state.askRepositionFrame) return;
  state.askRepositionFrame = requestAnimationFrame(() => {
    state.askRepositionFrame = null;
    const card = askCardById(state.activeAskThreadId);
    const target = resolveAskAnchorElement(card);
    setAskAnchorElement(target?.classList.contains("ask-text-anchor") || !card?.anchorExact ? target : null);
  });
}

function askAnchorSurface(element) {
  return element?.dataset?.askSurface
    || (element?.classList?.contains("sentence-study-original") ? "original" : "");
}

function setAskAnchorElement(element) {
  if (state.askAnchorElement === element) return;
  state.askAnchorElement?.classList?.remove("is-ask-anchor", "is-active");
  state.askAnchorElement = element?.isConnected ? element : null;
  if (state.askAnchorElement) {
    state.askAnchorElement.classList.add(
      state.askAnchorElement.classList.contains("ask-text-anchor") ? "is-active" : "is-ask-anchor",
    );
  }
}

function returnToAskSource(cardId) {
  const card = askCardById(cardId);
  if (!card || !state.material || card.materialId !== state.material.id) return showToast("请先回到这条问问所属的材料");
  state.activeAskThreadId = cardId;
  let anchorElement = resolveAskAnchorElement(card);
  if (!anchorElement && card.sentenceId) {
    let units = currentUnits();
    let targetIndex = units.findIndex((unit) => unitSentenceIds(unit).includes(card.sentenceId));
    if (targetIndex >= 0) {
      if (!inReviewMode()) state.index = targetIndex;
      state.revealed = true;
      renderCurrentUnit();
      anchorElement = resolveAskAnchorElement(card);
    }
  }
  requestAnimationFrame(() => {
    const target = anchorElement?.isConnected ? anchorElement : resolveAskAnchorElement(card);
    if (!target) return showToast("暂时找不到这处原文");
    setAskAnchorElement(target.classList.contains("ask-text-anchor") || !card.anchorExact ? target : null);
    scrollAskSourceIntoView(target);
    scheduleAskPanelReposition();
  });
}

function scrollAskSourceIntoView(target) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (window.innerWidth > 1060 && elements.practiceColumn) {
    const containerRect = elements.practiceColumn.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = elements.practiceColumn.scrollTop + targetRect.top - containerRect.top
      - (elements.practiceColumn.clientHeight - targetRect.height) / 2;
    elements.practiceColumn.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? "auto" : "smooth" });
    return;
  }
  const targetRect = target.getBoundingClientRect();
  window.scrollTo({
    top: Math.max(0, window.scrollY + targetRect.top - (window.innerHeight - targetRect.height) / 2),
    behavior: reduceMotion ? "auto" : "smooth",
  });
}

function snapshotRect(rect) {
  if (!rect) return null;
  const left = Number(rect.left);
  const top = Number(rect.top);
  const right = Number(rect.right);
  const bottom = Number(rect.bottom);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return {
    left,
    top,
    right,
    bottom,
    width: Number(rect.width) || Math.max(0, right - left),
    height: Number(rect.height) || Math.max(0, bottom - top),
  };
}

function handleViewportScroll(event) {
  hideSelectionAction();
  if (event.target === elements.askThreadList || elements.askThreadList.contains(event.target)) {
    state.askRailScrollTop = elements.askThreadList.scrollTop;
    return;
  }
  scheduleAskPanelReposition();
}

function renderDiff(typed, target) {
  const typedWords = tokenize(typed);
  elements.diffText.replaceChildren();
  elements.diffBlock.classList.toggle("is-hidden", typedWords.length === 0);
  if (!typedWords.length) return;
  const unit = currentUnit();
  const sentences = unit.sentenceIds
    .map((id) => state.material.sentences.find((sentence) => sentence.id === id))
    .filter(Boolean);
  const sentenceWords = sentences.map((sentence) => ({ sentence, words: tokenize(sentence.text) }));
  const targetWords = sentenceWords.flatMap((entry) => entry.words);
  const fallbackTargetWords = tokenize(target);
  const wordsForMatching = targetWords.length ? targetWords : fallbackTargetWords;
  const matched = lcsMatchedTargetIndexes(typedWords.map(normalizeWord), wordsForMatching.map(normalizeWord));
  let wordIndex = 0;
  sentenceWords.forEach(({ sentence, words }, sentenceIndex) => {
    const sentenceSpan = document.createElement("span");
    sentenceSpan.className = "diff-sentence askable-sentence";
    sentenceSpan.dataset.sentenceId = sentence.id;
    sentenceSpan.dataset.askSurface = "dictation-diff";
    words.forEach((word) => {
      const wordSpan = document.createElement("span");
      wordSpan.className = matched.has(wordIndex) ? "is-match" : "is-missed";
      wordSpan.textContent = word;
      sentenceSpan.append(wordSpan, document.createTextNode(" "));
      wordIndex += 1;
    });
    elements.diffText.append(sentenceSpan);
    if (sentenceIndex < sentenceWords.length - 1) elements.diffText.append(document.createTextNode(" "));
  });
}

function renderPracticeProgress(sequencePosition, sequenceLength) {
  if (!sequenceLength) {
    const emptyLabel = inReviewMode() ? "没有需复习的片段" : "没有可学习的片段";
    elements.unitCounter.textContent = emptyLabel;
    elements.studyProgress.style.width = "0%";
    elements.practiceProgress.setAttribute("aria-valuemax", "0");
    elements.practiceProgress.setAttribute("aria-valuenow", "0");
    elements.practiceProgress.setAttribute("aria-valuetext", emptyLabel);
    return;
  }
  elements.unitCounter.textContent = `${sequencePosition} / ${sequenceLength}`;
  elements.studyProgress.style.width = `${(sequencePosition / sequenceLength) * 100}%`;
  elements.practiceProgress.setAttribute("aria-valuemax", String(sequenceLength));
  elements.practiceProgress.setAttribute("aria-valuenow", String(sequencePosition));
  elements.practiceProgress.setAttribute(
    "aria-valuetext",
    inReviewMode()
      ? `当前复习第 ${sequencePosition} 项，共 ${sequenceLength} 项`
      : `当前第 ${sequencePosition} 段，共 ${sequenceLength} 段`,
  );
}

function startCompletionPlaybackPass(unit) {
  if (!unit || !state.material || inReviewMode() || state.sentencePlayback) {
    state.completionPlaybackPass = null;
    return;
  }
  const finalParagraph = state.material.paragraphs.at(-1);
  if (!finalParagraph || finalParagraph.id !== unit.id) {
    state.completionPlaybackPass = null;
    return;
  }
  state.completionPlaybackPass = {
    materialId: state.material.id,
    paragraphId: unit.id,
    surface: "paragraph-player",
    mediaKind: "original",
    startedFromBeginning: true,
    reachedContentEnd: false,
    endedNaturally: false,
    endedBySeek: false,
    startedAt: new Date().toISOString(),
  };
}

function invalidateCompletionPlaybackPass(patch = {}) {
  if (!state.completionPlaybackPass) return;
  state.completionPlaybackPass = { ...state.completionPlaybackPass, ...patch };
}

async function completeMaterialAfterNaturalPlayback(unit) {
  const material = state.material;
  const pass = state.completionPlaybackPass;
  if (!material || !unit || !pass || state.completionSaving) return;
  const completedPass = {
    ...pass,
    reachedContentEnd: true,
    endedNaturally: true,
  };
  state.completionPlaybackPass = completedPass;
  const completion = {
    ...normalizeMaterialCompletion(material),
    replayRequiredAfter: loadCompletionResetAt(material.id),
  };
  const eligible = shouldCompleteMaterial({
    completion,
    mode: state.studyPreferences.mode,
    reviewFilterActive: inReviewMode(),
    paragraphs: material.paragraphs,
    paragraphId: unit.id,
    playbackPass: completedPass,
  });
  if (!eligible) return;

  state.completionSaving = true;
  const previousCompleted = material.completed === true;
  const previousCompletedAt = material.completedAt || null;
  const completedMaterialId = material.id;
  const completedMaterialTitle = material.title;
  const optimisticCompletedAt = new Date().toISOString();
  applyMaterialLearningState(material.id, { completed: true, completedAt: optimisticCompletedAt });
  renderMaterialList();
  renderMaterialCompletionState();
  try {
    const payload = await api(`/api/materials/${material.id}/learning-state`, {
      method: "PATCH",
      body: { completed: true },
    });
    applyMaterialLearningState(material.id, payload.material);
    clearCompletionResetAt(material.id);
    renderMaterialList();
    renderMaterialCompletionState();
    showCompletionCelebration({ materialId: completedMaterialId, title: completedMaterialTitle });
  } catch (error) {
    applyMaterialLearningState(material.id, { completed: previousCompleted, completedAt: previousCompletedAt });
    renderMaterialList();
    renderMaterialCompletionState();
    showToast(`已听完最后一段，但完成状态保存失败：${error.message}`);
  } finally {
    state.completionSaving = false;
  }
}

async function togglePlayback() {
  const unit = currentUnit();
  if (!state.media || !unit) return;
  const playbackRange = currentPlaybackRange(unit);
  const media = state.media;
  if (!media.paused) return pauseMedia();
  if (document.hidden || elements.trainingView.classList.contains("is-hidden")) return;
  stopPronunciation();
  if (media.currentTime < playbackRange.start - 0.2 || media.currentTime >= playbackRange.end) {
    media.currentTime = Math.max(0, playbackRange.start - 0.08);
    state.playbackPassEligible = true;
    startCompletionPlaybackPass(unit);
  } else if (media.currentTime <= playbackRange.start + 0.12) {
    state.playbackPassEligible = true;
    startCompletionPlaybackPass(unit);
  }
  const requestId = ++state.playRequestId;
  const expectedMode = state.mode;
  const expectedUnitId = unit.id;
  media.playbackRate = state.speed;
  try {
    await media.play();
    if (requestId !== state.playRequestId || state.mode !== expectedMode || currentUnit()?.id !== expectedUnitId) {
      media.pause();
    }
  } catch {
    showToast("浏览器暂时无法播放该片段");
  }
}

async function toggleSentencePlayback(sentence, button) {
  const media = state.media;
  if (!media || !sentence) return;
  if (!hasReliableSentencePlayback(sentence, media.duration)) {
    showToast("这句未能在原声中可靠匹配，已避免播放错误片段");
    return;
  }
  if (state.sentencePlayback?.button === button && !media.paused) {
    pauseMedia();
    return;
  }
  if (document.hidden || elements.trainingView.classList.contains("is-hidden")) return;

  pauseMedia();
  stopPronunciation();
  state.playbackPassEligible = false;
  state.completionPlaybackPass = null;
  const requestId = ++state.playRequestId;
  const expectedMaterialId = state.material?.id;
  const playbackRange = resolveSentencePlaybackRange({
    sentence,
    sentences: state.material?.sentences,
    mediaDuration: media.duration,
  });
  state.sentencePlayback = {
    sentenceId: sentence.id,
    start: playbackRange.start,
    contentStart: playbackRange.contentStart,
    contentEnd: playbackRange.contentEnd,
    end: playbackRange.end,
    button,
  };
  button.classList.add("is-playing");
  button.setAttribute("aria-pressed", "true");
  button.setAttribute("aria-label", "停止本句原声");
  button.title = "停止本句原声";

  const beginPlayback = async () => {
    if (
      requestId !== state.playRequestId
      || state.material?.id !== expectedMaterialId
      || state.sentencePlayback?.button !== button
      || document.hidden
      || elements.trainingView.classList.contains("is-hidden")
    ) return;
    media.currentTime = Math.max(0, playbackRange.start - 0.06);
    media.playbackRate = state.speed;
    updateUnitPlaybackProgress();
    try {
      await media.play();
      if (requestId !== state.playRequestId || state.sentencePlayback?.button !== button) media.pause();
    } catch {
      clearSentencePlaybackState();
      showToast("浏览器暂时无法播放这句原声");
    }
  };

  if (media.readyState >= 1) await beginPlayback();
  else media.addEventListener("loadedmetadata", beginPlayback, { once: true });
}

function replayCurrent() {
  const unit = currentUnit();
  if (!unit || !state.media) return;
  playUnitFromStart(unit);
}

function playUnitFromStart(unit = currentUnit()) {
  if (!unit || !state.media) return;
  stopPronunciation();
  const playbackRange = currentPlaybackRange(unit);
  const media = state.media;
  const requestId = ++state.playRequestId;
  const expectedMode = state.mode;
  const expectedUnitId = unit.id;
  const beginPlayback = () => {
    if (
      requestId !== state.playRequestId
      || state.mode !== expectedMode
      || currentUnit()?.id !== expectedUnitId
      || document.hidden
      || elements.trainingView.classList.contains("is-hidden")
    ) return;
    media.currentTime = Math.max(0, playbackRange.start - 0.08);
    state.playbackPassEligible = true;
    startCompletionPlaybackPass(unit);
    media.playbackRate = state.speed;
    updateUnitPlaybackProgress();
    media.play().catch(() => showToast("浏览器暂时无法播放该片段"));
  };
  if (media.readyState >= 1) beginPlayback();
  else media.addEventListener("loadedmetadata", beginPlayback, { once: true });
}

function handleMediaTimeUpdate() {
  updateUnitPlaybackProgress();
  if (enforceSentencePlaybackBoundary()) return;
  enforceUnitBoundary();
}

function enforceSentencePlaybackBoundary() {
  const sentencePlayback = state.sentencePlayback;
  const media = state.media;
  if (!sentencePlayback || !media) return false;
  if (media.currentTime < sentencePlayback.end + 0.04) return true;
  const sentenceEnd = sentencePlayback.end;
  pauseMedia();
  media.currentTime = sentenceEnd;
  updateUnitPlaybackProgress();
  return true;
}

function updateUnitPlaybackProgress() {
  const unit = currentUnit();
  const playbackRange = currentPlaybackRange(unit);
  const label = playbackRange?.label || "当前自然分段";
  elements.unitPlaybackLabel.textContent = label;
  elements.unitPlaybackTrack.setAttribute("aria-label", `拖动定位${label}`);
  if (!unit) {
    elements.unitPlaybackFill.style.transform = "scaleX(0)";
    elements.unitPlaybackTrack.style.setProperty("--unit-progress", "0");
    elements.unitPlaybackTrack.style.setProperty("--unit-context-ratio", "0");
    elements.unitPlaybackTrack.classList.remove("has-lead-in");
    elements.unitPlaybackTrack.setAttribute("aria-valuenow", "0");
    elements.unitPlaybackTrack.setAttribute("aria-valuetext", "00:00 / 00:00");
    elements.unitPlaybackTime.textContent = "00:00 / 00:00";
    return;
  }
  const duration = Math.max(0.001, playbackRange.end - playbackRange.start);
  const currentTime = Number(state.media?.currentTime ?? playbackRange.start);
  const elapsed = Math.max(0, Math.min(duration, currentTime - playbackRange.start));
  const ratio = Math.max(0, Math.min(1, elapsed / duration));
  const leadInRatio = playbackRange.contextKind === "lead-in" ? playbackLeadInRatio(playbackRange) : 0;
  const totalSeconds = Math.max(1, Math.ceil(duration));
  const elapsedSeconds = ratio >= 0.995 ? totalSeconds : Math.min(totalSeconds, Math.floor(elapsed));
  elements.unitPlaybackFill.style.transform = `scaleX(${ratio})`;
  elements.unitPlaybackTrack.style.setProperty("--unit-progress", String(ratio));
  elements.unitPlaybackTrack.style.setProperty("--unit-context-ratio", String(leadInRatio));
  elements.unitPlaybackTrack.classList.toggle("has-lead-in", leadInRatio > 0);
  elements.unitPlaybackTrack.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
  const progressText = `${formatClock(elapsedSeconds)} / ${formatClock(totalSeconds)}`;
  const progressContext = playbackRange.hasTrailingContext && currentTime > playbackRange.contentEnd
    ? "，正在播放简短回应"
    : leadInRatio > 0
      ? currentTime < playbackRange.contentStart ? "，正在播放上文衔接" : "，正在播放本段正文"
      : playbackRange.hasTrailingContext ? "，正在播放本段正文" : "";
  elements.unitPlaybackTrack.setAttribute("aria-valuetext", `${progressText}${progressContext}`);
  elements.unitPlaybackTime.textContent = progressText;
  const targetCompletion = playbackTargetCompletion(playbackRange, currentTime);
  if (targetCompletion >= 0.9 && state.playbackPassEligible && state.media && !state.media.paused) markUnitHeard(unit);
}

function enforceUnitBoundary(force = false) {
  const unit = currentUnit();
  const playbackRange = currentPlaybackRange(unit);
  if (!unit || !playbackRange || !state.media || (!force && state.media.currentTime < playbackRange.end + 0.04)) return;
  if (state.playbackPassEligible) markUnitHeard(unit);
  completeMaterialAfterNaturalPlayback(unit);
  if (document.hidden || elements.trainingView.classList.contains("is-hidden")) return pauseMedia();
  if (state.loop) {
    state.media.currentTime = Math.max(0, playbackRange.start - 0.08);
    state.playbackPassEligible = true;
    startCompletionPlaybackPass(unit);
    updateUnitPlaybackProgress();
    state.media.play().catch(() => {});
  } else {
    pauseMedia();
    state.media.currentTime = playbackRange.end;
    updateUnitPlaybackProgress();
  }
}

function startPlaybackSeek(event) {
  if (event.button !== 0 || !state.media || !currentUnit()) return;
  event.preventDefault();
  state.playbackSeekPointerId = event.pointerId;
  state.playbackSeekWasPlaying = !state.media.paused;
  state.playbackPassEligible = false;
  invalidateCompletionPlaybackPass({ endedBySeek: true });
  pauseMedia();
  elements.unitPlaybackTrack.focus({ preventScroll: true });
  elements.unitPlaybackTrack.setPointerCapture(event.pointerId);
  elements.unitPlaybackTrack.classList.add("is-seeking");
  document.body.classList.add("is-seeking-media");
  seekCurrentUnitFromClientX(event.clientX);
}

function continuePlaybackSeek(event) {
  if (state.playbackSeekPointerId !== event.pointerId) return;
  seekCurrentUnitFromClientX(event.clientX);
}

function finishPlaybackSeek(event) {
  if (state.playbackSeekPointerId !== event.pointerId) return;
  seekCurrentUnitFromClientX(event.clientX);
  if (elements.unitPlaybackTrack.hasPointerCapture(event.pointerId)) {
    elements.unitPlaybackTrack.releasePointerCapture(event.pointerId);
  }
  const shouldResume = state.playbackSeekWasPlaying;
  state.playbackSeekPointerId = null;
  state.playbackSeekWasPlaying = false;
  elements.unitPlaybackTrack.classList.remove("is-seeking");
  document.body.classList.remove("is-seeking-media");
  if (shouldResume) resumeMediaAfterSeek();
}

function seekCurrentUnitFromClientX(clientX) {
  const rect = elements.unitPlaybackTrack.getBoundingClientRect();
  if (rect.width <= 0) return;
  seekCurrentUnitToRatio((clientX - rect.left) / rect.width);
}

function seekCurrentUnitToRatio(value) {
  const unit = currentUnit();
  const playbackRange = currentPlaybackRange(unit);
  if (!unit || !playbackRange || !state.media) return;
  const ratio = Math.max(0, Math.min(1, Number(value) || 0));
  state.playbackPassEligible = false;
  invalidateCompletionPlaybackPass({ endedBySeek: true });
  state.media.currentTime = playbackRange.start + (playbackRange.end - playbackRange.start) * ratio;
  updateUnitPlaybackProgress();
}

function resumeMediaAfterSeek() {
  const unit = currentUnit();
  const media = state.media;
  if (!unit || !media || document.hidden || elements.trainingView.classList.contains("is-hidden")) return;
  stopPronunciation();
  const requestId = ++state.playRequestId;
  const expectedMode = state.mode;
  const expectedUnitId = unit.id;
  media.playbackRate = state.speed;
  media.play().then(() => {
    if (requestId !== state.playRequestId || state.mode !== expectedMode || currentUnit()?.id !== expectedUnitId) media.pause();
  }).catch(() => showToast("浏览器暂时无法播放该片段"));
}

function handlePlaybackSeekKeyboard(event) {
  const unit = currentUnit();
  const playbackRange = currentPlaybackRange(unit);
  if (!unit || !playbackRange || !state.media) return;
  const seekKeys = ["ArrowLeft", "ArrowRight", "Home", "End"];
  if (!seekKeys.includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const duration = Math.max(0.001, playbackRange.end - playbackRange.start);
  const currentRatio = Math.max(0, Math.min(1, (state.media.currentTime - playbackRange.start) / duration));
  const step = (event.shiftKey ? 5 : 1) / duration;
  const nextRatio = event.key === "Home"
    ? 0
    : event.key === "End"
      ? 1
      : currentRatio + (event.key === "ArrowRight" ? step : -step);
  seekCurrentUnitToRatio(nextRatio);
}

function pauseMedia() {
  state.playRequestId += 1;
  if (state.media && !state.media.paused) state.media.pause();
  clearSentencePlaybackState();
}

function clearSentencePlaybackState() {
  const playback = state.sentencePlayback;
  if (!playback) return;
  const { button } = playback;
  button?.classList.remove("is-playing");
  button?.setAttribute("aria-pressed", "false");
  button?.setAttribute("aria-label", button.dataset.playLabel || "播放本句原声");
  if (button) button.title = button.dataset.playTitle || "播放本句原声";
  state.sentencePlayback = null;
}

function disposeMedia() {
  stopPronunciation();
  state.completionPlaybackPass = null;
  state.playRequestId += 1;
  const media = state.media;
  if (!media) return;
  media.pause();
  media.removeAttribute("src");
  media.load();
  media.remove();
  state.media = null;
}

function renderPronounceableText(container, text, sourceText) {
  const parts = splitPronunciationText(text);
  container.replaceChildren();
  for (const part of parts) {
    if (part.kind === "text") {
      container.append(document.createTextNode(part.value));
      continue;
    }
    const accentLabel = pronunciationAccentLabel(part.lang);
    const group = document.createElement("span");
    group.className = "ipa-pronunciation";
    const ipa = document.createElement("span");
    ipa.className = "ipa-text";
    ipa.textContent = part.value;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pronunciation-button";
    const spokenText = part.spokenText || sourceText;
    button.setAttribute("aria-label", `播放“${spokenText}”的${accentLabel}发音`);
    button.setAttribute("aria-pressed", "false");
    button.title = `${accentLabel}发音`;
    button.append(createSpeakerIcon());
    button.addEventListener("click", () => togglePronunciation(spokenText, part.lang, button));
    group.append(ipa, button);
    container.append(group);
  }
}

function createSpeakerIcon() {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", "M5 10v4h3l4 3V7L8 10H5Zm10.3-.9a4 4 0 0 1 0 5.8M17.8 6.6a7.5 7.5 0 0 1 0 10.8");
  svg.append(path);
  return svg;
}

function togglePronunciation(sourceText, lang, button) {
  if (state.pronunciationButton === button) {
    stopPronunciation();
    return;
  }
  if (!("speechSynthesis" in window) || typeof window.SpeechSynthesisUtterance !== "function") {
    showToast("当前浏览器不支持发音播放");
    return;
  }
  const spokenText = String(sourceText || "").trim();
  if (!spokenText) return showToast("没有找到要朗读的英文表达");
  pauseMedia();
  const hadActivePronunciation = Boolean(
    state.pronunciationButton || state.pronunciationUtterance || state.pronunciationTimer,
  );
  stopPronunciation();
  const requestId = ++state.pronunciationRequestId;
  state.pronunciationButton = button;
  button.classList.add("is-speaking");
  button.setAttribute("aria-pressed", "true");
  const speak = async () => {
    state.pronunciationTimer = null;
    if (requestId !== state.pronunciationRequestId || state.pronunciationButton !== button) return;
    const voices = await loadPronunciationVoices();
    if (requestId !== state.pronunciationRequestId || state.pronunciationButton !== button) return;
    const voice = selectPronunciationVoice(voices, lang);
    if (!voice) {
      clearPronunciationState();
      showToast("未找到本机英语语音，请在系统设置下载英语语音后重试");
      return;
    }
    const utterance = new SpeechSynthesisUtterance(spokenText);
    utterance.lang = lang;
    utterance.rate = 0.95;
    utterance.pitch = 1;
    utterance.volume = 1;
    utterance.voice = voice;
    state.pronunciationUtterance = utterance;
    utterance.onend = () => {
      if (requestId === state.pronunciationRequestId && state.pronunciationUtterance === utterance) {
        clearPronunciationState();
      }
    };
    utterance.onerror = (event) => {
      if (requestId !== state.pronunciationRequestId || state.pronunciationUtterance !== utterance) return;
      const reason = String(event?.error || "");
      clearPronunciationState();
      if (!["canceled", "interrupted"].includes(reason)) showToast("发音播放失败，请再试一次");
    };
    try {
      window.speechSynthesis.resume?.();
      window.speechSynthesis.speak(utterance);
    } catch {
      clearPronunciationState();
      showToast("发音播放失败，请再试一次");
    }
  };
  if (hadActivePronunciation) state.pronunciationTimer = window.setTimeout(() => void speak(), 0);
  else void speak();
}

function loadPronunciationVoices(timeoutMs = 900) {
  const immediate = window.speechSynthesis.getVoices?.() || [];
  if (immediate.length) return Promise.resolve(immediate);
  if (state.pronunciationVoiceLoadPromise) return state.pronunciationVoiceLoadPromise;

  state.pronunciationVoiceLoadPromise = new Promise((resolve) => {
    const startedAt = performance.now();
    const poll = () => {
      const voices = window.speechSynthesis.getVoices?.() || [];
      if (voices.length || performance.now() - startedAt >= timeoutMs) {
        resolve(voices);
        return;
      }
      window.setTimeout(poll, 50);
    };
    window.setTimeout(poll, 0);
  }).finally(() => {
    state.pronunciationVoiceLoadPromise = null;
  });
  return state.pronunciationVoiceLoadPromise;
}

function stopPronunciation() {
  state.pronunciationRequestId += 1;
  if (state.pronunciationTimer) window.clearTimeout(state.pronunciationTimer);
  state.pronunciationTimer = null;
  if ((state.pronunciationUtterance || state.pronunciationButton) && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  clearPronunciationState();
}

function clearPronunciationState() {
  state.pronunciationButton?.classList.remove("is-speaking");
  state.pronunciationButton?.setAttribute("aria-pressed", "false");
  state.pronunciationButton = null;
  state.pronunciationUtterance = null;
  state.pronunciationTimer = null;
}

function handleDocumentVisibility() {
  if (document.hidden) {
    pauseMedia();
    stopPronunciation();
  }
}

function toggleLoop() {
  state.loop = !state.loop;
  renderLoopState();
}

function renderLoopState() {
  elements.loopButton.classList.toggle("is-active", state.loop);
  elements.loopButton.setAttribute("aria-pressed", String(state.loop));
}

async function navigateUnit(delta, autoplay = false, { resetScroll = true } = {}) {
  saveDictationNow();
  if (inReviewMode()) {
    if (!state.reviewQueue.length) return;
    const next = Math.min(Math.max(0, state.reviewQueueIndex + delta), state.reviewQueue.length - 1);
    if (next === state.reviewQueueIndex && delta > 0) return showToast("已经是本轮复习的最后一条");
    if (next === state.reviewQueueIndex && delta < 0) return showToast("已经是本轮复习的第一条");
    await activateReviewQueueIndex(next, { autoplay, resetScroll });
    return;
  }
  const units = currentUnits();
  if (!units.length) return;
  const next = Math.min(Math.max(0, state.index + delta), units.length - 1);
  if (next === state.index && delta > 0) return showToast("已经是最后一段");
  if (next === state.index && delta < 0) return showToast("已经是第一段");
  state.index = next;
  state.revealed = false;
  saveStudyPosition();
  renderCurrentUnit();
  updateResumeButton();
  if (resetScroll) requestAnimationFrame(() => scrollTrainingWorkspaceToTop());
  if (autoplay) playUnitFromStart();
}

async function toggleCurrentReview() {
  const unit = currentUnit();
  if (!unit) return;
  const previousReviewKey = currentReviewQueueItem()?.key || "";
  const previousReviewIndex = state.reviewQueueIndex;
  const saved = findParagraphReview(unit.id);
  const wasSaved = Boolean(saved);
  elements.markReviewButton.disabled = true;
  try {
    const dictation = elements.dictationInput.value;
    await saveUnitProgress(unit, { dictation });
    for (const id of unitSentenceIds(unit)) {
      state.material.progress[id] = { ...(state.material.progress[id] || {}), dictation };
    }
    if (saved) {
      const payload = await api(`/api/materials/${state.material.id}/review-items/${saved.id}`, { method: "DELETE" });
      state.material = payload.material;
    } else {
      const payload = await api(`/api/materials/${state.material.id}/review-items`, {
        method: "POST",
        body: { kind: "paragraph", paragraphId: unit.id, sourceText: unit.text },
      });
      state.material = payload.material;
    }

    if (inReviewMode()) {
      await syncReviewQueueAfterReviewMutation({
        previousReviewKey,
        previousReviewIndex,
        materialId: state.material.id,
      });
    } else {
      renderCurrentUnit();
    }
    loadMaterials();
    if (!wasSaved) {
      showToast("本段已加入复习，可在复习模式中继续");
    } else if (paragraphContainsReview(unit)) {
      showToast("已移除本段复习，句内复习内容仍保留");
    } else {
      showToast("本段已从复习中移除");
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.markReviewButton.disabled = false;
  }
}

function scheduleDictationSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveDictationNow, 700);
}

async function saveDictationNow() {
  clearTimeout(state.saveTimer);
  const unit = currentUnit();
  if (!unit || !state.material) return;
  const value = elements.dictationInput.value;
  const ids = unitSentenceIds(unit);
  const previous = ids.map((id) => state.material.progress?.[id]?.dictation || "").find(Boolean) || "";
  if (value === previous) return;
  try {
    await saveUnitProgress(unit, { dictation: value });
    for (const id of ids) state.material.progress[id] = { ...(state.material.progress[id] || {}), dictation: value };
  } catch {
    // Keep typing uninterrupted; a later rating action will retry the save.
  }
}

function saveUnitProgress(unit, patch) {
  return api(`/api/materials/${state.material.id}/progress`, {
    method: "PATCH",
    body: { segmentIds: unitSentenceIds(unit), ...patch },
  });
}

async function markUnitHeard(unit) {
  const material = state.material;
  if (!unit || !material) return;
  const ids = unitSentenceIds(unit).filter((id) => !material.progress?.[id]?.heard);
  if (!ids.length) return;
  const key = `${material.id}:${ids.join(",")}`;
  if (state.heardSaving.has(key)) return;
  state.heardSaving.add(key);
  for (const id of ids) {
    material.progress[id] = { ...(material.progress[id] || {}), heard: true };
  }
  if (state.material?.id === material.id && elements.segmentDrawer.classList.contains("is-open")) renderSegmentDirectory();
  try {
    await api(`/api/materials/${material.id}/progress`, {
      method: "PATCH",
      body: { segmentIds: ids, heard: true },
    });
  } catch {
    for (const id of ids) delete material.progress[id].heard;
  } finally {
    state.heardSaving.delete(key);
  }
}

function isInlineSegmentDrawer() {
  return window.matchMedia(INLINE_SEGMENT_DRAWER_QUERY).matches;
}

function applyInitialSegmentDrawerState() {
  if (state.mediaViewMode === MEDIA_VIEW_LISTEN) return closeSegmentDrawer(false);
  openSegmentDrawer({ focus: false });
}

function syncSegmentDrawerPresentation() {
  const open = elements.segmentDrawer.classList.contains("is-open");
  const inline = isInlineSegmentDrawer();
  elements.trainingView.classList.toggle("has-segment-drawer", open && inline);
  elements.segmentDrawerScrim.classList.toggle("is-open", open && !inline);
  elements.segmentDrawer.dataset.presentation = inline ? "inline" : "overlay";
}

function openSegmentDrawer({ focus = true } = {}) {
  if (!state.material || state.mediaViewMode === MEDIA_VIEW_LISTEN) return;
  if (window.innerWidth < 1880 && !elements.askPanel.classList.contains("is-hidden")) {
    collapseAskRail(false);
  }
  if (focus) state.drawerReturnFocus = document.activeElement;
  renderSegmentDirectory();
  elements.segmentDrawer.inert = false;
  elements.segmentDrawer.setAttribute("aria-hidden", "false");
  elements.segmentDrawer.classList.add("is-open");
  elements.segmentListButton.setAttribute("aria-expanded", "true");
  syncSegmentDrawerPresentation();
  if (focus) elements.closeSegmentDrawerButton.focus();
  requestAnimationFrame(() => {
    elements.segmentList.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" });
    applyPaneRatio(state.paneRatio);
  });
}

function closeSegmentDrawer(restoreFocus = true) {
  const wasOpen = elements.segmentDrawer.classList.contains("is-open");
  elements.segmentDrawer.classList.remove("is-open");
  elements.segmentDrawer.setAttribute("aria-hidden", "true");
  elements.segmentDrawer.inert = true;
  elements.segmentListButton.setAttribute("aria-expanded", "false");
  syncSegmentDrawerPresentation();
  if (restoreFocus && wasOpen && state.drawerReturnFocus instanceof HTMLElement) state.drawerReturnFocus.focus();
  state.drawerReturnFocus = null;
  requestAnimationFrame(() => applyPaneRatio(state.paneRatio));
}

function renderSegmentDirectory() {
  if (inReviewMode()) {
    const units = state.reviewQueue;
    const scopeLabel = state.studyPreferences.reviewScope.kind === "material"
      ? state.materials.find((material) => material.id === state.studyPreferences.reviewScope.materialId)?.title || "当前材料"
      : "全部材料";
    elements.segmentModeLabel.textContent = `复习 · ${scopeLabel}`;
    elements.segmentHeardSummary.textContent = `${units.length} 条待复习`;
    elements.segmentList.replaceChildren();
    const numberWidth = String(Math.max(1, units.length)).length;
    const fragment = document.createDocumentFragment();
    units.forEach((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "segment-row is-review";
      button.setAttribute("aria-current", String(index === state.reviewQueueIndex));
      button.setAttribute("aria-label", `第 ${index + 1} 条复习内容，${item.materialTitle}，${item.speaker || "Speaker"}`);
      const number = document.createElement("span");
      number.className = "segment-number";
      number.textContent = String(index + 1).padStart(numberWidth, "0");
      const details = document.createElement("span");
      details.className = "segment-details";
      const speaker = document.createElement("strong");
      speaker.textContent = item.materialTitle || "未命名材料";
      const timing = document.createElement("span");
      timing.textContent = `${item.speaker || "Speaker"} · ${formatClock(item.start)}–${formatClock(item.end)}`;
      details.append(speaker, timing);
      const status = document.createElement("span");
      status.className = "segment-state";
      status.textContent = index === state.reviewQueueIndex ? "当前" : "需复习";
      button.append(number, details, status);
      button.addEventListener("click", () => {
        void activateReviewQueueIndex(index, { autoplay: true, resetScroll: true });
        if (!isInlineSegmentDrawer()) closeSegmentDrawer(false);
      });
      fragment.append(button);
    });
    elements.segmentList.append(fragment);
    return;
  }
  const units = currentUnits();
  const modeLabel = "自然分段";
  const heardCount = units.filter(unitIsHeard).length;
  elements.segmentModeLabel.textContent = modeLabel;
  elements.segmentHeardSummary.textContent = `已听 ${heardCount} / ${units.length}`;
  elements.segmentList.replaceChildren();
  const numberWidth = String(units.length).length;
  const fragment = document.createDocumentFragment();

  units.forEach((unit, index) => {
    const learningState = unitLearningState(unit);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `segment-row is-${learningState.key}`;
    button.setAttribute("aria-current", String(index === state.index));
    button.setAttribute("aria-label", `第 ${index + 1} 个${modeLabel}，${unit.speaker || "Speaker"}，${learningState.label}`);

    const number = document.createElement("span");
    number.className = "segment-number";
    number.textContent = String(index + 1).padStart(numberWidth, "0");

    const details = document.createElement("span");
    details.className = "segment-details";
    const speaker = document.createElement("strong");
    speaker.textContent = unit.speaker || "Speaker";
    const timing = document.createElement("span");
    timing.textContent = `${formatClock(unit.start)}–${formatClock(unit.end)} · ${unit.wordCount || 0} 词`;
    details.append(speaker, timing);

    const status = document.createElement("span");
    status.className = "segment-state";
    status.textContent = index === state.index ? "当前" : learningState.label;
    button.append(number, details, status);
    button.addEventListener("click", () => jumpToUnit(index));
    fragment.append(button);
  });
  elements.segmentList.append(fragment);
}

function unitLearningState(unit) {
  if (unitNeedsReview(unit)) return { key: "review", label: "需复习" };
  if (unitIsHeard(unit)) return { key: "heard", label: "已听" };
  return { key: "unheard", label: "未听" };
}

function unitIsHeard(unit) {
  const ids = unitSentenceIds(unit);
  return Boolean(ids.length && ids.every((id) => state.material?.progress?.[id]?.heard));
}

function jumpToUnit(index) {
  const units = currentUnits();
  if (!units[index]) return;
  state.index = index;
  state.revealed = false;
  saveStudyPosition();
  renderCurrentUnit();
  updateResumeButton();
  requestAnimationFrame(() => scrollTrainingWorkspaceToTop());
  if (!isInlineSegmentDrawer()) {
    closeSegmentDrawer(false);
    elements.segmentListButton.focus();
  }
  playUnitFromStart();
}

function saveStudyPosition() {
  if (inReviewMode()) return;
  const unit = currentUnit();
  if (!unit || !state.material) return;
  const allUnits = state.material[DEFAULT_STUDY_MODE] || [];
  const index = Math.max(0, allUnits.findIndex((item) => item.id === unit.id));
  try {
    localStorage.setItem(studyPositionKey(state.material.id, DEFAULT_STUDY_MODE), JSON.stringify({ unitId: unit.id, index, updatedAt: Date.now() }));
  } catch {
    // Resume remains optional when browser storage is unavailable.
  }
}

function loadStudyPosition(mode = DEFAULT_STUDY_MODE) {
  if (!state.material) return null;
  const units = state.material[mode] || [];
  try {
    const saved = JSON.parse(localStorage.getItem(studyPositionKey(state.material.id, mode)) || "null");
    if (!saved) return null;
    const index = resolveSavedStudyIndex(units, saved);
    return units[index] ? { ...saved, index, unitId: units[index].id } : null;
  } catch {
    return null;
  }
}

function updateResumeButton() {
  const saved = loadStudyPosition();
  const units = state.material?.[DEFAULT_STUDY_MODE] || [];
  const alreadyThere = currentUnit()?.id === saved?.unitId;
  const visible = Boolean(saved && saved.index > 0 && !inReviewMode() && !alreadyThere);
  elements.resumeButton.classList.toggle("is-hidden", !visible);
  if (visible) elements.resumeButton.textContent = `继续上次 · ${saved.index + 1}/${units.length}`;
}

function resumeLastPosition() {
  const saved = loadStudyPosition();
  if (!saved || inReviewMode()) return;
  state.index = saved.index;
  state.revealed = false;
  renderCurrentUnit();
  updateResumeButton();
  requestAnimationFrame(() => scrollTrainingWorkspaceToTop());
  playUnitFromStart();
}

function studyPositionKey(materialId, mode) {
  return `${STUDY_POSITION_STORAGE_PREFIX}:${materialId}:${mode}`;
}

function openTranscriptEditor() {
  const unit = currentUnit();
  if (!unit || state.mode !== "sentences") return;
  elements.transcriptEditInput.value = unit.text;
  elements.editTranscriptPanel.classList.remove("is-hidden");
  elements.transcriptEditInput.focus();
}

function closeTranscriptEditor() {
  elements.editTranscriptPanel.classList.add("is-hidden");
}

async function saveTranscriptEdit() {
  const unit = currentUnit();
  const text = elements.transcriptEditInput.value.trim();
  if (!unit || !text) return;
  const materialId = state.material.id;
  try {
    const payload = await api(`/api/materials/${materialId}/sentences/${unit.id}`, {
      method: "PATCH",
      body: { text, expectedText: unit.text },
    });
    if (state.material?.id !== materialId) return;
    state.material = payload.material;
    if (payload.job) {
      state.material.analysisStatus = "processing";
      scheduleAnalysisStatusPoll(500);
    }
    closeTranscriptEditor();
    renderCurrentUnit();
    showToast("原文修正已保存在本机，正在更新讲解");
  } catch (error) {
    showToast(error.message);
  }
}

async function retryAnalysis() {
  try {
    const payload = await api(`/api/materials/${state.material.id}/analyze`, { method: "POST", body: {} });
    elements.analysisRetry.classList.add("is-hidden");
    state.activeJobId = payload.job.id;
    state.material.analysisStatus = "processing";
    scheduleAnalysisStatusPoll(500);
    showToast("所选 AI 正在重新生成讲解");
  } catch (error) {
    showToast(error.message);
  }
}

function scheduleAnalysisStatusPoll(delay = 8000) {
  clearTimeout(state.analysisPollTimer);
  if (!state.material || !["pending", "processing"].includes(state.material.analysisStatus)) {
    state.analysisPollTimer = null;
    return;
  }
  const materialId = state.material.id;
  state.analysisPollTimer = setTimeout(() => pollAnalysisStatus(materialId), delay);
}

async function pollAnalysisStatus(materialId) {
  if (state.material?.id !== materialId) return;
  try {
    const library = await api("/api/materials");
    const status = library.materials.find((material) => material.id === materialId);
    if (!status) return;
    if (state.material?.id !== materialId) return;
    if (["pending", "processing"].includes(status.analysisStatus)) {
      if (status.stage && status.stage !== state.material.stage) {
        const payload = await api(`/api/materials/${materialId}`);
        if (state.material?.id !== materialId) return;
        state.material = payload.material;
        renderTraining();
      }
      scheduleAnalysisStatusPoll();
      return;
    }

    const payload = await api(`/api/materials/${materialId}`);
    if (state.material?.id !== materialId) return;
    state.material = payload.material;
    await loadMaterials();
    renderTraining();
    showToast(status.analysisStatus === "ready" ? "讲解已经生成完成" : (status.warning || "讲解生成失败，可以重新生成"));
  } catch {
    if (state.material?.id === materialId && ["pending", "processing"].includes(state.material.analysisStatus)) {
      scheduleAnalysisStatusPoll(15000);
    }
  }
}

function handleKeyboard(event) {
  if (event.defaultPrevented) return;
  if (event.key === "Escape" && !elements.askPanel.classList.contains("is-hidden")) {
    event.preventDefault();
    collapseAskRail();
    return;
  }
  if (event.key === "Escape" && elements.segmentDrawer.classList.contains("is-open")) {
    event.preventDefault();
    closeSegmentDrawer();
    return;
  }
  if (elements.segmentDrawer.classList.contains("is-open") && !isInlineSegmentDrawer()) return;
  if (event.target === elements.paneResizer || elements.paneResizer.contains(event.target)) return;
  const focusedControl = document.activeElement?.closest?.("button, input, textarea, select, a");
  if (focusedControl || elements.trainingView.classList.contains("is-hidden")) return;
  if (event.code === "Space") { event.preventDefault(); togglePlayback(); }
  if (event.key.toLowerCase() === "r") replayCurrent();
  if (event.key === "ArrowLeft") { event.preventDefault(); navigateUnit(-1, true); }
  if (event.key === "ArrowRight") { event.preventDefault(); navigateUnit(1, true); }
}

function unitSentenceIds(unit) {
  return Array.isArray(unit.sentenceIds) ? unit.sentenceIds : [unit.id];
}

function unitTrailingContextSentenceIds(unit) {
  return Array.isArray(unit?.trailingContextSentenceIds) ? unit.trailingContextSentenceIds : [];
}

function unitReviewSentenceIds(unit) {
  return [...unitSentenceIds(unit), ...unitTrailingContextSentenceIds(unit)];
}

function uniquePhrases(phrases) {
  const seen = new Set();
  return phrases.filter((phrase) => {
    const key = normalizeWord(phrase.text);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isPhraseTooSimple(sourceText) {
  const key = normalizeKnowledgeText(sourceText);
  return (state.learnerProfile?.tooSimple || []).some((item) => (
    normalizeKnowledgeText(item.normalizedText || item.text) === key
  ));
}

function uniqueSpokenFormNotes(notes) {
  const seen = new Set();
  return notes.filter((note) => {
    const key = `${note.kind}:${normalizeReviewText(note.sourceText)}:${normalizeReviewText(note.correctedEnglish)}`;
    if (!note.sourceText || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tokenize(text) {
  return String(text).match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[^\sA-Za-z0-9]/g) || [];
}

function normalizeWord(word) {
  return String(word).toLowerCase().replace(/[^a-z0-9']/g, "");
}

function normalizeReviewText(value) {
  return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeKnowledgeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function lcsMatchedTargetIndexes(source, target) {
  const rows = source.length + 1;
  const cols = target.length + 1;
  const table = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      table[i][j] = source[i - 1] && source[i - 1] === target[j - 1]
        ? table[i - 1][j - 1] + 1
        : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  const matched = new Set();
  let i = source.length;
  let j = target.length;
  while (i > 0 && j > 0) {
    if (source[i - 1] && source[i - 1] === target[j - 1]) {
      matched.add(j - 1); i -= 1; j -= 1;
    } else if (table[i - 1][j] >= table[i][j - 1]) i -= 1;
    else j -= 1;
  }
  return matched;
}

function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds))) return "处理中";
  const minutes = Math.round(Number(seconds) / 60);
  return `${minutes} 分钟`;
}

function formatTrashDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

let toastTimer;
let toastAction = null;
function showToast(message, options = {}) {
  toastAction = typeof options.onAction === "function" ? options.onAction : null;
  elements.toastText.textContent = message;
  elements.toastActionButton.textContent = options.label || "撤销";
  elements.toastActionButton.classList.toggle("is-hidden", !toastAction);
  elements.toastActionButton.disabled = false;
  elements.toast.classList.toggle("has-action", Boolean(toastAction));
  elements.toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, toastAction ? 7000 : 4200);
}

function hideToast() {
  elements.toast.classList.remove("is-visible", "has-action");
  elements.toastActionButton.classList.add("is-hidden");
  toastAction = null;
}

async function runToastAction() {
  const action = toastAction;
  if (!action) return;
  toastAction = null;
  elements.toastActionButton.disabled = true;
  clearTimeout(toastTimer);
  await action();
}

async function api(url, options = {}) {
  const init = { method: options.method || "GET", headers: {} };
  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.detail || payload.error || payload.message || `请求失败 (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}
