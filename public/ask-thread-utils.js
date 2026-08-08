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
