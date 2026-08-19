import assert from "node:assert/strict";
import test from "node:test";
import { resolveTextAnchor, segmentTextAnchors } from "../public/ask-text-anchor-utils.js";

test("resolveTextAnchor prefers a valid saved offset even when the quote repeats", () => {
  const text = "blue lantern, then blue lantern again";
  assert.deepEqual(resolveTextAnchor(text, {
    anchorExact: "blue lantern",
    anchorStart: 19,
    anchorEnd: 31,
  }), {
    start: 19,
    end: 31,
    exact: "blue lantern",
    method: "offset",
  });
});

test("resolveTextAnchor falls back to exact quote and surrounding context after offsets move", () => {
  const text = "Now blue lantern, but later blue lantern again.";
  assert.deepEqual(resolveTextAnchor(text, {
    anchorExact: "blue lantern",
    anchorStart: 0,
    anchorEnd: 12,
    anchorSurfaceText: "Previously blue lantern, but later blue lantern again.",
    prefix: "later ",
    suffix: " again",
  }), {
    start: 28,
    end: 40,
    exact: "blue lantern",
    method: "context",
  });
});

test("resolveTextAnchor uses a unique quote but never guesses between duplicate anchors", () => {
  assert.deepEqual(resolveTextAnchor("This wording is unique.", {
    anchorExact: "wording",
  }), {
    start: 5,
    end: 12,
    exact: "wording",
    method: "quote",
  });
  assert.equal(resolveTextAnchor("wording then wording", { anchorExact: "wording" }), null);
  assert.equal(resolveTextAnchor("wording then wording", {
    anchorExact: "wording",
    anchorPrefix: "stale ",
  }), null);
  assert.equal(resolveTextAnchor("only signal remains", {
    anchorExact: "signal",
    anchorStart: 18,
    anchorEnd: 24,
    anchorSurfaceText: "first signal then second signal later",
    prefix: "second ",
    suffix: " later",
  }), null);
  assert.equal(resolveTextAnchor("signal moved but starts alike", {
    anchorExact: "signal",
    anchorStart: 0,
    anchorEnd: 6,
    anchorSurfaceText: "signal originally appeared here",
    prefix: "before ",
    suffix: " after",
  }), null);
});

test("legacy records resolve only when sourceText has one exact occurrence", () => {
  assert.deepEqual(resolveTextAnchor("A legacy phrase remains.", { sourceText: "legacy phrase" }), {
    start: 2,
    end: 15,
    exact: "legacy phrase",
    method: "legacy",
  });
  assert.equal(resolveTextAnchor("old old", { sourceText: "old" }), null);
});

test("segmentTextAnchors creates stable pieces for overlapping question anchors", () => {
  const text = "abcdefghij";
  const segments = segmentTextAnchors(text, [
    { id: "first", anchorExact: "bcdef", anchorStart: 1, anchorEnd: 6 },
    { id: "second", anchorExact: "efghi", anchorStart: 4, anchorEnd: 9 },
  ]);
  assert.deepEqual(segments.map(({ text: part, start, end, anchorIds }) => ({ part, start, end, anchorIds })), [
    { part: "a", start: 0, end: 1, anchorIds: [] },
    { part: "bcd", start: 1, end: 4, anchorIds: ["first"] },
    { part: "ef", start: 4, end: 6, anchorIds: ["first", "second"] },
    { part: "ghi", start: 6, end: 9, anchorIds: ["second"] },
    { part: "j", start: 9, end: 10, anchorIds: [] },
  ]);
  assert.equal(segments.map((segment) => segment.text).join(""), text);
});

test("invalid offsets fall back safely while missing quotes do not create misplaced segments", () => {
  assert.deepEqual(resolveTextAnchor("safe text", { anchorExact: "safe", anchorStart: -1, anchorEnd: 4 }), {
    start: 0,
    end: 4,
    exact: "safe",
    method: "quote",
  });
  assert.equal(resolveTextAnchor("safe text", { anchorExact: "missing", anchorStart: 0, anchorEnd: 4 }), null);
  assert.deepEqual(segmentTextAnchors("safe text", [{ id: "missing", sourceText: "none" }]), [{
    text: "safe text",
    start: 0,
    end: 9,
    anchorIds: [],
    anchors: [],
  }]);
});

test("overlapping duplicate quotes are treated as ambiguous", () => {
  assert.equal(resolveTextAnchor("aaa", { sourceText: "aa" }), null);
});
