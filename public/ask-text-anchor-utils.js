export const ASK_ANCHOR_SURFACES = Object.freeze([
  "original",
  "note-source",
  "note-correction",
  "phrase",
  "dictation-diff",
]);

/**
 * Resolve one saved question anchor against the text currently rendered on a
 * surface. DOM Range offsets and JavaScript string offsets are both UTF-16
 * code-unit offsets, so these indices can be passed back to a text node
 * without converting them to Unicode code points.
 */
export function resolveTextAnchor(surfaceText, anchor = {}) {
  const text = String(surfaceText ?? "");
  if (!text || !anchor || typeof anchor !== "object") return null;

  const anchoredQuote = nonEmptyString(anchor.anchorExact);
  const legacyQuote = anchoredQuote ? "" : nonEmptyString(anchor.sourceText);
  const quote = anchoredQuote || legacyQuote;
  if (!quote) return null;
  const savedSurfaceText = stringValue(anchor.anchorSurfaceText);
  const surfaceUnchanged = !savedSurfaceText || savedSurfaceText === text;

  const start = nonNegativeInteger(anchor.anchorStart);
  const end = nonNegativeInteger(anchor.anchorEnd);
  if (surfaceUnchanged && start !== null && end !== null && end > start && end <= text.length) {
    if (text.slice(start, end) === quote) {
      return { start, end, exact: quote, method: "offset" };
    }
  }

  const matches = exactOccurrences(text, quote);
  if (!matches.length) return null;

  if (anchoredQuote) {
    const prefix = stringValue(anchor.prefix ?? anchor.anchorPrefix);
    const suffix = stringValue(anchor.suffix ?? anchor.anchorSuffix);
    if (prefix || suffix) {
      const contextual = matches.filter((match) => (
        (!prefix || text.slice(Math.max(0, match.start - prefix.length), match.start) === prefix)
        && (!suffix || text.slice(match.end, match.end + suffix.length) === suffix)
      ));
      if (contextual.length === 1) return { ...contextual[0], exact: quote, method: "context" };
      // Once an anchor has saved context, stale or ambiguous context means the
      // transcript changed around it. Never move that comment to a different
      // same-looking word merely because only one occurrence remains.
      return null;
    }
    if (!surfaceUnchanged) return null;
    if (matches.length === 1) return { ...matches[0], exact: quote, method: "quote" };
    return null;
  }

  // Old question records only have sourceText. Keep them useful when there is
  // exactly one occurrence, but never guess between repeated words.
  return matches.length === 1 ? { ...matches[0], exact: quote, method: "legacy" } : null;
}

/**
 * Split surface text into continuous, non-overlapping pieces. Each piece lists
 * every saved anchor that covers it, which lets the renderer underline
 * overlapping questions without losing either card association.
 */
export function segmentTextAnchors(surfaceText, anchors = []) {
  const text = String(surfaceText ?? "");
  if (!text) return [];
  const resolved = (Array.isArray(anchors) ? anchors : []).flatMap((anchor, index) => {
    const match = resolveTextAnchor(text, anchor);
    if (!match) return [];
    const id = anchor?.id ?? anchor?.historyId ?? String(index);
    return [{ id: String(id), anchor, ...match }];
  });
  if (!resolved.length) {
    return [{ text, start: 0, end: text.length, anchorIds: [], anchors: [] }];
  }

  const boundaries = [...new Set([
    0,
    text.length,
    ...resolved.flatMap(({ start, end }) => [start, end]),
  ])].sort((left, right) => left - right);
  const segments = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const segmentStart = boundaries[index];
    const segmentEnd = boundaries[index + 1];
    if (segmentEnd <= segmentStart) continue;
    const covering = resolved.filter(({ start, end }) => start <= segmentStart && end >= segmentEnd);
    const anchorIds = covering.map(({ id }) => id);
    const previous = segments.at(-1);
    if (previous && sameIds(previous.anchorIds, anchorIds)) {
      previous.end = segmentEnd;
      previous.text += text.slice(segmentStart, segmentEnd);
      continue;
    }
    segments.push({
      text: text.slice(segmentStart, segmentEnd),
      start: segmentStart,
      end: segmentEnd,
      anchorIds,
      anchors: covering.map(({ anchor }) => anchor),
    });
  }
  return segments;
}

function exactOccurrences(text, quote) {
  const matches = [];
  let cursor = 0;
  while (cursor <= text.length - quote.length) {
    const start = text.indexOf(quote, cursor);
    if (start < 0) break;
    matches.push({ start, end: start + quote.length });
    // Advance one code unit so overlapping repeated quotes are also detected;
    // otherwise a legacy anchor could be attached to an ambiguous location.
    cursor = start + 1;
  }
  return matches;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length ? value : "";
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
