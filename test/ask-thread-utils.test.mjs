import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyAskAnchor,
  countAskThreadCards,
  dedupeAskHistoryItems,
  isAskRequestTokenCurrent,
  mergeAskThreadCards,
  resolveAskPanelTop,
} from "../public/ask-thread-utils.js";

test("ask thread distinguishes visible, above, below, and missing anchors", () => {
  assert.equal(classifyAskAnchor({ top: 120, bottom: 150 }, 900), "visible");
  assert.equal(classifyAskAnchor({ top: -80, bottom: -2 }, 900), "above");
  assert.equal(classifyAskAnchor({ top: 905, bottom: 940 }, 900), "below");
  assert.equal(classifyAskAnchor(null, 900), "missing");
});

test("ask thread follows a visible anchor and docks at viewport edges", () => {
  const base = { panelHeight: 360, viewportHeight: 900, padding: 12 };
  assert.equal(resolveAskPanelTop({ ...base, anchorRect: { top: 220, bottom: 260 } }), 220);
  assert.equal(resolveAskPanelTop({ ...base, anchorRect: { top: -90, bottom: -4 } }), 12);
  assert.equal(resolveAskPanelTop({ ...base, anchorRect: { top: 910, bottom: 950 } }), 528);
  assert.equal(resolveAskPanelTop({ ...base, anchorRect: { top: 850, bottom: 880 } }), 528);
});

test("mobile docking reserves room for persistent corner controls", () => {
  assert.equal(resolveAskPanelTop({
    anchorRect: { top: 700, bottom: 730 },
    panelHeight: 420,
    viewportHeight: 800,
    padding: 12,
    bottomOffset: 64,
  }), 304);
});

test("question history ids are deduplicated without dropping legacy id-less records", () => {
  const first = { id: "qa-1", question: "first" };
  const duplicate = { id: "qa-1", question: "duplicate" };
  const legacy = { question: "legacy" };
  assert.deepEqual(dedupeAskHistoryItems([first, duplicate, legacy]), [first, legacy]);
});

test("question rail merges one material's history and transient cards without completed duplicates", () => {
  const transientCards = new Map([
    ["draft-1", {
      cardId: "draft-1",
      materialId: "material-a",
      status: "draft",
      question: "draft question",
    }],
    ["saved-request", {
      cardId: "saved-request",
      materialId: "material-a",
      status: "pending",
      historyId: "qa-1",
    }],
    ["other-material", {
      cardId: "other-material",
      materialId: "material-b",
      status: "pending",
    }],
  ]);
  const cards = mergeAskThreadCards({
    materialId: "material-a",
    historyItems: [
      { id: "qa-1", materialId: "material-a", question: "saved answer" },
      { id: "qa-1", materialId: "material-a", question: "duplicate answer" },
      { id: "qa-other", materialId: "material-b", question: "other answer" },
    ],
    transientCards,
  });

  assert.deepEqual(cards.map((card) => card.cardId), ["history:qa-1", "draft-1"]);
  assert.deepEqual(cards[0], {
    id: "qa-1",
    materialId: "material-a",
    question: "saved answer",
    cardId: "history:qa-1",
    historyId: "qa-1",
    kind: "history",
    status: "complete",
    persisted: true,
  });
  assert.equal(cards[1].kind, "transient");
  assert.equal(cards[1].persisted, false);
});

test("question rail counts every card and pending requests independently", () => {
  assert.deepEqual(countAskThreadCards([
    { status: "complete" },
    { status: "pending" },
    { status: "pending" },
    { status: "error" },
  ]), { total: 4, pending: 2 });
});

test("request tokens reject stale async responses", () => {
  const card = { requestToken: "request-2" };
  assert.equal(isAskRequestTokenCurrent(card, "request-2"), true);
  assert.equal(isAskRequestTokenCurrent(card, "request-1"), false);
  assert.equal(isAskRequestTokenCurrent(null, "request-2"), false);
});

test("out-of-order A/B responses settle only their matching cards", () => {
  const transientCards = new Map([
    ["card-a", {
      cardId: "card-a",
      materialId: "material-a",
      status: "pending",
      requestToken: "request-a",
      question: "question A",
    }],
    ["card-b", {
      cardId: "card-b",
      materialId: "material-a",
      status: "pending",
      requestToken: "request-b",
      question: "question B",
    }],
  ]);

  assert.equal(isAskRequestTokenCurrent(transientCards.get("card-b"), "request-b", "material-a"), true);
  transientCards.set("card-b", {
    ...transientCards.get("card-b"),
    historyId: "history-b",
    status: "complete",
  });
  const afterB = mergeAskThreadCards({
    materialId: "material-a",
    historyItems: [{ id: "history-b", question: "question B" }],
    transientCards,
  });
  assert.deepEqual(afterB.map((card) => card.cardId), ["history:history-b", "card-a"]);
  assert.deepEqual(countAskThreadCards(afterB), { total: 2, pending: 1 });

  assert.equal(isAskRequestTokenCurrent(transientCards.get("card-a"), "request-a", "material-a"), true);
  transientCards.set("card-a", {
    ...transientCards.get("card-a"),
    historyId: "history-a",
    status: "complete",
  });
  const afterA = mergeAskThreadCards({
    materialId: "material-a",
    historyItems: [
      { id: "history-b", question: "question B" },
      { id: "history-a", question: "question A" },
    ],
    transientCards,
  });
  assert.deepEqual(afterA.map((card) => card.cardId), ["history:history-b", "history:history-a"]);
  assert.deepEqual(countAskThreadCards(afterA), { total: 2, pending: 0 });
});

test("retry ignores the failed attempt's old token", () => {
  const retriedCard = {
    cardId: "card-a",
    materialId: "material-a",
    status: "pending",
    requestToken: "retry-2",
  };
  assert.equal(isAskRequestTokenCurrent(retriedCard, "attempt-1", "material-a"), false);
  assert.equal(isAskRequestTokenCurrent(retriedCard, "retry-2", "material-a"), true);
  assert.equal(isAskRequestTokenCurrent(retriedCard, "retry-2", "material-b"), false);
});

test("question cards remain isolated when the active material changes", () => {
  const historyItems = [
    { id: "history-a", materialId: "material-a", question: "answer A" },
    { id: "history-b", materialId: "material-b", question: "answer B" },
  ];
  const transientCards = new Map([
    ["pending-a", { cardId: "pending-a", materialId: "material-a", status: "pending" }],
    ["pending-b", { cardId: "pending-b", materialId: "material-b", status: "pending" }],
  ]);

  assert.deepEqual(
    mergeAskThreadCards({ materialId: "material-a", historyItems, transientCards })
      .map((card) => card.cardId),
    ["history:history-a", "pending-a"],
  );
  assert.deepEqual(
    mergeAskThreadCards({ materialId: "material-b", historyItems, transientCards })
      .map((card) => card.cardId),
    ["history:history-b", "pending-b"],
  );
});

test("question cards remain isolated when the active natural paragraph changes", () => {
  const historyItems = [
    { id: "history-a", materialId: "material-a", sentenceId: "sentence-a", question: "answer A" },
    { id: "history-b", materialId: "material-a", sentenceId: "sentence-b", question: "answer B" },
    { id: "history-legacy", materialId: "material-a", question: "unscoped legacy answer" },
  ];
  const transientCards = new Map([
    ["pending-a", { cardId: "pending-a", materialId: "material-a", sentenceId: "sentence-a", status: "pending" }],
    ["pending-b", { cardId: "pending-b", materialId: "material-a", sentenceId: "sentence-b", status: "pending" }],
  ]);

  assert.deepEqual(
    mergeAskThreadCards({
      materialId: "material-a",
      sentenceIds: ["sentence-a", "sentence-a-context"],
      historyItems,
      transientCards,
    }).map((card) => card.cardId),
    ["history:history-a", "pending-a"],
  );
  assert.deepEqual(
    mergeAskThreadCards({
      materialId: "material-a",
      sentenceIds: ["sentence-b"],
      historyItems,
      transientCards,
    }).map((card) => card.cardId),
    ["history:history-b", "pending-b"],
  );
});
