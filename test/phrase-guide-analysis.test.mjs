import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildPhraseGuidePrompt } from "../lib/analysis.mjs";

test("phrase guide prompt sends only the allowed local phrase context", () => {
  const prompt = buildPhraseGuidePrompt({
    speaker: "Synthetic Speaker",
    currentSentence: "We can revisit the sample timeline next week.",
    phraseText: "revisit the timeline",
    meaningZh: "重新审视时间安排",
    usageZh: "用于提出稍后重新讨论安排。",
    title: "PRIVATE_TITLE_MUST_NOT_APPEAR",
    previousSentence: "PRIVATE_PREVIOUS_MUST_NOT_APPEAR",
    nextSentence: "PRIVATE_NEXT_MUST_NOT_APPEAR",
    qaHistory: [{ question: "PRIVATE_QA_MUST_NOT_APPEAR" }],
    reviewItems: [{ sourceText: "PRIVATE_REVIEW_MUST_NOT_APPEAR" }],
    media: { file: "PRIVATE_MEDIA_MUST_NOT_APPEAR" },
  });
  const payload = JSON.parse(prompt.split("\n").at(-1));

  assert.deepEqual(payload, {
    speaker: "Synthetic Speaker",
    currentSentence: "We can revisit the sample timeline next week.",
    phraseText: "revisit the timeline",
    meaningZh: "重新审视时间安排",
    usageZh: "用于提出稍后重新讨论安排。",
  });
  assert.match(prompt, /generic, synthetic workplace scenario/);
  assert.doesNotMatch(prompt, /PRIVATE_TITLE|PRIVATE_PREVIOUS|PRIVATE_NEXT|PRIVATE_QA|PRIVATE_REVIEW|PRIVATE_MEDIA/);
});

test("phrase guide schema is strict and bounds alternatives and examples", async () => {
  const schema = JSON.parse(await fs.readFile(
    path.resolve(import.meta.dirname, "../schemas/phrase-guide.schema.json"),
    "utf8",
  ));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["usageZh", "patternZh", "alternatives", "examples"]);
  assert.equal(schema.properties.alternatives.maxItems, 3);
  assert.equal(schema.properties.alternatives.items.additionalProperties, false);
  assert.equal(schema.properties.examples.minItems, 3);
  assert.equal(schema.properties.examples.maxItems, 4);
  assert.equal(schema.properties.examples.items.additionalProperties, false);
});
