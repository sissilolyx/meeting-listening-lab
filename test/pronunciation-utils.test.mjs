import test from "node:test";
import assert from "node:assert/strict";
import { selectPronunciationVoice, splitPronunciationText } from "../public/pronunciation-utils.js";

test("finds an IPA transcription and defaults to American English", () => {
  const parts = splitPronunciationText("tomato /təˈmeɪtoʊ/: 番茄");
  const pronunciation = parts.find((part) => part.kind === "ipa");
  assert.deepEqual(pronunciation, {
    kind: "ipa",
    value: "/təˈmeɪtoʊ/",
    lang: "en-US",
    spokenText: "tomato",
  });
});

test("keeps separate British and American accents when both are present", () => {
  const parts = splitPronunciationText("英式 /təˈmɑːtəʊ/，美式 /təˈmeɪtoʊ/");
  assert.deepEqual(
    parts.filter((part) => part.kind === "ipa").map((part) => part.lang),
    ["en-GB", "en-US"],
  );
});

test("does not turn ordinary slash-delimited text into a pronunciation", () => {
  assert.deepEqual(splitPronunciationText("input/output path"), [{ kind: "text", value: "input/output path" }]);
});

test("binds each IPA transcription to its nearest English word or phrase", () => {
  const parts = splitPronunciationText(
    "tomato 发音是 /təˈmeɪtoʊ/，重音在第二个音节：may /meɪ/ 是双元音；toe /toʊ/ 与 toe 相同。fresh tomato 连读时可读作 /freʃ təˈmeɪtoʊ/。",
  );

  assert.deepEqual(
    parts.filter((part) => part.kind === "ipa").map((part) => part.spokenText),
    ["tomato", "may", "toe", "fresh tomato"],
  );
});

test("does not mistake an earlier IPA fragment or accent label for the next target", () => {
  const parts = splitPronunciationText("英式 /təˈmɑːtəʊ/，美式 /təˈmeɪtoʊ/");
  assert.deepEqual(
    parts.filter((part) => part.kind === "ipa").map((part) => part.spokenText),
    ["", ""],
  );
});

test("prefers Samantha over earlier macOS character voices for American pronunciation", () => {
  const voices = [
    { name: "Whisper", voiceURI: "Whisper", lang: "en-US", localService: true },
    { name: "Albert", voiceURI: "Albert", lang: "en-US", localService: true },
    { name: "Samantha", voiceURI: "Samantha", lang: "en-US", localService: true },
  ];
  assert.equal(selectPronunciationVoice(voices, "en-US")?.name, "Samantha");
});

test("selects a local British voice for British pronunciation", () => {
  const voices = [
    { name: "Samantha", voiceURI: "Samantha", lang: "en-US", localService: true },
    { name: "Daniel", voiceURI: "Daniel", lang: "en-GB", localService: true },
  ];
  assert.equal(selectPronunciationVoice(voices, "en-GB")?.name, "Daniel");
});

test("never falls back to a remote or character voice", () => {
  assert.equal(selectPronunciationVoice([
    { name: "Google US English", lang: "en-US", localService: false },
    { name: "Whisper", lang: "en-US", localService: true },
  ], "en-US"), null);
});
