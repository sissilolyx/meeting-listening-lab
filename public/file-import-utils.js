const EXTENSION_PATTERN = /\.(mp3|m4a|wav|mp4|mov)$/i;

const MIME_EXTENSION = new Map([
  ["audio/mpeg", ".mp3"],
  ["audio/mp3", ".mp3"],
  ["audio/mp4", ".m4a"],
  ["audio/x-m4a", ".m4a"],
  ["audio/wav", ".wav"],
  ["audio/x-wav", ".wav"],
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
]);

export function isSupportedLocalMedia(file) {
  if (!file) return false;
  return EXTENSION_PATTERN.test(file.name || "") || MIME_EXTENSION.has(String(file.type || "").toLowerCase());
}

export function normalizePastedMediaFile(file) {
  if (!file || !isSupportedLocalMedia(file)) return null;
  if (EXTENSION_PATTERN.test(file.name || "")) return file;

  const extension = MIME_EXTENSION.get(String(file.type || "").toLowerCase());
  if (!extension) return null;
  const stem = String(file.name || "语音备忘录").trim() || "语音备忘录";
  return new File([file], `${stem}${extension}`, {
    type: file.type,
    lastModified: file.lastModified || Date.now(),
  });
}

export function extractPastedMediaFile(clipboardData) {
  if (!clipboardData) return null;
  const candidates = [...Array.from(clipboardData.files || [])];
  for (const item of Array.from(clipboardData.items || [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile?.();
    if (file && !candidates.includes(file)) candidates.push(file);
  }
  for (const candidate of candidates) {
    const normalized = normalizePastedMediaFile(candidate);
    if (normalized) return normalized;
  }
  return null;
}

export function clipboardContainsFiles(clipboardData) {
  if (!clipboardData) return false;
  if (Array.from(clipboardData.files || []).length) return true;
  return Array.from(clipboardData.items || []).some((item) => item.kind === "file");
}
