import { clipboardContainsFiles, extractPastedMediaFile, normalizePastedMediaFile } from "./file-import-utils.js";
import { classifyAskAnchor, resolveAskPanelTop } from "./ask-thread-utils.js";
import {
  playbackLeadInRatio,
  playbackTargetCompletion,
  resolveParagraphLeadIn,
  resolveParagraphPlaybackRange,
  resolveSentencePlaybackRange,
} from "./playback-range-utils.js";
import {
  pronunciationAccentLabel,
  selectPronunciationVoice,
  splitPronunciationText,
} from "./pronunciation-utils.js";
import { hasTranscriptReconstruction, resolvedLearningSource } from "./qa-answer-utils.js";
import { resolveLatestStudyIndex, resolveSavedStudyIndex } from "./study-position-utils.js";

const DEFAULT_PANE_RATIO = 0.44;
const DEFAULT_STUDY_MODE = "paragraphs";
const PANE_RATIO_STORAGE_KEY = "meeting-listening-pane-ratio";
const STUDY_POSITION_STORAGE_PREFIX = "meeting-listening-position";
const LIBRARY_PREFERENCES_STORAGE_KEY = "meeting-listening-library-preferences";
const LIBRARY_RAIL_COLLAPSED_STORAGE_KEY = "meeting-listening-library-rail-collapsed";
const INLINE_SEGMENT_DRAWER_QUERY = "(min-width: 1400px)";
const DOCKED_ASK_THREAD_QUERY = "(min-width: 1880px)";

const state = {
  status: null,
  materials: [],
  trash: [],
  trashLoading: false,
  restoringTrashIds: new Set(),
  trashDialogOpener: null,
  material: null,
  mode: DEFAULT_STUDY_MODE,
  reviewOnly: false,
  index: 0,
  revealed: false,
  loop: false,
  speed: 1,
  media: null,
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
  askContext: null,
  askAnswer: null,
  askHistoryDirty: false,
  askAnchorRect: null,
  askAnchorElement: null,
  askReturnFocus: null,
  askRequestId: 0,
  askRepositionFrame: null,
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
  await Promise.all([loadSystemStatus(), loadMaterials(), loadLearnerProfile(), loadTrash().catch(() => {})]);
  const materialId = new URLSearchParams(location.search).get("material");
  if (materialId) await openMaterial(materialId);
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

  document.querySelectorAll("[data-speed]").forEach((button) => button.addEventListener("click", () => setSpeed(Number(button.dataset.speed))));
  elements.reviewFilterButton.addEventListener("click", toggleReviewFilter);
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
  elements.closeAskPanelButton.addEventListener("click", () => closeAskPanel());
  elements.askReturnToSourceButton.addEventListener("click", returnToAskSource);
  elements.askSubmitButton.addEventListener("click", submitLearningQuestion);
  elements.saveQaReviewButton.addEventListener("click", saveQaReview);
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
    if (!tools.codex) missing.push("Codex CLI");
    else if (!tools.codexLoggedIn) missing.push("Codex 登录");
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

async function loadMaterials() {
  const payload = await api("/api/materials");
  state.materials = payload.materials;
  renderMaterialList();
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
    button.append(title, meta);
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
      button.append(progress);
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
    controls.append(pinButton, deleteButton, dragHandle);

    item.append(button, titleEditor, controls);
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
  if (payload.trashEntry) {
    state.trash = [payload.trashEntry, ...state.trash.filter((entry) => entry.id !== materialId)];
    renderTrash();
  }
  const deletedCurrentMaterial = state.material?.id === materialId;
  closeDeleteMaterialDialog(false);
  if (deletedCurrentMaterial) showHome();
  else renderMaterialList();
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

async function openMaterial(id) {
  pauseMedia();
  closeAskPanel(false);
  closeSegmentDrawer(false);
  const payload = await api(`/api/materials/${id}`);
  state.material = payload.material;
  if (state.material.status !== "ready" || !state.material.sentences.length) {
    showHome();
    showToast(state.material.error || state.material.stage || "材料仍在处理");
    return;
  }
  state.loop = false;
  renderLoopState();
  state.revealed = false;
  state.mode = DEFAULT_STUDY_MODE;
  state.reviewOnly = false;
  state.index = resolveLatestStudyIndex(
    state.material[DEFAULT_STUDY_MODE] || [],
    state.material.progress || {},
    loadStudyPosition(DEFAULT_STUDY_MODE),
  );
  state.heardSaving.clear();
  elements.reviewFilterButton.setAttribute("aria-pressed", "false");
  elements.homeView.classList.add("is-hidden");
  elements.trainingView.classList.remove("is-hidden");
  document.body.classList.add("is-training");
  history.replaceState(null, "", `?material=${encodeURIComponent(id)}`);
  renderMaterialList();
  setupMedia();
  renderTraining();
  applyInitialSegmentDrawerState();
  scheduleAnalysisStatusPoll();
  requestAnimationFrame(() => {
    applyPaneRatio(state.paneRatio);
    scrollTrainingWorkspaceToTop();
  });
}

function showHome() {
  clearTimeout(state.analysisPollTimer);
  state.analysisPollTimer = null;
  closeAskPanel(false);
  closeSegmentDrawer(false);
  disposeMedia();
  document.body.classList.remove("is-training");
  elements.trainingView.classList.add("is-hidden");
  elements.homeView.classList.remove("is-hidden");
  history.replaceState(null, "", location.pathname);
  state.material = null;
  renderMaterialList();
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
    ? "Codex 讲解尚未生成，但原声精听可以继续。"
    : "这份旧材料还没有口语结构说明，可以补充生成。";
  elements.retryAnalysisButton.textContent = material.analysisStatus === "failed" ? "重新生成讲解" : "补充口语结构说明";
  renderCurrentUnit();
  updateResumeButton();
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
  if (!state.reviewOnly) return units;
  return units.filter((unit) => paragraphContainsReview(unit));
}

function reviewItems() {
  return state.material?.reviewItems || [];
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
    pauseMedia();
    elements.segmentContinuation.classList.add("is-hidden");
    updateUnitPlaybackProgress();
    elements.unitCounter.textContent = "没有需复习的片段";
    elements.studyProgress.style.width = "0%";
    showToast("当前没有标记为需复习的片段");
    return;
  }

  const ids = unitSentenceIds(unit);
  const progress = state.material.progress || {};
  const savedDictation = ids.map((id) => progress[id]?.dictation).find(Boolean) || "";
  const savedParagraphReview = findParagraphReview(unit.id);

  pauseMedia();
  state.playbackPassEligible = false;
  const playbackRange = currentPlaybackRange(unit);
  if (state.media?.readyState >= 1) state.media.currentTime = Math.max(0, playbackRange.start - 0.08);
  elements.unitCounter.textContent = `${state.index + 1} / ${units.length}`;
  elements.studyProgress.style.width = `${((state.index + 1) / units.length) * 100}%`;
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
  elements.markReviewHint.textContent = savedParagraphReview ? "会出现在「只听需复习」中" : "需要再听时点这里";
  renderSegmentContinuation(unit, units);
  hideSelectionAction();
  elements.sentenceContext.classList.add("is-hidden");
  renderAnalysis(unit);
  renderDiff(elements.dictationInput.value, unit.text);
  updateUnitPlaybackProgress();
  if (elements.segmentDrawer.classList.contains("is-open")) renderSegmentDirectory();
  scheduleAskPanelReposition();
}

function renderAnalysis(unit) {
  const sentenceItems = unit.sentenceIds
    .map((id) => state.material.sentences.find((sentence) => sentence.id === id));
  const analysisProgressText = state.material.analysisStatus === "processing"
    ? `${state.material.stage || "Codex 正在生成讲解"}。原声和逐字稿已经可以练习，生成完成后这里会自动更新。`
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

  aside.append(marker, content, createSentenceAudioButton(sentence));
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
  const original = document.createElement("p");
  original.className = "sentence-study-original askable-sentence";
  original.dataset.sentenceId = sentence.id;
  original.dataset.askSurface = "original";
  original.tabIndex = 0;
  original.textContent = sentence.text;
  metaRow.append(meta, audioButton);
  originalGroup.append(metaRow, original);
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
    notes.forEach((note) => list.append(createSentenceNote(note)));
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

function createSentenceAudioButton(sentence) {
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
    : `播放第 ${formatClock(sentence.start)} 到 ${formatClock(sentence.end)} 的本句原声`;
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

function createSentenceNote(note) {
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
    const correctionLabel = document.createElement("span");
    correctionLabel.textContent = note.kind === "grammar"
      ? "清晰、正确的表达"
      : note.kind === "mistranscription" ? "说话人实际最可能说的是" : "去掉口语痕迹后";
    const correctedEnglish = document.createElement("p");
    correctedEnglish.className = "askable-sentence";
    correctedEnglish.dataset.sentenceId = note.sentenceId;
    correctedEnglish.dataset.askSurface = "note-correction";
    correctedEnglish.textContent = note.correctedEnglish;
    correction.append(correctionLabel, correctedEnglish);
    item.append(correction);
  }
  return item;
}

function createSentencePhrase(phrase) {
  const row = document.createElement("div");
  row.className = "sentence-phrase-row";
  const content = document.createElement("div");
  const term = document.createElement("strong");
  term.className = "askable-sentence";
  term.dataset.sentenceId = phrase.sentenceId;
  term.dataset.askSurface = "phrase";
  term.textContent = phrase.text;
  const copy = document.createElement("p");
  const phraseDetails = [phrase.meaningZh, phrase.usageZh]
    .filter(Boolean)
    .map((value) => String(value).replace(/[。.!！?？]+$/u, ""));
  copy.textContent = phraseDetails.length ? `${phraseDetails.join("。")}。` : "";
  content.append(term, copy);
  const history = createPhraseQuestionHistory(phrase);
  if (history) content.append(history);
  const actions = document.createElement("div");
  actions.className = "phrase-actions";
  const simpleButton = document.createElement("button");
  simpleButton.type = "button";
  simpleButton.className = "text-button simple-feedback-button";
  simpleButton.textContent = "太简单";
  simpleButton.setAttribute("aria-label", `标记为太简单：${phrase.text}`);
  simpleButton.addEventListener("click", () => markPhraseTooSimple(phrase, simpleButton));
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
  actions.append(simpleButton, reviewButton, askButton);
  row.append(content, actions);
  return row;
}

function questionHistoryItems() {
  const historyItems = Array.isArray(state.material?.qaHistory) ? state.material.qaHistory : [];
  const items = [];
  const historyIds = new Set();
  const compositeKeys = new Set();
  for (const item of historyItems) {
    const key = questionHistoryKey(item);
    if (item.id && historyIds.has(item.id)) continue;
    items.push({ ...item, isLegacyReview: false });
    if (item.id) historyIds.add(item.id);
    if (key) compositeKeys.add(key);
  }
  for (const item of reviewItems().filter((candidate) => candidate.kind === "qa")) {
    const key = questionHistoryKey(item);
    // A review linked to a real history record is not a second copy of that
    // record. This also prevents a deliberately deleted history record from
    // being recreated by its still-saved review item.
    if (item.historyId || !key || compositeKeys.has(key)) continue;
    items.push({ ...item, isLegacyReview: true });
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

function findQuestionHistoryReview(note) {
  if (note.isLegacyReview) return reviewItems().find((item) => item.id === note.id);
  const key = questionHistoryKey(note);
  return reviewItems().find((item) => (
    item.kind === "qa"
    && (item.historyId === note.id || (!item.historyId && questionHistoryKey(item) === key))
  ));
}

async function toggleQuestionHistoryReview(note, button) {
  button.disabled = true;
  try {
    const saved = findQuestionHistoryReview(note);
    if (saved) {
      const payload = await api(`/api/materials/${state.material.id}/review-items/${saved.id}`, { method: "DELETE" });
      state.material = payload.material;
      showToast("已从复习中移除，问问记录仍会保留");
    } else {
      const payload = await api(`/api/materials/${state.material.id}/review-items`, {
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
      state.material = payload.material;
      showToast("已把这条问问记录加入对应自然句复习");
    }
    renderAnalysis(currentUnit());
    loadMaterials();
  } catch (error) {
    button.disabled = false;
    showToast(error.message);
  }
}

async function deleteQuestionHistoryRecord(note, button) {
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
  const linkedReviewWillRemain = !note.isLegacyReview && Boolean(findQuestionHistoryReview(note));
  try {
    const endpoint = note.isLegacyReview
      ? `/api/materials/${state.material.id}/review-items/${note.id}`
      : `/api/materials/${state.material.id}/qa-history/${note.id}`;
    const payload = await api(endpoint, { method: "DELETE" });
    state.material = payload.material;
    if (note.isLegacyReview) showToast("旧版问问记录已删除，并已从复习中移除");
    else if (linkedReviewWillRemain) showToast("问问记录已删除，已加入复习的内容仍保留");
    else showToast("问问记录已删除");
    renderAnalysis(currentUnit());
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
  renderSegmentContinuation(currentUnit(), currentUnits());
}

function renderSegmentContinuation(unit = currentUnit(), units = currentUnits()) {
  const visible = Boolean(state.revealed && unit && units.length);
  elements.segmentContinuation.classList.toggle("is-hidden", !visible);
  if (!visible) return;

  const currentIndex = units.findIndex((candidate) => candidate.id === unit.id);
  const resolvedIndex = currentIndex >= 0 ? currentIndex : Math.min(Math.max(0, state.index), units.length - 1);
  const canAdvance = resolvedIndex < units.length - 1;
  elements.bottomNextButton.classList.toggle("is-hidden", !canAdvance);
  elements.segmentCompleteState.classList.toggle("is-hidden", canAdvance);

  if (canAdvance) {
    const nextPosition = resolvedIndex + 2;
    elements.bottomNextEyebrow.textContent = state.reviewOnly ? "继续本轮复习" : "继续精听";
    elements.bottomNextLabel.textContent = state.reviewOnly ? "下一条需复习片段" : "下一段";
    elements.bottomNextHint.textContent = `第 ${nextPosition} / ${units.length} 段 · 回到顶部并自动播放原声`;
    elements.bottomNextButton.setAttribute("aria-label", `进入第 ${nextPosition} 段并自动播放原声`);
  } else {
    elements.segmentCompleteLabel.textContent = state.reviewOnly ? "本轮复习已到最后一段" : "已到最后一段";
  }
}

function advanceFromBottom() {
  const units = currentUnits();
  const unit = currentUnit();
  if (!unit || !units.length) return;
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
  button.disabled = true;
  try {
    const saved = findPhraseReview(phrase.sentenceId, phrase.text);
    if (saved) {
      const payload = await api(`/api/materials/${state.material.id}/review-items/${saved.id}`, { method: "DELETE" });
      state.material = payload.material;
      showToast("已从复习中移除");
    } else {
      const payload = await api(`/api/materials/${state.material.id}/review-items`, {
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
    loadMaterials();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
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
  state.selectionContext = {
    sentenceId: startSentence.dataset.sentenceId,
    sourceText: selectedText,
    question: defaultSelectionQuestion(selectedText),
    anchorSurface: askAnchorSurface(startSentence),
    anchorRect: snapshotRect(rect),
    returnFocus: startSentence,
  };
  elements.selectionAskButton.style.left = `${Math.max(12, Math.min(window.innerWidth - 104, rect.left + rect.width / 2 - 43))}px`;
  elements.selectionAskButton.style.top = `${Math.max(12, rect.top - 43)}px`;
  elements.selectionAskButton.classList.remove("is-hidden");
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
  stopPronunciation();
  const sentence = state.material.sentences.find((item) => item.id === context.sentenceId);
  if (!sentence) return showToast("没有找到这处原文对应的自然句");
  const sourceText = String(context.sourceText || "").trim();
  if (!sourceText) return showToast("请先选择或指定想问的内容");
  state.askRequestId += 1;
  const initialAnchor = resolveInitialAskAnchor(context, anchorElement);
  const anchorSurface = context.anchorSurface || askAnchorSurface(initialAnchor);
  state.askContext = {
    materialId: state.material.id,
    sentenceId: sentence.id,
    sourceText,
    anchorSurface,
  };
  state.askAnswer = null;
  setAskAnchorElement(initialAnchor);
  state.askAnchorRect = snapshotRect(state.askAnchorElement?.getBoundingClientRect() || context.anchorRect);
  state.askReturnFocus = context.returnFocus || anchorElement || state.askAnchorElement || null;
  elements.askPanel.dataset.sentenceId = sentence.id;
  elements.askPanel.dataset.sourceText = sourceText;
  elements.askPanel.dataset.anchorSurface = anchorSurface;
  elements.askSourceText.textContent = sourceText;
  elements.askQuestionInput.value = context.question || defaultSelectionQuestion(sourceText);
  elements.askStatusText.textContent = "回答会结合这句话的前后语境。";
  elements.askAnswerBlock.classList.add("is-hidden");
  elements.askReconstructionBlock.classList.add("is-hidden");
  elements.askGrammarPoint.classList.add("is-hidden");
  elements.askAnchorLink.classList.add("is-hidden");
  elements.askPanel.setAttribute("aria-busy", "false");
  elements.askSubmitButton.disabled = false;
  elements.askPanel.scrollTop = 0;
  elements.askPanel.classList.remove("is-hidden");
  elements.trainingView.classList.add("has-ask-thread");
  document.body.classList.add("has-ask-thread");
  scheduleAskPanelReposition();
  requestAnimationFrame(() => {
    schedulePaneResizeRefresh();
    elements.askQuestionInput.focus({ preventScroll: true });
  });
}

function closeAskPanel(restoreFocus = true) {
  stopPronunciation();
  state.askRequestId += 1;
  const returnFocus = state.askReturnFocus;
  const shouldRefreshHistory = state.askHistoryDirty;
  if (state.askRepositionFrame) cancelAnimationFrame(state.askRepositionFrame);
  state.askRepositionFrame = null;
  elements.askPanel.classList.add("is-hidden");
  elements.askPanel.style.removeProperty("left");
  elements.askPanel.style.removeProperty("top");
  elements.askPanel.style.removeProperty("max-height");
  elements.askPanel.removeAttribute("data-layout");
  elements.askPanel.removeAttribute("data-anchor-state");
  elements.askPanel.setAttribute("aria-busy", "false");
  elements.askSubmitButton.disabled = false;
  elements.askAnchorLink.classList.add("is-hidden");
  elements.trainingView.classList.remove("has-ask-thread");
  document.body.classList.remove("has-ask-thread");
  state.askContext = null;
  state.askAnswer = null;
  state.askHistoryDirty = false;
  state.askAnchorRect = null;
  setAskAnchorElement(null);
  state.askReturnFocus = null;
  delete elements.askPanel.dataset.sentenceId;
  delete elements.askPanel.dataset.sourceText;
  delete elements.askPanel.dataset.anchorSurface;
  if (restoreFocus && returnFocus?.isConnected) {
    if (!returnFocus.matches?.("button, input, textarea, select, a, [tabindex]")) returnFocus.tabIndex = -1;
    returnFocus.focus?.({ preventScroll: true });
  }
  if (shouldRefreshHistory && state.material && state.revealed && currentUnit()) {
    requestAnimationFrame(() => renderAnalysis(currentUnit()));
  }
  schedulePaneResizeRefresh();
}

function positionAskPanel(anchorRect) {
  if (elements.askPanel.classList.contains("is-hidden")) return;
  const padding = 12;
  const gap = 14;
  const isBottomSheet = window.innerWidth <= 1060;
  const isDockedRail = window.matchMedia(DOCKED_ASK_THREAD_QUERY).matches;
  const layout = isBottomSheet ? "bottom" : isDockedRail ? "rail" : "floating";
  const bottomOffset = isBottomSheet ? 64 : 0;
  const viewportMaxHeight = window.innerHeight - padding * 2 - bottomOffset;
  elements.askPanel.dataset.layout = layout;
  elements.askPanel.style.maxHeight = `${viewportMaxHeight}px`;
  const width = elements.askPanel.offsetWidth;
  const height = elements.askPanel.offsetHeight;
  const anchorState = classifyAskAnchor(anchorRect, window.innerHeight, padding);
  const top = isBottomSheet
    ? resolveAskPanelTop({
      anchorRect: { top: window.innerHeight, bottom: window.innerHeight },
      panelHeight: height,
      viewportHeight: window.innerHeight,
      padding,
      bottomOffset,
    })
    : resolveAskPanelTop({ anchorRect, panelHeight: height, viewportHeight: window.innerHeight, padding });
  let left = window.innerWidth - width - padding;
  let placement = "rail";
  if (isBottomSheet) {
    placement = "bottom";
  } else if (!isDockedRail && anchorRect && anchorState === "visible") {
    const roomRight = window.innerWidth - anchorRect.right - gap - padding;
    const roomLeft = anchorRect.left - gap - padding;
    if (roomRight >= width) {
      left = anchorRect.right + gap;
      placement = "right";
    } else if (roomLeft >= width) {
      left = anchorRect.left - width - gap;
      placement = "left";
    }
  }
  left = Math.max(padding, Math.min(window.innerWidth - width - padding, left));
  elements.askPanel.dataset.anchorState = anchorState;
  elements.askPanel.dataset.placement = placement;
  elements.askPanel.style.left = `${Math.round(left)}px`;
  elements.askPanel.style.top = `${Math.round(top)}px`;
  updateAskAnchorLink(anchorState);
}

function repositionOpenAskPanel() {
  if (elements.askPanel.classList.contains("is-hidden")) return;
  const anchorElement = resolveAskAnchorElement();
  setAskAnchorElement(anchorElement);
  const nextRect = anchorElement?.isConnected ? snapshotRect(anchorElement.getBoundingClientRect()) : null;
  state.askAnchorRect = nextRect;
  positionAskPanel(nextRect);
}

function scheduleAskPanelReposition() {
  if (elements.askPanel.classList.contains("is-hidden") || state.askRepositionFrame) return;
  state.askRepositionFrame = requestAnimationFrame(() => {
    state.askRepositionFrame = null;
    repositionOpenAskPanel();
  });
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

function resolveAskAnchorElement() {
  if (state.askAnchorElement?.isConnected && state.askAnchorElement.getClientRects().length) {
    return state.askAnchorElement;
  }
  const sentenceId = state.askContext?.sentenceId;
  const sourceKey = normalizeReviewText(state.askContext?.sourceText || "");
  const anchorSurface = state.askContext?.anchorSurface || "";
  if (!sentenceId) return null;
  const candidates = [...document.querySelectorAll(".askable-sentence[data-sentence-id]")]
    .filter((element) => element.dataset.sentenceId === sentenceId && element.getClientRects().length);
  const sameSurface = anchorSurface
    ? candidates.filter((element) => askAnchorSurface(element) === anchorSurface)
    : [];
  const preferred = sameSurface.length ? sameSurface : candidates;
  const exact = preferred.find((element) => normalizeReviewText(element.textContent) === sourceKey);
  const containing = preferred.find((element) => normalizeReviewText(element.textContent).includes(sourceKey));
  return exact || containing || preferred.find((element) => element.classList.contains("sentence-study-original")) || preferred[0] || null;
}

function askAnchorSurface(element) {
  return element?.dataset?.askSurface
    || (element?.classList?.contains("sentence-study-original") ? "original" : "");
}

function setAskAnchorElement(element) {
  if (state.askAnchorElement === element) return;
  state.askAnchorElement?.classList?.remove("is-ask-anchor");
  state.askAnchorElement = element?.isConnected ? element : null;
  state.askAnchorElement?.classList?.add("is-ask-anchor");
}

function updateAskAnchorLink(anchorState) {
  const isVisible = anchorState === "visible";
  elements.askAnchorLink.classList.toggle("is-hidden", isVisible);
  if (isVisible) return;
  elements.askAnchorStatus.textContent = anchorState === "above"
    ? "原句在上方"
    : anchorState === "below" ? "原句在下方" : "原句不在当前片段";
}

function returnToAskSource() {
  let anchorElement = resolveAskAnchorElement();
  if (!anchorElement && state.askContext?.sentenceId && state.material) {
    let units = currentUnits();
    let targetIndex = units.findIndex((unit) => unitSentenceIds(unit).includes(state.askContext.sentenceId));
    if (targetIndex < 0 && state.reviewOnly) {
      state.reviewOnly = false;
      elements.reviewFilterButton.setAttribute("aria-pressed", "false");
      units = currentUnits();
      targetIndex = units.findIndex((unit) => unitSentenceIds(unit).includes(state.askContext.sentenceId));
    }
    if (targetIndex >= 0) {
      state.index = targetIndex;
      state.revealed = true;
      renderCurrentUnit();
      anchorElement = resolveAskAnchorElement();
    }
  }
  requestAnimationFrame(() => {
    const target = anchorElement?.isConnected ? anchorElement : resolveAskAnchorElement();
    if (!target) return showToast("暂时找不到这处原文");
    setAskAnchorElement(target);
    target.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
    });
    scheduleAskPanelReposition();
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
  if (elements.askPanel.classList.contains("is-hidden")) return;
  if (event.target === elements.askPanel || elements.askPanel.contains(event.target)) return;
  scheduleAskPanelReposition();
}

async function submitLearningQuestion() {
  const question = elements.askQuestionInput.value.trim();
  const sentenceId = state.askContext?.sentenceId || elements.askPanel.dataset.sentenceId || "";
  const sourceText = state.askContext?.sourceText
    || elements.askPanel.dataset.sourceText
    || elements.askSourceText.textContent.trim();
  if (!sentenceId || !sourceText) return showToast("请先选择或指定想问的内容");
  if (!question) return showToast("请输入你想继续了解的问题");
  const materialId = state.material.id;
  const requestId = ++state.askRequestId;
  state.askContext = {
    ...state.askContext,
    materialId,
    sentenceId,
    sourceText,
  };
  stopPronunciation();
  elements.askSubmitButton.disabled = true;
  elements.askPanel.setAttribute("aria-busy", "true");
  elements.askStatusText.textContent = "Codex 正在结合原句和前后语境回答…";
  try {
    const payload = await api(`/api/materials/${materialId}/ask`, {
      method: "POST",
      body: {
        sentenceId,
        selectedText: sourceText,
        question,
      },
    });
    if (payload.historyItem && state.material?.id === materialId) {
      state.material.qaHistory = Array.isArray(state.material.qaHistory) ? state.material.qaHistory : [];
      if (!state.material.qaHistory.some((item) => item.id === payload.historyItem.id)) {
        state.material.qaHistory.push(payload.historyItem);
      }
      state.askHistoryDirty = true;
    }
    const isCurrentRequest = requestId === state.askRequestId
      && !elements.askPanel.classList.contains("is-hidden")
      && state.askContext?.materialId === materialId;
    if (!isCurrentRequest) {
      if (payload.historyItem && state.material?.id === materialId) {
        if (elements.askPanel.classList.contains("is-hidden") && state.revealed && currentUnit()) {
          state.askHistoryDirty = false;
          renderAnalysis(currentUnit());
        }
        showToast(elements.askPanel.classList.contains("is-hidden")
          ? "刚才的回答已保存到对应词条"
          : "上一条回答已保存到对应词条");
      }
      return;
    }
    state.askAnswer = {
      ...payload.answer,
      historyId: payload.historyItem?.id || "",
    };
    const hasReconstruction = hasTranscriptReconstruction(payload.answer);
    elements.askReconstructionBlock.classList.toggle("is-hidden", !hasReconstruction);
    elements.askReconstructedEnglish.textContent = hasReconstruction ? payload.answer.likelySpokenEnglish : "";
    elements.askReconstructedMeaning.textContent = hasReconstruction ? payload.answer.intendedMeaningZh : "";
    const grammarPoint = String(payload.answer.grammarPointZh || "").trim();
    elements.askGrammarPoint.classList.toggle("is-hidden", !grammarPoint);
    elements.askGrammarPointText.textContent = grammarPoint;
    renderPronounceableText(elements.askAnswerText, payload.answer.answerZh, payload.answer.selectedText || sourceText);
    renderPronounceableText(elements.askSummaryText, payload.answer.learningSummaryZh, payload.answer.selectedText || sourceText);
    elements.askAnswerBlock.classList.remove("is-hidden");
    elements.saveQaReviewButton.disabled = false;
    elements.saveQaReviewButton.textContent = hasReconstruction ? "将还原表达加入复习" : "加入复习";
    elements.askStatusText.textContent = "已结合当前语境回答。";
    requestAnimationFrame(() => {
      scheduleAskPanelReposition();
      elements.askPanel.scrollTo({
        top: Math.max(0, elements.askAnswerBlock.offsetTop - 14),
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    });
  } catch (error) {
    if (requestId === state.askRequestId) {
      elements.askStatusText.textContent = "这次没有回答成功，可以重试。";
      showToast(error.message);
    }
  } finally {
    if (requestId === state.askRequestId) {
      elements.askSubmitButton.disabled = false;
      elements.askPanel.setAttribute("aria-busy", "false");
    }
  }
}

async function saveQaReview() {
  if (!state.askAnswer || !state.askContext) return;
  elements.saveQaReviewButton.disabled = true;
  try {
    const sourceText = resolvedLearningSource(state.askAnswer, state.askContext.sourceText);
    const payload = await api(`/api/materials/${state.material.id}/review-items`, {
      method: "POST",
      body: {
        kind: "qa",
        historyId: state.askAnswer.historyId || undefined,
        sentenceId: state.askAnswer.sentenceId,
        sourceText,
        question: state.askAnswer.question,
        answerZh: state.askAnswer.answerZh,
        learningSummaryZh: state.askAnswer.learningSummaryZh,
        grammarPointZh: state.askAnswer.grammarPointZh || "",
      },
    });
    state.material = payload.material;
    state.askHistoryDirty = false;
    elements.saveQaReviewButton.textContent = "已加入复习";
    renderAnalysis(currentUnit());
    showToast(hasTranscriptReconstruction(state.askAnswer)
      ? "已把还原后的真实表达加入对应自然句复习"
      : "这次追问已加入对应自然句的复习总结");
    loadMaterials();
  } catch (error) {
    elements.saveQaReviewButton.disabled = false;
    showToast(error.message);
  }
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

function setSpeed(speed) {
  state.speed = speed;
  if (state.media) state.media.playbackRate = speed;
  document.querySelectorAll("[data-speed]").forEach((button) => button.classList.toggle("is-active", Number(button.dataset.speed) === speed));
}

function toggleReviewFilter() {
  state.reviewOnly = !state.reviewOnly;
  state.index = 0;
  state.revealed = false;
  elements.reviewFilterButton.setAttribute("aria-pressed", String(state.reviewOnly));
  renderCurrentUnit();
  updateResumeButton();
  requestAnimationFrame(() => scrollTrainingWorkspaceToTop());
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
  } else if (media.currentTime <= playbackRange.start + 0.12) {
    state.playbackPassEligible = true;
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
  if (state.sentencePlayback?.button === button && !media.paused) {
    pauseMedia();
    return;
  }
  if (document.hidden || elements.trainingView.classList.contains("is-hidden")) return;

  pauseMedia();
  stopPronunciation();
  state.playbackPassEligible = false;
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

function enforceUnitBoundary() {
  const unit = currentUnit();
  const playbackRange = currentPlaybackRange(unit);
  if (!unit || !playbackRange || !state.media || state.media.currentTime < playbackRange.end + 0.04) return;
  if (state.playbackPassEligible) markUnitHeard(unit);
  if (document.hidden || elements.trainingView.classList.contains("is-hidden")) return pauseMedia();
  if (state.loop) {
    state.media.currentTime = Math.max(0, playbackRange.start - 0.08);
    state.playbackPassEligible = true;
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

function navigateUnit(delta, autoplay = false, { resetScroll = true } = {}) {
  saveDictationNow();
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

    renderCurrentUnit();
    loadMaterials();
    if (!wasSaved) {
      showToast("本段已加入复习，可在「只听需复习」中继续");
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
  if (!state.material) return;
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
  const visible = Boolean(saved && saved.index > 0 && !state.reviewOnly && !alreadyThere);
  elements.resumeButton.classList.toggle("is-hidden", !visible);
  if (visible) elements.resumeButton.textContent = `继续上次 · ${saved.index + 1}/${units.length}`;
}

function resumeLastPosition() {
  const saved = loadStudyPosition();
  if (!saved || state.reviewOnly) return;
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
  try {
    const payload = await api(`/api/materials/${state.material.id}/sentences/${unit.id}`, { method: "PATCH", body: { text } });
    state.material = payload.material;
    closeTranscriptEditor();
    renderCurrentUnit();
    showToast("原文修正已保存在本机");
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
    showToast("Codex 正在重新生成讲解");
  } catch (error) {
    showToast(error.message);
  }
}

function scheduleAnalysisStatusPoll(delay = 8000) {
  clearTimeout(state.analysisPollTimer);
  if (!state.material || state.material.analysisStatus !== "processing") {
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
    if (status.analysisStatus === "processing") {
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
    if (state.material?.id === materialId && state.material.analysisStatus === "processing") {
      scheduleAnalysisStatusPoll(15000);
    }
  }
}

function handleKeyboard(event) {
  if (event.defaultPrevented) return;
  if (event.key === "Escape" && !elements.askPanel.classList.contains("is-hidden")) {
    event.preventDefault();
    closeAskPanel();
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
  if (!response.ok) throw new Error(payload.detail || payload.error || `请求失败 (${response.status})`);
  return payload;
}
