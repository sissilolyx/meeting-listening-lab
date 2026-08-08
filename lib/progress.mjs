export function calculateMaterialStudyProgress(material) {
  const progress = material.progress || {};
  const paragraphs = material.paragraphs || [];
  const sentences = material.sentences || [];
  const isSentenceHeard = (sentenceId) => {
    const item = progress[sentenceId];
    return Boolean(item?.heard);
  };

  const totalUnitCount = paragraphs.length || sentences.length;
  const heardUnitCount = paragraphs.length
    ? paragraphs.filter((paragraph) => (
      paragraph.sentenceIds?.length && paragraph.sentenceIds.every(isSentenceHeard)
    )).length
    : sentences.filter((sentence) => isSentenceHeard(sentence.id)).length;

  return {
    heardUnitCount,
    totalUnitCount,
    progressPercent: totalUnitCount ? Math.round((heardUnitCount / totalUnitCount) * 100) : 0,
    progressUnit: paragraphs.length ? "段" : "句",
  };
}
