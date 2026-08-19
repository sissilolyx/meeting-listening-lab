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
// Some Lark block timestamps end well before the recorded utterance. A second,
// deliberately strict fallback may look farther away, but only when the same
// lexical span is stable in both a 10-second and a 12-second search window.
const DEFAULT_EXTENDED_FALLBACK_STABILITY_WINDOW_PADDING_SECONDS = 10;
const DEFAULT_EXTENDED_FALLBACK_BLOCK_WINDOW_PADDING_SECONDS = 12;
const DEFAULT_EXTENDED_FALLBACK_MINIMUM_COVERAGE = 0.85;
const DEFAULT_EXTENDED_FALLBACK_MINIMUM_MATCHES = 6;
const DEFAULT_EXTENDED_FALLBACK_MAX_INTERSTITIAL_WORD_RATIO = 0.25;
const DEFAULT_EXTENDED_FALLBACK_MAX_BOUNDARY_DRIFT_SECONDS = 0.25;
const DEFAULT_EXTENDED_FALLBACK_MAX_COVERAGE_DRIFT = 0.05;
const DEFAULT_MAX_UNMATCHED_BOUNDARY_GAP_SECONDS = 0.65;
const DEFAULT_MAX_UNANCHORED_BOUNDARY_WORDS = 2;
const DEFAULT_SHORT_SENTENCE_MAXIMUM_WORD_COUNT = 8;
const DEFAULT_SHORT_SENTENCE_MINIMUM_COVERAGE = 0.8;
const DEFAULT_MAX_INTERSTITIAL_WORD_RATIO = 0.25;
// Keep only a very small shared boundary so neither sentence loses a clipped
// consonant, without making the listener replay a neighbouring whole sentence.
const DEFAULT_MAX_ADJACENT_OVERLAP_SECONDS = 0.12;
const DEFAULT_MAX_PADDING_ONLY_OVERLAP_SECONDS = 0.35;
const MINIMUM_DISTINCT_RANGE_SECONDS = 0.02;

/**
 * Attach independently aligned playback bounds to the official transcript.
 * The official sentence text and its display start/end values are intentionally
 * preserved: playbackStart/playbackEnd are only for original-audio playback.
 */
export function alignSentencePlaybackRanges(sentences, whisperPayload, options = {}) {
  const source = Array.isArray(sentences) ? sentences : [];
  const timedWords = extractWhisperTimedWords(whisperPayload);
  if (!source.length) {
    return { sentences: [], alignedCount: 0, clearedCount: 0, skippedCount: 0 };
  }
  if (!timedWords.length) {
    return forcedAlignmentMisses(source, options);
  }

  const groups = groupSentencesBySourceBlock(source);
  const alignments = new Map();
  const extendedCandidateIds = new Set();
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

    const extendedWindow = positiveNumber(
      options.extendedFallbackBlockWindowPaddingSeconds,
      DEFAULT_EXTENDED_FALLBACK_BLOCK_WINDOW_PADDING_SECONDS,
    );
    const stabilityWindow = positiveNumber(
      options.extendedFallbackStabilityWindowPaddingSeconds,
      DEFAULT_EXTENDED_FALLBACK_STABILITY_WINDOW_PADDING_SECONDS,
    );
    if (
      groupAlignments.size < group.length
      && fallbackWindow > primaryWindow
      && extendedWindow > fallbackWindow
      && stabilityWindow > fallbackWindow
      && stabilityWindow < extendedWindow
    ) {
      const extendedMinimumCoverage = positiveNumber(
        options.extendedFallbackMinimumCoverage,
        DEFAULT_EXTENDED_FALLBACK_MINIMUM_COVERAGE,
      );
      const extendedMinimumMatches = positiveNumber(
        options.extendedFallbackMinimumMatches,
        DEFAULT_EXTENDED_FALLBACK_MINIMUM_MATCHES,
      );
      const extendedMatchOptions = {
        ...options,
        minimumCoverage: extendedMinimumCoverage,
        shortSentenceMinimumCoverage: extendedMinimumCoverage,
        minimumMatches: extendedMinimumMatches,
        maxInterstitialWordRatio: positiveNumber(
          options.extendedFallbackMaxInterstitialWordRatio,
          DEFAULT_EXTENDED_FALLBACK_MAX_INTERSTITIAL_WORD_RATIO,
          true,
        ),
      };
      const stabilityAlignments = new Map(alignSourceBlock(group, timedWords, {
        ...extendedMatchOptions,
        blockWindowPaddingSeconds: stabilityWindow,
      }).map((alignment) => [alignment.sentenceId, alignment]));
      const extendedAlignments = alignSourceBlock(group, timedWords, {
        ...extendedMatchOptions,
        blockWindowPaddingSeconds: extendedWindow,
      });
      for (const alignment of extendedAlignments) {
        const sentence = group.find((item) => item.id === alignment.sentenceId);
        const stableAlignment = stabilityAlignments.get(alignment.sentenceId);
        if (
          !groupAlignments.has(alignment.sentenceId)
          && sentenceWords(sentence?.text).length >= extendedMinimumMatches
          && alignment.matchedWordCount >= extendedMinimumMatches
          && extendedAlignmentIsStable(stableAlignment, alignment, options)
        ) {
          groupAlignments.set(alignment.sentenceId, alignment);
          extendedCandidateIds.add(alignment.sentenceId);
        }
      }
    }

    const constrained = constrainAdjacentPlaybackRanges(group, [...groupAlignments.values()], options);
    for (const alignment of constrained) {
      alignments.set(alignment.sentenceId, alignment);
    }
  }

  const safeExtendedAlignments = resolveExtendedFallbackConflicts(
    source,
    alignments,
    extendedCandidateIds,
    options,
  );
  for (const sentenceId of extendedCandidateIds) {
    const safeAlignment = safeExtendedAlignments.get(sentenceId);
    if (safeAlignment) alignments.set(sentenceId, safeAlignment);
    else alignments.delete(sentenceId);
  }

  let alignedCount = 0;
  let clearedCount = 0;
  let skippedCount = 0;
  const force = Boolean(options.force);
  const nextSentences = source.map((sentence) => {
    if (force && isManualPlayback(sentence)) return { ...sentence };
    if (!force && hasPlaybackBounds(sentence)) return { ...sentence };
    if (!force && sentence.timingQuality !== "estimated") return { ...sentence };
    const alignment = alignments.get(sentence.id);
    if (!alignment) {
      const next = force ? withoutPlaybackBounds(sentence) : { ...sentence };
      if (force && hasAnyPlaybackFields(sentence)) clearedCount += 1;
      else skippedCount += 1;
      return next;
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

  return { sentences: nextSentences, alignedCount, clearedCount, skippedCount };
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
      spokenIndex: match.spokenIndex,
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
    const effectiveMinimumCoverage = expectedWords.length <= positiveNumber(
      options.shortSentenceMaximumWordCount,
      DEFAULT_SHORT_SENTENCE_MAXIMUM_WORD_COUNT,
    )
      ? Math.max(
          minimumCoverage,
          positiveNumber(
            options.shortSentenceMinimumCoverage,
            DEFAULT_SHORT_SENTENCE_MINIMUM_COVERAGE,
          ),
        )
      : minimumCoverage;
    const minimumMatches = Math.min(
      positiveNumber(options.minimumMatches, 3),
      expectedWords.length,
    );
    if (coverage < effectiveMinimumCoverage || sentenceMatches.length < minimumMatches) continue;
    if (!isCompactMatch(expectedWords, sentenceMatches, options)) continue;

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
      spokenStart = recoverLeadingBoundary({
        localWords,
        first,
        missingWords: leadingMisses,
        previousMatch,
        groupFloor: groupStart - windowPadding,
        maximumGap: positiveNumber(
          options.maxUnmatchedBoundaryGapSeconds,
          DEFAULT_MAX_UNMATCHED_BOUNDARY_GAP_SECONDS,
          true,
        ),
        maximumUnanchoredWords: positiveNumber(
          options.maxUnanchoredBoundaryWords,
          DEFAULT_MAX_UNANCHORED_BOUNDARY_WORDS,
        ),
      });
    }
    if (trailingMisses > 0) {
      const nextMatch = matchesBySentence.get(sentenceIndex + 1)?.[0];
      spokenEnd = recoverTrailingBoundary({
        localWords,
        last,
        missingWords: trailingMisses,
        nextMatch,
        groupCeiling: groupEnd + windowPadding,
        maximumGap: positiveNumber(
          options.maxUnmatchedBoundaryGapSeconds,
          DEFAULT_MAX_UNMATCHED_BOUNDARY_GAP_SECONDS,
          true,
        ),
        maximumUnanchoredWords: positiveNumber(
          options.maxUnanchoredBoundaryWords,
          DEFAULT_MAX_UNANCHORED_BOUNDARY_WORDS,
        ),
      });
    }

    const playbackStart = Math.max(0, spokenStart - leadPadding);
    const playbackEnd = Math.max(playbackStart + 0.2, spokenEnd + tailPadding);
    results.push({
      sentenceId: sentence.id,
      playbackStart: roundTime(playbackStart),
      playbackEnd: roundTime(playbackEnd),
      coverage: roundTime(coverage),
      matchedWordCount: sentenceMatches.length,
      contentStart: roundTime(spokenStart),
      contentEnd: roundTime(spokenEnd),
    });
  }
  return constrainAdjacentPlaybackRanges(sentences, results, options);
}

function recoverLeadingBoundary({
  localWords,
  first,
  missingWords,
  previousMatch,
  groupFloor,
  maximumGap,
  maximumUnanchoredWords,
}) {
  let cursor = first.spokenIndex;
  let start = first.spokenWord.start;
  const lowerBound = previousMatch ? previousMatch.spokenIndex + 1 : 0;
  const recoveryLimit = previousMatch
    ? missingWords
    : Math.min(missingWords, maximumUnanchoredWords);
  let recovered = 0;
  while (cursor > lowerBound && recovered < recoveryLimit) {
    const candidate = localWords[cursor - 1];
    const current = localWords[cursor];
    if (!candidate || current.start - candidate.end > maximumGap) break;
    cursor -= 1;
    start = candidate.start;
    recovered += 1;
  }
  if (recovered > 0) return start;
  return previousMatch?.spokenWord.end ?? Math.max(groupFloor, start);
}

function recoverTrailingBoundary({
  localWords,
  last,
  missingWords,
  nextMatch,
  groupCeiling,
  maximumGap,
  maximumUnanchoredWords,
}) {
  let cursor = last.spokenIndex;
  let end = last.spokenWord.end;
  const upperBound = nextMatch ? nextMatch.spokenIndex : localWords.length;
  const recoveryLimit = nextMatch
    ? missingWords
    : Math.min(missingWords, maximumUnanchoredWords);
  let recovered = 0;
  while (cursor + 1 < upperBound && recovered < recoveryLimit) {
    const current = localWords[cursor];
    const candidate = localWords[cursor + 1];
    if (!candidate || candidate.start - current.end > maximumGap) break;
    cursor += 1;
    end = candidate.end;
    recovered += 1;
  }
  if (recovered > 0) return end;
  return nextMatch?.spokenWord.start ?? Math.min(groupCeiling, end);
}

function extendedAlignmentIsStable(stabilityAlignment, extendedAlignment, options) {
  if (!stabilityAlignment || !extendedAlignment) return false;
  const maximumBoundaryDrift = positiveNumber(
    options.extendedFallbackMaxBoundaryDriftSeconds,
    DEFAULT_EXTENDED_FALLBACK_MAX_BOUNDARY_DRIFT_SECONDS,
    true,
  );
  const maximumCoverageDrift = positiveNumber(
    options.extendedFallbackMaxCoverageDrift,
    DEFAULT_EXTENDED_FALLBACK_MAX_COVERAGE_DRIFT,
    true,
  );
  return Math.abs(stabilityAlignment.contentStart - extendedAlignment.contentStart) <= maximumBoundaryDrift
    && Math.abs(stabilityAlignment.contentEnd - extendedAlignment.contentEnd) <= maximumBoundaryDrift
    && Math.abs(stabilityAlignment.coverage - extendedAlignment.coverage) <= maximumCoverageDrift;
}

function resolveExtendedFallbackConflicts(sentences, alignments, extendedCandidateIds, options) {
  const candidateIds = [...extendedCandidateIds];
  if (!candidateIds.length) return new Map();

  const indexBySentenceId = new Map(sentences.map((sentence, index) => [sentence.id, index]));
  const maximumOverlap = positiveNumber(
    options.maxAdjacentOverlapSeconds,
    DEFAULT_MAX_ADJACENT_OVERLAP_SECONDS,
    true,
  );
  const maximumPaddingOnlyOverlap = positiveNumber(
    options.maxPaddingOnlyOverlapSeconds,
    DEFAULT_MAX_PADDING_ONLY_OVERLAP_SECONDS,
    true,
  );
  const anchorsBySentenceId = new Map();

  for (const [index, sentence] of sentences.entries()) {
    const range = reliableSentenceRange(sentence);
    if (range) anchorsBySentenceId.set(sentence.id, { ...range, sentenceIndex: index });
  }
  for (const [sentenceId, alignment] of alignments.entries()) {
    if (extendedCandidateIds.has(sentenceId) || anchorsBySentenceId.has(sentenceId)) continue;
    anchorsBySentenceId.set(sentenceId, {
      ...alignmentRange(alignment),
      sentenceIndex: indexBySentenceId.get(sentenceId),
    });
  }

  const anchors = [...anchorsBySentenceId.entries()].map(([sentenceId, range]) => ({ sentenceId, ...range }));
  const candidates = candidateIds
    .map((sentenceId) => {
      const alignment = alignments.get(sentenceId);
      const sentenceIndex = indexBySentenceId.get(sentenceId);
      if (!alignment || !Number.isInteger(sentenceIndex)) return null;
      return { sentenceId, sentenceIndex, ...alignmentRange(alignment), coverage: alignment.coverage, matchedWordCount: alignment.matchedWordCount };
    })
    .filter(Boolean)
    .sort((left, right) => left.sentenceIndex - right.sentenceIndex);

  const rejected = new Set();
  for (const candidate of candidates) {
    const previousAnchor = nearestAnchor(anchors, candidate.sentenceIndex, -1);
    const nextAnchor = nearestAnchor(anchors, candidate.sentenceIndex, 1);
    if (
      (previousAnchor && candidate.playbackEnd < previousAnchor.playbackStart - maximumOverlap)
      || (nextAnchor && candidate.playbackStart > nextAnchor.playbackEnd + maximumOverlap)
    ) {
      rejected.add(candidate.sentenceId);
      continue;
    }

    for (const anchor of anchors) {
      if (anchor.sentenceId === candidate.sentenceId) continue;
      if (!trimPaddingOverlap(candidate, anchor, {
        maximumOverlap,
        maximumPaddingOnlyOverlap,
      })) {
        rejected.add(candidate.sentenceId);
        break;
      }
    }
  }

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex];
    if (rejected.has(left.sentenceId)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex];
      if (rejected.has(right.sentenceId)) continue;
      if (!resolveCandidatePair(left, right, { maximumOverlap, maximumPaddingOnlyOverlap })) {
        // A substantive overlap means the same audio could satisfy two official
        // sentences. Reject both rather than guessing which transcript is real.
        rejected.add(left.sentenceId);
        rejected.add(right.sentenceId);
        break;
      }
    }
  }

  const safe = new Map();
  for (const candidate of candidates) {
    if (rejected.has(candidate.sentenceId)) continue;
    safe.set(candidate.sentenceId, {
      ...alignments.get(candidate.sentenceId),
      playbackStart: roundTime(candidate.playbackStart),
      playbackEnd: roundTime(candidate.playbackEnd),
    });
  }
  return safe;
}

function reliableSentenceRange(sentence) {
  if (hasPlaybackBounds(sentence)) {
    return {
      playbackStart: Number(sentence.playbackStart),
      playbackEnd: Number(sentence.playbackEnd),
      contentStart: Number(sentence.playbackStart),
      contentEnd: Number(sentence.playbackEnd),
    };
  }
  return null;
}

function alignmentRange(alignment) {
  return {
    playbackStart: Number(alignment.playbackStart),
    playbackEnd: Number(alignment.playbackEnd),
    contentStart: Number(alignment.contentStart ?? alignment.playbackStart),
    contentEnd: Number(alignment.contentEnd ?? alignment.playbackEnd),
  };
}

function nearestAnchor(anchors, sentenceIndex, direction) {
  const eligible = anchors.filter((anchor) => direction < 0
    ? anchor.sentenceIndex < sentenceIndex
    : anchor.sentenceIndex > sentenceIndex);
  eligible.sort((left, right) => direction < 0
    ? right.sentenceIndex - left.sentenceIndex
    : left.sentenceIndex - right.sentenceIndex);
  return eligible[0] || null;
}

function trimPaddingOverlap(candidate, anchor, { maximumOverlap, maximumPaddingOnlyOverlap }) {
  const overlap = rangeOverlap(candidate, anchor);
  if (overlap <= maximumOverlap) return true;
  if (overlap > maximumPaddingOnlyOverlap) return false;

  if (candidate.sentenceIndex > anchor.sentenceIndex) {
    const trimmedStart = anchor.playbackEnd - maximumOverlap;
    if (trimmedStart > candidate.contentStart) return false;
    candidate.playbackStart = Math.max(candidate.playbackStart, trimmedStart);
  } else {
    const trimmedEnd = anchor.playbackStart + maximumOverlap;
    if (trimmedEnd < candidate.contentEnd) return false;
    candidate.playbackEnd = Math.min(candidate.playbackEnd, trimmedEnd);
  }
  return candidate.playbackEnd - candidate.playbackStart >= MINIMUM_DISTINCT_RANGE_SECONDS;
}

function resolveCandidatePair(left, right, { maximumOverlap, maximumPaddingOnlyOverlap }) {
  if (left.contentStart > right.contentStart || left.contentEnd > right.contentEnd) return false;
  if (Math.min(left.contentEnd, right.contentEnd) - Math.max(left.contentStart, right.contentStart) > 0) return false;

  const overlap = rangeOverlap(left, right);
  if (overlap <= maximumOverlap) return true;
  if (overlap > maximumPaddingOnlyOverlap) return false;

  const midpoint = (left.contentEnd + right.contentStart) / 2;
  const halfOverlap = maximumOverlap / 2;
  const trimmedLeftEnd = Math.min(left.playbackEnd, midpoint + halfOverlap);
  const trimmedRightStart = Math.max(right.playbackStart, midpoint - halfOverlap);
  if (trimmedLeftEnd < left.contentEnd || trimmedRightStart > right.contentStart) return false;
  left.playbackEnd = trimmedLeftEnd;
  right.playbackStart = trimmedRightStart;
  return true;
}

function rangeOverlap(left, right) {
  return Math.max(0, Math.min(left.playbackEnd, right.playbackEnd) - Math.max(left.playbackStart, right.playbackStart));
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

function isCompactMatch(expectedWords, matches, options) {
  const first = matches[0];
  const last = matches.at(-1);
  if (!first || !last) return false;
  const spokenSpan = last.spokenIndex - first.spokenIndex + 1;
  const interstitialWords = Math.max(0, spokenSpan - matches.length);
  const maximumInterstitialWords = Math.max(
    1,
    Math.ceil(expectedWords.length * positiveNumber(
      options.maxInterstitialWordRatio,
      DEFAULT_MAX_INTERSTITIAL_WORD_RATIO,
      true,
    )),
  );
  return interstitialWords <= maximumInterstitialWords;
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
  return Number.isFinite(Number(sentence?.playbackStart))
    && Number.isFinite(Number(sentence?.playbackEnd))
    && Number(sentence.playbackEnd) > Number(sentence.playbackStart);
}

function hasAnyPlaybackFields(sentence) {
  return [
    "playbackStart",
    "playbackEnd",
    "playbackTimingQuality",
    "playbackAlignmentCoverage",
  ].some((field) => Object.hasOwn(sentence || {}, field));
}

function isManualPlayback(sentence) {
  return String(sentence?.playbackTimingQuality || "").trim().toLowerCase() === "manual";
}

function withoutPlaybackBounds(sentence) {
  const next = { ...sentence };
  delete next.playbackStart;
  delete next.playbackEnd;
  delete next.playbackTimingQuality;
  delete next.playbackAlignmentCoverage;
  return next;
}

function forcedAlignmentMisses(source, options) {
  if (!options.force) {
    return {
      sentences: source.map((sentence) => ({ ...sentence })),
      alignedCount: 0,
      clearedCount: 0,
      skippedCount: source.length,
    };
  }
  let clearedCount = 0;
  let skippedCount = 0;
  const sentences = source.map((sentence) => {
    if (isManualPlayback(sentence)) return { ...sentence };
    if (hasAnyPlaybackFields(sentence)) clearedCount += 1;
    else skippedCount += 1;
    return withoutPlaybackBounds(sentence);
  });
  return {
    sentences,
    alignedCount: 0,
    clearedCount,
    skippedCount,
  };
}

function positiveNumber(value, fallback, allowZero = false) {
  const number = Number(value);
  if (Number.isFinite(number) && (allowZero ? number >= 0 : number > 0)) return number;
  return fallback;
}

function roundTime(value) {
  return Math.round(value * 1000) / 1000;
}
