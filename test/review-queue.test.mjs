import assert from "node:assert/strict";
import test from "node:test";
import { buildMaterialReviewQueue, buildReviewQueue } from "../lib/review-queue.mjs";

const firstMaterial = {
  id: "material-synthetic-one",
  title: "Synthetic planning session",
  completed: false,
  paragraphs: [
    {
      id: "paragraph-one",
      sentenceIds: ["sentence-one"],
      trailingContextSentenceIds: ["sentence-two"],
      text: "We will review the synthetic launch plan.",
      speaker: "Speaker A",
      start: 0,
      end: 4,
      wordCount: 7,
    },
    {
      id: "paragraph-two",
      mergedFromParagraphIds: ["paragraph-two-legacy"],
      sentenceIds: ["sentence-three"],
      text: "The next synthetic milestone is ready.",
      speaker: "Speaker B",
      start: 4,
      end: 8,
      wordCount: 6,
    },
    {
      id: "paragraph-no-review",
      sentenceIds: ["sentence-four"],
      text: "This paragraph has question history but was not added to review.",
      start: 8,
      end: 12,
    },
  ],
  progress: {
    "sentence-one": { status: "review" },
  },
  reviewItems: [
    { id: "review-trailing", kind: "phrase", sentenceId: "sentence-two", sourceText: "synthetic launch" },
    { id: "review-paragraph", kind: "paragraph", paragraphId: "paragraph-two-legacy", sourceText: "synthetic milestone" },
  ],
  qaHistory: [
    { id: "history-only", sentenceId: "sentence-four", question: "Synthetic question" },
  ],
};

const secondMaterial = {
  id: "material-synthetic-two",
  title: "Synthetic follow-up",
  completed: true,
  completedAt: "2026-08-09T02:00:00.000Z",
  paragraphs: [{
    id: "paragraph-three",
    sentenceIds: ["sentence-five"],
    text: "A reusable synthetic phrase appears here.",
    start: 0,
    end: 3,
  }],
  progress: {},
  reviewItems: [
    { id: "review-phrase", kind: "phrase", sentenceId: "sentence-five", sourceText: "reusable phrase" },
  ],
};

test("review queue mirrors paragraph review semantics without including unsaved question history", () => {
  const queue = buildMaterialReviewQueue(firstMaterial);

  assert.deepEqual(queue.map((item) => item.paragraphId), ["paragraph-one", "paragraph-two"]);
  assert.deepEqual(queue[0].review, {
    wholeParagraph: false,
    sentenceIds: ["sentence-one", "sentence-two"],
    itemIds: ["review-trailing"],
  });
  assert.deepEqual(queue[1].review, {
    wholeParagraph: true,
    sentenceIds: [],
    itemIds: ["review-paragraph"],
  });
  assert.equal(queue.some((item) => item.paragraphId === "paragraph-no-review"), false);
});

test("all-material review queue preserves material and paragraph order with lightweight local records", () => {
  const queue = buildReviewQueue([firstMaterial, secondMaterial]);

  assert.deepEqual(queue.map((item) => item.key), [
    "material-synthetic-one:paragraph-one",
    "material-synthetic-one:paragraph-two",
    "material-synthetic-two:paragraph-three",
  ]);
  assert.equal(queue[2].materialCompleted, true);
  assert.equal(queue[2].materialCompletedAt, "2026-08-09T02:00:00.000Z");
  assert.equal("media" in queue[2], false);
  assert.equal("qaHistory" in queue[2], false);
  assert.equal(buildReviewQueue([{
    id: "material-without-timing",
    paragraphs: [{ id: "paragraph-without-timing", sentenceIds: ["sentence-six"] }],
    progress: { "sentence-six": { status: "review" } },
  }])[0].start, null);
});
