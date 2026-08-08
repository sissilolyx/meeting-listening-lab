export function hasTranscriptReconstruction(answer) {
  return answer?.transcriptStatus === "likely_mistranscribed"
    && Boolean(String(answer?.likelySpokenEnglish || "").trim());
}

export function resolvedLearningSource(answer, fallback = "") {
  if (hasTranscriptReconstruction(answer)) return String(answer.likelySpokenEnglish).trim();
  return String(answer?.selectedText || fallback || "").trim();
}
