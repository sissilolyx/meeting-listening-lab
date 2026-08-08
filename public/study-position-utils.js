export function resolveLatestStudyIndex(units = [], progress = {}, savedPosition = null) {
  if (!units.length) return 0;

  const savedIndex = resolveSavedStudyIndex(units, savedPosition);
  let latestHeardIndex = -1;

  units.forEach((unit, index) => {
    const ids = unitSentenceIds(unit);
    if (ids.some((id) => progress?.[id]?.heard)) latestHeardIndex = index;
  });

  return Math.max(0, savedIndex, latestHeardIndex);
}

export function resolveSavedStudyIndex(units = [], savedPosition = null) {
  if (!savedPosition) return -1;
  const matchedIndex = units.findIndex((unit) => unit.id === savedPosition.unitId);
  if (matchedIndex >= 0) return matchedIndex;
  const mergedIndex = units.findIndex((unit) => [
    ...(Array.isArray(unit?.mergedFromSentenceIds) ? unit.mergedFromSentenceIds : []),
    ...(Array.isArray(unit?.mergedFromParagraphIds) ? unit.mergedFromParagraphIds : []),
  ].includes(savedPosition.unitId));
  if (mergedIndex >= 0) return mergedIndex;
  const fallbackIndex = Number(savedPosition.index);
  if (!Number.isFinite(fallbackIndex)) return -1;
  return Math.min(Math.max(0, Math.trunc(fallbackIndex)), units.length - 1);
}

function unitSentenceIds(unit) {
  if (Array.isArray(unit?.sentenceIds) && unit.sentenceIds.length) return unit.sentenceIds;
  return unit?.id ? [unit.id] : [];
}
