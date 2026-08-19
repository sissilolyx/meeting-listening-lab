export function buildReviewQueue(materials = []) {
  return materials.flatMap((material) => buildMaterialReviewQueue(material));
}

export function buildMaterialReviewQueue(material = {}) {
  const paragraphs = Array.isArray(material.paragraphs) ? material.paragraphs : [];
  const reviewItems = Array.isArray(material.reviewItems) ? material.reviewItems : [];
  const progress = material.progress && typeof material.progress === "object" ? material.progress : {};
  const manualReviewSentenceIds = new Set(
    Object.entries(progress)
      .filter(([, item]) => item?.status === "review")
      .map(([id]) => id),
  );
  const itemReviewSentenceIds = new Set(
    reviewItems
      .filter((item) => (item.kind === "phrase" || item.kind === "qa") && item.sentenceId)
      .map((item) => item.sentenceId),
  );

  return paragraphs.flatMap((paragraph, paragraphIndex) => {
    const paragraphIds = new Set([
      paragraph.id,
      ...(Array.isArray(paragraph.mergedFromParagraphIds) ? paragraph.mergedFromParagraphIds : []),
    ].filter(Boolean));
    const sentenceIds = unique([
      ...(Array.isArray(paragraph.sentenceIds) ? paragraph.sentenceIds : [paragraph.id]),
      ...(Array.isArray(paragraph.trailingContextSentenceIds) ? paragraph.trailingContextSentenceIds : []),
    ].filter(Boolean));
    const sentenceIdSet = new Set(sentenceIds);
    const directParagraphItems = reviewItems.filter((item) => (
      item.kind === "paragraph" && paragraphIds.has(item.paragraphId)
    ));
    const sentenceReviewIds = sentenceIds.filter((id) => (
      manualReviewSentenceIds.has(id) || itemReviewSentenceIds.has(id)
    ));
    if (!directParagraphItems.length && !sentenceReviewIds.length) return [];

    const relatedReviewItems = reviewItems.filter((item) => (
      (item.kind === "paragraph" && paragraphIds.has(item.paragraphId))
      || ((item.kind === "phrase" || item.kind === "qa") && sentenceIdSet.has(item.sentenceId))
    ));
    return [{
      key: `${material.id}:${paragraph.id}`,
      materialId: material.id,
      materialTitle: material.title || "未命名材料",
      materialCompleted: material.completed === true,
      materialCompletedAt: material.completed === true && typeof material.completedAt === "string"
        ? material.completedAt
        : null,
      paragraphId: paragraph.id,
      paragraphIndex,
      speaker: paragraph.speaker || "",
      start: finiteNumberOrNull(paragraph.start),
      end: finiteNumberOrNull(paragraph.end),
      text: typeof paragraph.text === "string" ? paragraph.text : "",
      wordCount: Number.isFinite(Number(paragraph.wordCount)) ? Number(paragraph.wordCount) : 0,
      sentenceIds: Array.isArray(paragraph.sentenceIds) ? [...paragraph.sentenceIds] : [],
      review: {
        wholeParagraph: directParagraphItems.length > 0,
        sentenceIds: sentenceReviewIds,
        itemIds: unique(relatedReviewItems.map((item) => item.id).filter(Boolean)),
      },
    }];
  });
}

function unique(values) {
  return [...new Set(values)];
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
