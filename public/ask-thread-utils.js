export function classifyAskAnchor(rect, viewportHeight, padding = 12) {
  if (!rect) return "missing";
  if (rect.bottom < padding) return "above";
  if (rect.top > viewportHeight - padding) return "below";
  return "visible";
}

export function resolveAskPanelTop({
  anchorRect,
  panelHeight,
  viewportHeight,
  padding = 12,
  bottomOffset = 0,
}) {
  const anchorState = classifyAskAnchor(anchorRect, viewportHeight, padding);
  const maximumTop = Math.max(padding, viewportHeight - panelHeight - padding - bottomOffset);
  if (anchorState === "below") return maximumTop;
  if (anchorState === "above" || anchorState === "missing") return padding;
  return Math.max(padding, Math.min(maximumTop, anchorRect.top));
}

function iterableValues(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.values()];
  if (value && typeof value[Symbol.iterator] === "function") return [...value];
  return [];
}

/**
 * Remove repeated persisted question records without discarding legacy records
 * that do not have an id yet. The first occurrence wins so the material's
 * stored order remains stable.
 */
export function dedupeAskHistoryItems(historyItems = []) {
  const seenIds = new Set();
  return iterableValues(historyItems).filter((item) => {
    if (!item || typeof item !== "object") return false;
    const historyId = String(item.id || "").trim();
    if (!historyId) return true;
    if (seenIds.has(historyId)) return false;
    seenIds.add(historyId);
    return true;
  });
}

/**
 * Build the cards shown in one material paragraph's question rail. Persisted
 * history is normalized to completed cards. When sentenceIds is supplied,
 * history and transient requests outside that natural paragraph stay alive but
 * are omitted until their paragraph is active again. A transient card that
 * already points to a persisted history id is omitted, which keeps a completed
 * request from being rendered twice while its async response is reconciled.
 */
export function mergeAskThreadCards({
  materialId,
  sentenceIds,
  historyItems = [],
  transientCards = [],
} = {}) {
  const currentMaterialId = String(materialId || "");
  const scopedSentenceIds = Array.isArray(sentenceIds)
    ? new Set(sentenceIds.map((sentenceId) => String(sentenceId || "")).filter(Boolean))
    : null;
  const belongsToCurrentParagraph = (item) => (
    !scopedSentenceIds || scopedSentenceIds.has(String(item?.sentenceId || ""))
  );
  const history = dedupeAskHistoryItems(
    iterableValues(historyItems).filter((item) => (
      !item?.materialId || String(item.materialId) === currentMaterialId
    )).filter(belongsToCurrentParagraph),
  );
  const persistedIds = new Set(
    history.map((item) => String(item.id || "").trim()).filter(Boolean),
  );
  const historyCards = history.map((item, index) => {
    const historyId = String(item.id || "").trim();
    return {
      ...item,
      cardId: historyId
        ? `history:${historyId}`
        : `history:legacy:${index}:${String(item.sentenceId || "")}`,
      materialId: currentMaterialId,
      historyId,
      kind: "history",
      status: "complete",
      persisted: true,
    };
  });
  const pendingCards = iterableValues(transientCards)
    .filter((card) => card && typeof card === "object")
    .filter((card) => !card.materialId || String(card.materialId) === currentMaterialId)
    .filter(belongsToCurrentParagraph)
    .filter((card) => {
      const historyId = String(card.historyId || card.historyItem?.id || "").trim();
      return !historyId || !persistedIds.has(historyId);
    })
    .map((card, index) => ({
      ...card,
      cardId: String(card.cardId || card.id || `transient:${index}`),
      materialId: currentMaterialId,
      kind: "transient",
      persisted: false,
    }));

  return [...historyCards, ...pendingCards];
}

export function countAskThreadCards(cards = []) {
  const items = iterableValues(cards).filter((card) => card && typeof card === "object");
  return {
    total: items.length,
    pending: items.filter((card) => card.status === "pending").length,
  };
}

export function isAskRequestTokenCurrent(card, requestToken, materialId) {
  if (!card || card.requestToken !== requestToken) return false;
  if (materialId === undefined) return true;
  return String(card.materialId || "") === String(materialId || "");
}
