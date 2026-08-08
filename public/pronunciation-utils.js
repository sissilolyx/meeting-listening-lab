const IPA_SIGNAL_PATTERN = /[\u0250-\u02AF\u02B0-\u02FFˈˌːæðθŋɒɔʃʒəɜɪʊɑɛʌɚɝ]/u;
const IPA_SEGMENT_PATTERN = /\/([^/\n]{1,80})\//gu;
const ENGLISH_EXPRESSION_PATTERN = /[A-Za-z]+(?:[\u2019'-][A-Za-z]+)*(?:\s+[A-Za-z]+(?:[\u2019'-][A-Za-z]+)*){0,3}/gu;
const PRONUNCIATION_LABELS = new Set(["american", "british", "english", "uk", "us"]);
const NATURAL_VOICE_PREFERENCES = {
  "en-us": ["samantha", "alex", "ava", "allison"],
  "en-gb": ["daniel", "serena", "kate", "oliver"],
};
const UNSUITABLE_VOICE_PATTERN = new RegExp(
  [
    "albert",
    "bad news",
    "bahh",
    "bells",
    "boing",
    "bubbles",
    "cellos",
    "eddy",
    "flo",
    "fred",
    "good news",
    "grandma",
    "grandpa",
    "hysterical",
    "jester",
    "junior",
    "kathy",
    "organ",
    "ralph",
    "reed",
    "rocko",
    "sandy",
    "shelley",
    "superstar",
    "trinoids",
    "whisper",
    "wobble",
    "zarvox",
  ].join("|"),
  "i",
);

export function splitPronunciationText(text) {
  const source = String(text || "");
  const parts = [];
  let cursor = 0;

  for (const match of source.matchAll(IPA_SEGMENT_PATTERN)) {
    if (!IPA_SIGNAL_PATTERN.test(match[1])) continue;
    if (match.index > cursor) parts.push({ kind: "text", value: source.slice(cursor, match.index) });
    parts.push({
      kind: "ipa",
      value: match[0],
      lang: inferPronunciationLocale(source, match.index),
      spokenText: inferPronunciationTarget(source, match.index),
    });
    cursor = match.index + match[0].length;
  }

  if (!parts.length) return [{ kind: "text", value: source }];
  if (cursor < source.length) parts.push({ kind: "text", value: source.slice(cursor) });
  return parts;
}

export function inferPronunciationTarget(text, ipaIndex) {
  // Earlier IPA transcriptions may contain ASCII fragments such as "pen" or
  // "we". Remove them before finding the nearest visible English expression,
  // otherwise a later speaker button can accidentally read part of a previous
  // phonetic transcription instead of its own word.
  const context = String(text || "")
    .slice(0, Math.max(0, Number(ipaIndex) || 0))
    .replace(IPA_SEGMENT_PATTERN, " ");
  let target = "";
  for (const match of context.matchAll(ENGLISH_EXPRESSION_PATTERN)) {
    const candidate = match[0].trim();
    if (!candidate || PRONUNCIATION_LABELS.has(candidate.toLowerCase())) continue;
    target = candidate;
  }
  return target;
}

export function inferPronunciationLocale(text, ipaIndex) {
  const context = String(text || "").slice(Math.max(0, ipaIndex - 42), ipaIndex).toLowerCase();
  const britishIndex = Math.max(context.lastIndexOf("英式"), context.lastIndexOf("british"), context.lastIndexOf(" uk"));
  const americanIndex = Math.max(context.lastIndexOf("美式"), context.lastIndexOf("american"), context.lastIndexOf(" us"));
  return britishIndex > americanIndex ? "en-GB" : "en-US";
}

export function pronunciationAccentLabel(lang) {
  return lang === "en-GB" ? "英式" : "美式";
}

/**
 * Select a stable, natural, on-device English voice. Browser voice ordering is
 * not a quality signal: on macOS it can put character voices such as Albert or
 * Whisper before Samantha. Remote voices are deliberately excluded so a word
 * pronunciation never needs an external speech service.
 */
export function selectPronunciationVoice(voices, lang = "en-US") {
  const locale = String(lang || "en-US").toLowerCase().replace("_", "-");
  const language = locale.split("-")[0];
  const candidates = (Array.isArray(voices) ? voices : []).filter((voice) => {
    const voiceLocale = String(voice?.lang || "").toLowerCase().replace("_", "-");
    const voiceName = String(voice?.name || voice?.voiceURI || "");
    return voiceLocale.startsWith(`${language}-`)
      && voice?.localService !== false
      && !UNSUITABLE_VOICE_PATTERN.test(voiceName);
  });
  if (!candidates.length) return null;

  const exactLocale = candidates.filter(
    (voice) => String(voice.lang || "").toLowerCase().replace("_", "-") === locale,
  );
  const scoped = exactLocale.length ? exactLocale : candidates;
  const preferences = NATURAL_VOICE_PREFERENCES[locale] || [];
  for (const preferredName of preferences) {
    const preferred = scoped.find((voice) => {
      const name = String(voice.name || voice.voiceURI || "").toLowerCase();
      return name === preferredName || name.startsWith(`${preferredName} (`);
    });
    if (preferred) return preferred;
  }

  return scoped.find((voice) => /\b(?:premium|enhanced|natural)\b/i.test(String(voice.name || voice.voiceURI || "")))
    || scoped.find((voice) => voice.default === true)
    || scoped[0]
    || null;
}
