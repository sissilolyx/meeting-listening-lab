export function reconcileTranscriptSentences(previousSentences = [], nextSentences = [], createSentenceId) {
  const allocateId = typeof createSentenceId === "function"
    ? createSentenceId
    : (() => `sentence-${crypto.randomUUID()}`);
  const exact = uniqueBy(previousSentences, sentenceKey);
  const used = new Set();

  return nextSentences.map((sentence) => {
    let previous = exact.get(sentenceKey(sentence));
    if (previous && used.has(previous.id)) previous = null;
    if (!previous) previous = findSameUtteranceAtStart(previousSentences, sentence, used);
    if (previous) used.add(previous.id);
    return previous
      ? {
          ...sentence,
          id: previous.id,
          analysis: previous.analysis || null,
          ...preservedPlaybackFields(previous, sentence),
        }
      : { ...sentence, id: allocateId(), analysis: null };
  });
}

function preservedPlaybackFields(previous, next) {
  const playbackStart = Number(previous?.playbackStart);
  const playbackEnd = Number(previous?.playbackEnd);
  if (!Number.isFinite(playbackStart) || !Number.isFinite(playbackEnd) || playbackEnd <= playbackStart) {
    return {};
  }
  if (!sameSourceBlock(previous, next)) return {};
  if (!isManualPlayback(previous) && !overlapsSentenceWindow(playbackStart, playbackEnd, next)) return {};
  return {
    playbackStart,
    playbackEnd,
    ...(previous.playbackTimingQuality ? { playbackTimingQuality: previous.playbackTimingQuality } : {}),
    ...(Number.isFinite(Number(previous.playbackAlignmentCoverage))
      ? { playbackAlignmentCoverage: Number(previous.playbackAlignmentCoverage) }
      : {}),
  };
}

function sameSourceBlock(previous, next) {
  const previousId = String(previous?.sourceBlockId || "").trim();
  const nextId = String(next?.sourceBlockId || "").trim();
  return previousId.length > 0 && previousId === nextId;
}

function isManualPlayback(sentence) {
  return normalizeText(sentence?.playbackTimingQuality) === "manual";
}

function overlapsSentenceWindow(playbackStart, playbackEnd, sentence) {
  const sentenceStart = Number(sentence?.start);
  const sentenceEnd = Number(sentence?.end);
  if (!Number.isFinite(sentenceStart) || !Number.isFinite(sentenceEnd) || sentenceEnd <= sentenceStart) {
    return false;
  }
  return Math.min(playbackEnd, sentenceEnd) > Math.max(playbackStart, sentenceStart);
}

export function reconcileTranscriptParagraphs(previousParagraphs = [], nextParagraphs = [], createParagraphId) {
  const allocateId = typeof createParagraphId === "function"
    ? createParagraphId
    : (() => `paragraph-${crypto.randomUUID()}`);
  const exact = uniqueBy(previousParagraphs, paragraphKey);
  const assignedPreviousIds = new Set();
  const assignments = new Map();

  nextParagraphs.forEach((paragraph, index) => {
    const previous = exact.get(paragraphKey(paragraph));
    if (!previous || assignedPreviousIds.has(previous.id)) return;
    assignments.set(index, previous);
    assignedPreviousIds.add(previous.id);
  });

  const candidates = [];
  nextParagraphs.forEach((paragraph, nextIndex) => {
    if (assignments.has(nextIndex)) return;
    previousParagraphs.forEach((previous) => {
      if (assignedPreviousIds.has(previous.id)) return;
      const score = paragraphSimilarity(previous, paragraph);
      // A tiny timestamp rounding overlap must not transfer a learner's saved
      // paragraph identity to an unrelated rebuilt paragraph.
      if (score >= 0.08) candidates.push({ nextIndex, previous, score });
    });
  });
  candidates.sort((left, right) => right.score - left.score);
  const assignedNextIndexes = new Set(assignments.keys());
  for (const candidate of candidates) {
    if (assignedNextIndexes.has(candidate.nextIndex) || assignedPreviousIds.has(candidate.previous.id)) continue;
    assignments.set(candidate.nextIndex, candidate.previous);
    assignedNextIndexes.add(candidate.nextIndex);
    assignedPreviousIds.add(candidate.previous.id);
  }

  return nextParagraphs.map((paragraph, index) => ({
    ...paragraph,
    id: assignments.get(index)?.id || allocateId(),
  }));
}

function findSameUtteranceAtStart(previousSentences, sentence, used) {
  const speaker = normalizeText(sentence.speaker);
  const text = comparableText(sentence.text);
  const start = Number(sentence.start);
  if (!text || !Number.isFinite(start)) return null;
  return (previousSentences || [])
    .filter((previous) => (
      !used.has(previous.id)
      && normalizeText(previous.speaker) === speaker
      && comparableText(previous.text) === text
      && Math.abs(Number(previous.start) - start) <= 0.35
    ))
    .sort((left, right) => Math.abs(Number(left.start) - start) - Math.abs(Number(right.start) - start))[0] || null;
}

function paragraphSimilarity(previous, next) {
  const previousIds = new Set(previous.sentenceIds || []);
  const nextIds = new Set(next.sentenceIds || []);
  const shared = [...previousIds].filter((id) => nextIds.has(id)).length;
  const sentenceScore = shared / Math.max(1, new Set([...previousIds, ...nextIds]).size);
  const previousStart = Number(previous.start);
  const previousEnd = Number(previous.end);
  const nextStart = Number(next.start);
  const nextEnd = Number(next.end);
  const overlap = Math.max(0, Math.min(previousEnd, nextEnd) - Math.max(previousStart, nextStart));
  const span = Math.max(previousEnd, nextEnd) - Math.min(previousStart, nextStart);
  const timeScore = Number.isFinite(overlap) && Number.isFinite(span) && span > 0 ? overlap / span : 0;
  const sameSpeaker = normalizeText(previous.speaker) === normalizeText(next.speaker) ? 1 : 0;
  return sameSpeaker * (sentenceScore * 0.7 + timeScore * 0.3);
}

function uniqueBy(items, keyFor) {
  const values = new Map();
  for (const item of items || []) {
    const key = keyFor(item);
    values.set(key, values.has(key) ? null : item);
  }
  return values;
}

function sentenceKey(sentence) {
  return `${normalizeText(sentence.speaker)}|${Number(sentence.start).toFixed(3)}|${normalizeText(sentence.text)}`;
}

function paragraphKey(paragraph) {
  return (paragraph.sentenceIds || []).join("|");
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function comparableText(value) {
  return normalizeText(value).replace(/[^a-z0-9'’-]+/g, " ").trim();
}
