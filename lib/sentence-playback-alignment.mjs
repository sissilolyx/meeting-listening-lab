const wordPattern = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;
const whisperControlTokenPattern = /^\s*\[\s*_[A-Z0-9_]+\s*\]\s*$/i;

const DEFAULT_LEAD_PADDING_SECONDS = 0.15;
const DEFAULT_TAIL_PADDING_SECONDS = 0.2;
const DEFAULT_BLOCK_WINDOW_PADDING_SECONDS = 1.5;
const DEFAULT_MINIMUM_COVERAGE = 0.5;
// Lark speaker-block boundaries can occasionally land several seconds before
// the speaker actually finishes. Keep the normal search tight, then retry
// only sentences that were not aligned with a wider, stricter window.
const DEFAULT_FALLBACK_BLOCK_WINDOW_PADDING_SECONDS = 6;
const DEFAULT_FALLBACK_MINIMUM_COVERAGE = 0.8;
const DEFAULT_FALLBACK_MINIMUM_WORD_COUNT = 6;
// Keep only a very small shared boundary so neither sentence loses a clipped
// consonant, without making the listener replay a neighbouring whole sentence.
const DEFAULT_MAX_ADJACENT_OVERLAP_SECONDS = 0.12;
const MINIMUM_DISTINCT_RANGE_SECONDS = 0.02;

/**
 * Attach independently aligned playback bounds to the official transcript.
 * The official sentence text and its display start/end values are intentionally
 * preserved: playbackStart/playbackEnd are only for original-audio playback.
 */
export function alignSentencePlaybackRanges(sentences, whisperPayload, options = {}) {
  const source = Array.isArray(sentences) ? sentences : [];
  const timedWords = extractWhisperTimedWords(whisperPayload);
  if (!source.length || !timedWords.length) {
    return { sentences: source.map((sentence) => ({ ...sentence })), alignedCount: 0, skippedCount: source.length };
  }

  const groups = groupSentencesBySourceBlock(source);
  const alignments = new Map();
  for (const group of groups) {
    const primary = alignSourceBlock(group, timedWords, options);
    const groupAlignments = new Map(primary.map((alignment) => [alignment.sentenceId, alignment]));
    const primaryWindow = positiveNumber(
      options.blockWindowPaddingSeconds,
      DEFAULT_BLOCK_WINDOW_PADDING_SECONDS,
    );
    const fallbackWindow = positiveNumber(
      options.fallbackBlockWindowPaddingSeconds,
      DEFAULT_FALLBACK_BLOCK_WINDOW_PADDING_SECONDS,
    );
    if (groupAlignments.size < group.length && fallbackWindow > primaryWindow) {
      const fallbackMinimumWordCount = positiveNumber(
        options.fallbackMinimumWordCount,
        DEFAULT_FALLBACK_MINIMUM_WORD_COUNT,
      );
      const fallback = alignSourceBlock(group, timedWords, {
        ...options,
        blockWindowPaddingSeconds: fallbackWindow,
        minimumCoverage: positiveNumber(
          options.fallbackMinimumCoverage,
          DEFAULT_FALLBACK_MINIMUM_COVERAGE,
        ),
      });
      for (const alignment of fallback) {
        const sentence = group.find((item) => item.id === alignment.sentenceId);
        if (
          !groupAlignments.has(alignment.sentenceId)
          && sentenceWords(sentence?.text).length >= fallbackMinimumWordCount
        ) {
          groupAlignments.set(alignment.sentenceId, alignment);
        }
      }
    }

    const constrained = constrainAdjacentPlaybackRanges(group, [...groupAlignments.values()], options);
    for (const alignment of constrained) {
      alignments.set(alignment.sentenceId, alignment);
    }
  }

  let alignedCount = 0;
  let skippedCount = 0;
  const force = Boolean(options.force);
  const nextSentences = source.map((sentence) => {
    if (!force && hasPlaybackBounds(sentence)) return { ...sentence };
    if (!force && sentence.timingQuality !== "estimated") return { ...sentence };
    const alignment = alignments.get(sentence.id);
    if (!alignment) {
      skippedCount += 1;
      return { ...sentence };
    }
    alignedCount += 1;
    return {
      ...sentence,
      playbackStart: alignment.playbackStart,
      playbackEnd: alignment.playbackEnd,
      playbackTimingQuality: "whisper-aligned",
      playbackAlignmentCoverage: alignment.coverage,
    };
  });

  return { sentences: nextSentences, alignedCount, skippedCount };
}

export function extractWhisperTimedWords(payload) {
  const words = [];
  for (const entry of payload?.transcription || payload?.segments || []) {
    const tokenRanges = [];
    let combined = "";
    for (const token of entry?.tokens || []) {
      const text = String(token?.text || "");
      if (!text || whisperControlTokenPattern.test(text)) continue;
      const start = whisperTime(token, "from", "start");
      const end = whisperTime(token, "to", "end");
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      const charStart = combined.length;
      combined += text;
      tokenRanges.push({ charStart, charEnd: combined.length, start, end });
    }

    for (const match of combined.matchAll(wordPattern)) {
      const charStart = match.index;
      const charEnd = charStart + match[0].length;
      const overlaps = tokenRanges.filter((token) => token.charEnd > charStart && token.charStart < charEnd);
      if (!overlaps.length) continue;
      words.push({
        text: match[0],
        normalized: normalizeWord(match[0]),
        start: overlaps[0].start,
        end: overlaps.at(-1).end,
      });
    }
  }
  return words
    .filter((word) => word.normalized)
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function alignSourceBlock(sentences, timedWords, options) {
  const officialWords = [];
  for (const [sentenceIndex, sentence] of sentences.entries()) {
    for (const [wordIndex, word] of sentenceWords(sentence.text).entries()) {
      officialWords.push({ normalized: word, sentenceIndex, wordIndex });
    }
  }
  if (!officialWords.length) return [];

  const groupStart = Math.min(...sentences.map((sentence) => Number(sentence.start) || 0));
  const groupEnd = Math.max(...sentences.map((sentence) => Number(sentence.end) || groupStart));
  const windowPadding = positiveNumber(options.blockWindowPaddingSeconds, DEFAULT_BLOCK_WINDOW_PADDING_SECONDS);
  const localWords = timedWords.filter((word) => (
    word.end >= groupStart - windowPadding && word.start <= groupEnd + windowPadding
  ));
  if (!localWords.length) return [];

  const matches = longestCommonWordMatches(officialWords, localWords);
  const matchesBySentence = new Map();
  for (const match of matches) {
    const sentenceIndex = officialWords[match.officialIndex].sentenceIndex;
    const list = matchesBySentence.get(sentenceIndex) || [];
    list.push({
      officialWord: officialWords[match.officialIndex],
      spokenWord: localWords[match.spokenIndex],
    });
    matchesBySentence.set(sentenceIndex, list);
  }

  const minimumCoverage = positiveNumber(options.minimumCoverage, DEFAULT_MINIMUM_COVERAGE);
  const leadPadding = positiveNumber(options.leadPaddingSeconds, DEFAULT_LEAD_PADDING_SECONDS, true);
  const tailPadding = positiveNumber(options.tailPaddingSeconds, DEFAULT_TAIL_PADDING_SECONDS, true);
  const results = [];

  for (const [sentenceIndex, sentence] of sentences.entries()) {
    const expectedWords = sentenceWords(sentence.text);
    const sentenceMatches = matchesBySentence.get(sentenceIndex) || [];
    const coverage = expectedWords.length ? sentenceMatches.length / expectedWords.length : 0;
    const minimumMatches = Math.min(3, expectedWords.length);
    if (coverage < minimumCoverage || sentenceMatches.length < minimumMatches) continue;

    const first = sentenceMatches[0];
    const last = sentenceMatches.at(-1);
    const maximumBoundaryMiss = Math.max(2, Math.ceil(expectedWords.length * 0.25));
    const leadingMisses = first.officialWord.wordIndex;
    const trailingMisses = expectedWords.length - 1 - last.officialWord.wordIndex;
    if (leadingMisses > maximumBoundaryMiss || trailingMisses > maximumBoundaryMiss) continue;

    let spokenStart = first.spokenWord.start;
    let spokenEnd = last.spokenWord.end;
    if (leadingMisses > 0) {
      const previousMatch = matchesBySentence.get(sentenceIndex - 1)?.at(-1);
      spokenStart = previousMatch?.spokenWord.end ?? Math.max(groupStart - windowPadding, spokenStart);
    }
    if (trailingMisses > 0) {
      const nextMatch = matchesBySentence.get(sentenceIndex + 1)?.[0];
      spokenEnd = nextMatch?.spokenWord.start ?? Math.min(groupEnd + windowPadding, spokenEnd);
    }

    const playbackStart = Math.max(0, spokenStart - leadPadding);
    const playbackEnd = Math.max(playbackStart + 0.2, spokenEnd + tailPadding);
    results.push({
      sentenceId: sentence.id,
      playbackStart: roundTime(playbackStart),
      playbackEnd: roundTime(playbackEnd),
      coverage: roundTime(coverage),
    });
  }
  return constrainAdjacentPlaybackRanges(sentences, results, options);
}

function constrainAdjacentPlaybackRanges(sentences, alignments, options) {
  if (alignments.length < 2) return alignments;
  const bySentenceId = new Map(alignments.map((alignment) => [alignment.sentenceId, alignment]));
  const maximumOverlap = positiveNumber(
    options.maxAdjacentOverlapSeconds,
    DEFAULT_MAX_ADJACENT_OVERLAP_SECONDS,
    true,
  );

  for (let index = 0; index < sentences.length - 1; index += 1) {
    const left = bySentenceId.get(sentences[index].id);
    const right = bySentenceId.get(sentences[index + 1].id);
    if (!left || !right) continue;

    const overlap = left.playbackEnd - right.playbackStart;
    const leftDuration = left.playbackEnd - left.playbackStart;
    const rightDuration = right.playbackEnd - right.playbackStart;
    const containsAdjacent = rangeContains(left, right) || rangeContains(right, left);
    if (overlap <= maximumOverlap && !containsAdjacent) continue;

    // Shrink only the shared boundary. Outer bounds remain untouched, so this
    // cannot pull unrelated audio in from either side of the source block.
    const shortestDuration = Math.min(leftDuration, rightDuration);
    const targetOverlap = Math.max(0, Math.min(
      maximumOverlap,
      shortestDuration - MINIMUM_DISTINCT_RANGE_SECONDS,
    ));
    const originalBoundaryMidpoint = (left.playbackEnd + right.playbackStart) / 2;
    const halfOverlap = targetOverlap / 2;
    const minimumLeftEnd = left.playbackStart + Math.min(MINIMUM_DISTINCT_RANGE_SECONDS, leftDuration);
    const maximumRightStart = right.playbackEnd - Math.min(MINIMUM_DISTINCT_RANGE_SECONDS, rightDuration);
    const minimumMidpoint = Math.max(minimumLeftEnd - halfOverlap, right.playbackStart + halfOverlap);
    const maximumMidpoint = Math.min(left.playbackEnd - halfOverlap, maximumRightStart + halfOverlap);
    if (minimumMidpoint > maximumMidpoint) continue;

    const midpoint = Math.max(minimumMidpoint, Math.min(originalBoundaryMidpoint, maximumMidpoint));
    left.playbackEnd = roundTime(midpoint + halfOverlap);
    right.playbackStart = roundTime(midpoint - halfOverlap);
  }
  return alignments;
}

function rangeContains(container, candidate) {
  return container.playbackStart <= candidate.playbackStart
    && container.playbackEnd >= candidate.playbackEnd;
}

function longestCommonWordMatches(officialWords, spokenWords) {
  const rowCount = officialWords.length + 1;
  const columnCount = spokenWords.length + 1;
  const table = Array.from({ length: rowCount }, () => new Uint16Array(columnCount));
  for (let officialIndex = officialWords.length - 1; officialIndex >= 0; officialIndex -= 1) {
    for (let spokenIndex = spokenWords.length - 1; spokenIndex >= 0; spokenIndex -= 1) {
      table[officialIndex][spokenIndex] = officialWords[officialIndex].normalized === spokenWords[spokenIndex].normalized
        ? table[officialIndex + 1][spokenIndex + 1] + 1
        : Math.max(table[officialIndex + 1][spokenIndex], table[officialIndex][spokenIndex + 1]);
    }
  }

  const matches = [];
  let officialIndex = 0;
  let spokenIndex = 0;
  while (officialIndex < officialWords.length && spokenIndex < spokenWords.length) {
    if (
      officialWords[officialIndex].normalized === spokenWords[spokenIndex].normalized
      && table[officialIndex][spokenIndex] === table[officialIndex + 1][spokenIndex + 1] + 1
    ) {
      matches.push({ officialIndex, spokenIndex });
      officialIndex += 1;
      spokenIndex += 1;
    } else if (table[officialIndex + 1][spokenIndex] >= table[officialIndex][spokenIndex + 1]) {
      officialIndex += 1;
    } else {
      spokenIndex += 1;
    }
  }
  return matches;
}

function groupSentencesBySourceBlock(sentences) {
  const groups = new Map();
  for (const sentence of sentences) {
    const key = String(sentence.sourceBlockId || sentence.id || "");
    const group = groups.get(key) || [];
    group.push(sentence);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function sentenceWords(value) {
  return [...String(value || "").matchAll(wordPattern)].map((match) => normalizeWord(match[0])).filter(Boolean);
}

function normalizeWord(value) {
  return String(value || "").toLowerCase().replace(/’/g, "'").trim();
}

function whisperTime(entry, direction, fallbackKey) {
  const offset = Number(entry?.offsets?.[direction]);
  if (Number.isFinite(offset)) return offset / 1000;
  const timestamp = entry?.timestamps?.[direction];
  if (typeof timestamp === "string") {
    const match = timestamp.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
    if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
  }
  const fallback = Number(entry?.[fallbackKey]);
  return Number.isFinite(fallback) ? fallback : NaN;
}

function hasPlaybackBounds(sentence) {
  return Number.isFinite(Number(sentence?.playbackStart)) && Number.isFinite(Number(sentence?.playbackEnd));
}

function positiveNumber(value, fallback, allowZero = false) {
  const number = Number(value);
  if (Number.isFinite(number) && (allowZero ? number >= 0 : number > 0)) return number;
  return fallback;
}

function roundTime(value) {
  return Math.round(value * 1000) / 1000;
}
