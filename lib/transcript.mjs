const timestampPattern = /^(.+?)\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*$/;
const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const whisperTimestampArtifactPattern = /\[?\s*_+\s*TT\s*_+\s*\d+\s*\]?/gi;
const whisperControlArtifactPattern = /\[\s*_[A-Z][A-Z0-9_]*_\s*\]/g;
// Start with the high-confidence boundary error verified against the original
// recording. Other subordinators occur in abandoned meeting fragments often
// enough that they need a richer clause parser before they are safe to merge.
const dependentClauseStartPattern = /^(?:(?:and|but)\s+)?once\s+(?:I|we|you|he|she|it|they|there|this|that|these|those|the|a|an|my|our|your|their|its)\b/i;
const independentClauseStartPattern = /^(?:I|we|you|he|she|it|they|there|this|that|these|those|the|a|an|my|our|your|their|its)\b/i;
const lowercaseContinuationWords = new Map([
  ["We", "we"], ["You", "you"], ["He", "he"], ["She", "she"], ["It", "it"], ["They", "they"],
  ["There", "there"], ["This", "this"], ["That", "that"], ["These", "these"], ["Those", "those"],
  ["The", "the"], ["A", "a"], ["An", "an"], ["My", "my"], ["Our", "our"], ["Your", "your"],
  ["Their", "their"], ["Its", "its"],
]);
const standaloneAcknowledgementPattern = /^(?:ok|okay)[.!]*$/i;
const MAX_ACKNOWLEDGEMENT_DURATION_SECONDS = 2.5;
const MAX_ACKNOWLEDGEMENT_PREVIOUS_GAP_SECONDS = 1.25;
const MAX_ACKNOWLEDGEMENT_NEXT_GAP_SECONDS = 0.35;
const MIN_ACKNOWLEDGEMENT_OVERLAP_SECONDS = -0.1;

function removeWhisperInternalArtifacts(value) {
  return String(value || "")
    .replace(whisperTimestampArtifactPattern, " ")
    .replace(whisperControlArtifactPattern, " ");
}

export function stripTranscriptArtifacts(value) {
  return removeWhisperInternalArtifacts(value)
    .replace(/\[\s*\]/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function timestampToSeconds(hours, minutes, seconds, milliseconds) {
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(milliseconds) / 1000;
}

export function countWords(text) {
  return (String(text).match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
}

export function parseLarkTranscript(text, durationSeconds = null) {
  const blocks = [];
  let current = null;

  for (const rawLine of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    const match = line.match(timestampPattern);
    if (match) {
      if (current?.lines.length) blocks.push(current);
      current = {
        id: `block-${blocks.length + 1}`,
        speaker: match[1].trim(),
        start: timestampToSeconds(match[2], match[3], match[4], match[5]),
        lines: [],
      };
    } else if (line && current) {
      const cleaned = stripTranscriptArtifacts(line);
      if (cleaned) current.lines.push(cleaned);
    }
  }
  if (current?.lines.length) blocks.push(current);

  return blocks.map((block, index) => ({
    id: block.id,
    speaker: block.speaker,
    start: block.start,
    end: blocks[index + 1]?.start ?? durationSeconds ?? block.start + Math.max(4, countWords(block.lines.join(" ")) / 2.5),
    text: block.lines.join(" ").replace(/\s+/g, " ").trim(),
  }));
}

export function blocksToSentences(blocks) {
  const sentences = [];

  for (const block of blocks) {
    const cleanedBlockText = stripTranscriptArtifacts(block.text);
    if (!cleanedBlockText) continue;
    const parts = [...sentenceSegmenter.segment(cleanedBlockText)]
      .map(({ segment }) => segment.trim())
      .filter(Boolean);
    const segmentedParts = parts.length ? parts : [cleanedBlockText];
    const safeParts = mergeDependentSentenceFragments(segmentedParts);
    const weights = safeParts.map((part) => Math.max(1, countWords(part)));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const duration = Math.max(0.25, block.end - block.start);
    let consumed = 0;

    safeParts.forEach((part, index) => {
      const start = block.start + duration * (consumed / totalWeight);
      consumed += weights[index];
      const end = block.start + duration * (consumed / totalWeight);
      sentences.push({
        id: `sentence-${sentences.length + 1}`,
        sourceBlockId: block.id,
        speaker: block.speaker || "Speaker",
        start: roundTime(start),
        end: roundTime(Math.max(start + 0.2, end)),
        text: part,
        wordCount: countWords(part),
        timingQuality: safeParts.length === 1 ? "source" : "estimated",
        analysis: null,
      });
    });
  }

  return sentences;
}

export function mergeDependentSentenceFragments(parts) {
  const merged = [];
  for (let index = 0; index < parts.length; index += 1) {
    const current = String(parts[index] || "").trim();
    const next = String(parts[index + 1] || "").trim();
    if (!shouldMergeDependentSentenceFragment(current, next)) {
      if (current) merged.push(current);
      continue;
    }
    merged.push(joinDependentSentenceFragment(current, next));
    index += 1;
  }
  return merged;
}

function shouldMergeDependentSentenceFragment(current, next) {
  if (!current || !next || !/[.]$/u.test(current)) return false;
  const clause = current.replace(/[.]+$/u, "").trim();
  if (!dependentClauseStartPattern.test(clause)) return false;
  if (/[,;:?!]/u.test(clause)) return false;
  if (!independentClauseStartPattern.test(next)) return false;
  if (dependentClauseStartPattern.test(next)) return false;
  const clauseWords = countWords(clause);
  const combinedWords = clauseWords + countWords(next);
  return clauseWords >= 2 && clauseWords <= 15 && combinedWords <= 40;
}

function joinDependentSentenceFragment(current, next) {
  const clause = current.replace(/[.]+$/u, "").trim();
  const continuation = next.replace(/^([A-Za-z]+)/u, (word) => lowercaseContinuationWords.get(word) || word);
  return `${clause}, ${continuation}`;
}

export function buildParagraphs(sentences, maxWords = 100, maxPauseSeconds = 2.5) {
  const paragraphs = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    paragraphs.push({
      ...current,
      id: `paragraph-${paragraphs.length + 1}`,
      text: current.parts.join(" "),
    });
    delete paragraphs.at(-1).parts;
    current = null;
  };

  for (const sentence of sentences) {
    const words = Math.max(1, sentence.wordCount || countWords(sentence.text));
    const changesSpeaker = current && current.speaker !== sentence.speaker;
    const startsAfterLongPause = current && sentence.start - current.end > maxPauseSeconds;
    const exceedsLimit = current && current.wordCount + words > maxWords;
    if (changesSpeaker || startsAfterLongPause || exceedsLimit) flush();

    if (!current) {
      current = {
        sourceBlockId: sentence.sourceBlockId,
        sourceBlockIds: [],
        speaker: sentence.speaker,
        start: sentence.start,
        end: sentence.end,
        wordCount: 0,
        sentenceIds: [],
        parts: [],
      };
    }
    current.end = sentence.end;
    current.wordCount += words;
    current.sentenceIds.push(sentence.id);
    if (!current.sourceBlockIds.includes(sentence.sourceBlockId)) {
      current.sourceBlockIds.push(sentence.sourceBlockId);
    }
    current.parts.push(sentence.text);
  }
  flush();
  return attachStandaloneAcknowledgementContexts(paragraphs);
}

// A short cross-speaker acknowledgement such as "Okay." is useful listening
// context, but it is not useful enough to become its own study unit. Keep its
// sentence, speaker and timestamp intact while attaching only its playback and
// reveal context to the preceding substantive paragraph.
export function attachStandaloneAcknowledgementContexts(paragraphs = []) {
  if (!Array.isArray(paragraphs) || paragraphs.length < 3) return paragraphs;
  const result = [];

  for (let index = 0; index < paragraphs.length; index += 1) {
    const current = paragraphs[index];
    const previous = result.at(-1);
    const next = paragraphs[index + 1];
    if (!isStandaloneAcknowledgementContext(previous, current, next)) {
      result.push(current);
      continue;
    }

    const trailingSentenceIds = uniqueStrings([
      ...(previous.trailingContextSentenceIds || []),
      ...(current.sentenceIds || []),
      ...(current.trailingContextSentenceIds || []),
    ]);
    const mergedParagraphIds = uniqueStrings([
      ...(previous.mergedFromParagraphIds || []),
      previous.id,
      ...(current.mergedFromParagraphIds || []),
      current.id,
    ]);
    result[result.length - 1] = {
      ...previous,
      playbackEnd: roundTime(Math.max(
        Number(previous.playbackEnd) || Number(previous.end) || 0,
        Number(current.playbackEnd) || Number(current.end) || 0,
      )),
      trailingContextSentenceIds: trailingSentenceIds,
      mergedFromParagraphIds: mergedParagraphIds,
    };
  }

  return result;
}

function isStandaloneAcknowledgementContext(previous, current, next) {
  if (!previous || !current || !next) return false;
  if (!Array.isArray(current.sentenceIds) || current.sentenceIds.length !== 1) return false;
  if (/\?/u.test(String(current.text || ""))) return false;
  if (!standaloneAcknowledgementPattern.test(String(current.text || "").trim())) return false;
  if (Math.max(1, Number(current.wordCount) || countWords(current.text)) > 2) return false;
  const duration = Number(current.end) - Number(current.start);
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_ACKNOWLEDGEMENT_DURATION_SECONDS) return false;
  if (normalizedSpeaker(previous.speaker) !== normalizedSpeaker(next.speaker)) return false;
  if (normalizedSpeaker(current.speaker) === normalizedSpeaker(previous.speaker)) return false;
  const previousGap = Number(current.start) - Number(previous.end);
  const nextGap = Number(next.start) - Number(current.end);
  return isAcknowledgementGap(previousGap, MAX_ACKNOWLEDGEMENT_PREVIOUS_GAP_SECONDS)
    && isAcknowledgementGap(nextGap, MAX_ACKNOWLEDGEMENT_NEXT_GAP_SECONDS);
}

function isAcknowledgementGap(gap, maximum) {
  return Number.isFinite(gap)
    && gap >= MIN_ACKNOWLEDGEMENT_OVERLAP_SECONDS
    && gap <= maximum;
}

function normalizedSpeaker(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

export function buildLarkSegments(text, durationSeconds = null, maxParagraphWords = 100) {
  const blocks = parseLarkTranscript(text, durationSeconds);
  return buildSegmentsFromBlocks(blocks, maxParagraphWords);
}

export function buildSegmentsFromBlocks(blocks, maxParagraphWords = 100, maxPauseSeconds = 2.5) {
  const sentences = blocksToSentences(blocks);
  return {
    blocks,
    sentences,
    paragraphs: buildParagraphs(sentences, maxParagraphWords, maxPauseSeconds),
  };
}

export function findSparseLarkBlocks(blocks, options = {}) {
  const minimumDuration = Number(options.minimumDuration || 8);
  const maximumWordsPerSecond = Number(options.maximumWordsPerSecond || 0.7);
  return blocks.filter((block) => {
    const duration = Math.max(0, Number(block.end) - Number(block.start));
    if (duration < minimumDuration || /[\u3400-\u9fff]/u.test(block.text)) return false;
    return countWords(block.text) / duration < maximumWordsPerSecond;
  });
}

export function shouldPreferRecoveredTranscript(officialBlock, recoveredBlocks, options = {}) {
  const officialWords = countWords(officialBlock?.text);
  const recoveredWords = (recoveredBlocks || []).reduce((sum, block) => sum + countWords(block.text), 0);
  const minimumExtraWords = Number(options.minimumExtraWords || 6);
  const minimumMultiplier = Number(options.minimumMultiplier || 1.8);
  return recoveredWords >= officialWords + minimumExtraWords
    && recoveredWords >= Math.max(1, officialWords) * minimumMultiplier;
}

export function formatLarkTranscript(blocks) {
  return blocks.map((block) => (
    `${block.speaker || "Speaker"} ${formatTimestamp(block.start)}\n${stripTranscriptArtifacts(block.text)}`
  )).join("\n\n");
}

function formatTimestamp(seconds) {
  const milliseconds = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const remainingSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`;
}

export function parseWhisperJson(payload, durationSeconds = null) {
  const entries = payload?.transcription || payload?.segments || [];
  const blocks = [];
  for (const entry of entries) {
    const text = stripTranscriptArtifacts(entry?.text || entry?.sentence || "");
    if (!text) continue;
    const timedTokens = (entry.tokens || [])
      .map((token) => ({
        text: removeWhisperInternalArtifacts(token?.text),
        start: whisperEntryTime(token, "from"),
        end: whisperEntryTime(token, "to"),
      }))
      .filter((token) => token.text.trim());

    if (timedTokens.length) {
      const combined = timedTokens.map((token) => token.text).join("");
      const tokenRanges = [];
      let cursor = 0;
      for (const token of timedTokens) {
        tokenRanges.push({ ...token, charStart: cursor, charEnd: cursor + token.text.length });
        cursor += token.text.length;
      }
      const parts = [...sentenceSegmenter.segment(combined)].filter(({ segment }) => segment.trim());
      for (const part of parts) {
        const charStart = part.index;
        const charEnd = part.index + part.segment.length;
        const overlaps = tokenRanges.filter((token) => token.charEnd > charStart && token.charStart < charEnd);
        if (!overlaps.length) continue;
        blocks.push({
          id: `block-${blocks.length + 1}`,
          speaker: "Speaker",
          start: roundTime(overlaps[0].start),
          end: roundTime(Math.max(overlaps[0].start + 0.2, overlaps.at(-1).end)),
          text: part.segment.trim(),
        });
      }
      continue;
    }

    const start = whisperEntryTime(entry, "from", "start");
    const end = whisperEntryTime(entry, "to", "end");
    blocks.push({
      id: `block-${blocks.length + 1}`,
      speaker: "Speaker",
      start,
      end: end > start ? end : Math.min(durationSeconds || start + 4, start + 4),
      text,
    });
  }
  return blocks;
}

function whisperEntryTime(entry, direction, fallbackKey) {
  if (Number.isFinite(Number(entry?.offsets?.[direction]))) {
    return Number(entry.offsets[direction]) / 1000;
  }
  const timestamp = entry?.timestamps?.[direction];
  if (timestamp !== undefined) return normalizeWhisperTime(timestamp);
  return normalizeWhisperTime(entry?.[fallbackKey] ?? 0);
}

function normalizeWhisperTime(value) {
  if (typeof value === "number") return value > 10000 ? value / 1000 : value;
  const match = String(value).match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
  if (!match) return Number(value) || 0;
  return timestampToSeconds(match[1], match[2], match[3], match[4]);
}

function roundTime(value) {
  return Math.round(value * 1000) / 1000;
}

export function extractMinuteToken(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error("请输入完整的飞书妙记链接");
  }
  const allowed = /(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/i.test(url.hostname);
  if (!allowed) throw new Error("目前只支持飞书或 Lark 的妙记链接");
  const match = url.pathname.match(/\/minutes\/([A-Za-z0-9_-]{16,64})\/?$/);
  if (!match) throw new Error("没有从链接中识别到 minute_token");
  return match[1];
}
