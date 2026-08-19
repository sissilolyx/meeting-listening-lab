import assert from "node:assert/strict";
import test from "node:test";

import {
  countAskThreadCards,
  isAskRequestTokenCurrent,
  mergeAskThreadCards,
} from "../public/ask-thread-utils.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createSyntheticAskRail(materialId = "synthetic-material") {
  const historyItems = [];
  const reviewHistoryIds = new Set();
  const transientCards = new Map();
  let collapsed = false;
  let scrollTop = 0;
  let sequence = 0;

  function cards() {
    return mergeAskThreadCards({ materialId, historyItems, transientCards });
  }

  function findCard(cardId) {
    return cards().find((card) => card.cardId === cardId);
  }

  function ask({ question, selectedText, response }) {
    sequence += 1;
    const cardId = `transient:${sequence}`;
    const requestToken = `request:${sequence}`;
    transientCards.set(cardId, {
      cardId,
      materialId,
      question,
      requestToken,
      selectedText,
      status: "pending",
    });

    const completion = response.then((payload) => {
      const current = transientCards.get(cardId);
      if (!isAskRequestTokenCurrent(current, requestToken, materialId)) return false;
      const historyItem = {
        ...payload.historyItem,
        ...payload.answer,
        materialId,
        question,
        selectedText,
      };
      historyItems.push(historyItem);
      transientCards.set(cardId, {
        ...current,
        answer: payload.answer,
        historyId: historyItem.id,
        historyItem,
        status: "complete",
      });
      return true;
    });

    return { cardId, completion, requestToken };
  }

  function addReview(cardId) {
    const card = findCard(cardId);
    assert.ok(card, `missing card ${cardId}`);
    assert.equal(card.status, "complete");
    assert.ok(card.historyId, "only a persisted answer can be reviewed");
    reviewHistoryIds.add(card.historyId);
  }

  function deleteQuestion(cardId) {
    const card = findCard(cardId);
    assert.ok(card, `missing card ${cardId}`);
    if (card.persisted) {
      const index = historyItems.findIndex((item) => item.id === card.historyId);
      assert.notEqual(index, -1);
      historyItems.splice(index, 1);
      for (const [transientId, transient] of transientCards) {
        if (transient.historyId === card.historyId) transientCards.delete(transientId);
      }
    } else {
      transientCards.delete(card.cardId);
    }
  }

  function collapse(nextScrollTop) {
    scrollTop = nextScrollTop;
    collapsed = true;
  }

  function expand() {
    collapsed = false;
    return { cards: cards(), scrollTop };
  }

  return {
    addReview,
    ask,
    cards,
    collapse,
    deleteQuestion,
    expand,
    get collapsed() { return collapsed; },
    historyItems,
    reviewHistoryIds,
    transientCards,
  };
}

function answerPayload(id, marker) {
  return {
    answer: {
      answerZh: `${marker} 的合成回答`,
      learningSummaryZh: `${marker} 的合成知识点`,
    },
    historyItem: { id, sentenceId: `sentence-${marker.toLowerCase()}` },
  };
}

test("synthetic A/B questions stay independent when B returns before A", async () => {
  const rail = createSyntheticAskRail();
  const responseA = deferred();
  const responseB = deferred();
  const requestA = rail.ask({
    question: "What does synthetic alpha mean?",
    selectedText: "synthetic alpha",
    response: responseA.promise,
  });
  const requestB = rail.ask({
    question: "What does synthetic beta mean?",
    selectedText: "synthetic beta",
    response: responseB.promise,
  });

  assert.deepEqual(countAskThreadCards(rail.cards()), { total: 2, pending: 2 });
  assert.deepEqual(
    rail.cards().map(({ cardId, question, status }) => ({ cardId, question, status })),
    [
      { cardId: requestA.cardId, question: "What does synthetic alpha mean?", status: "pending" },
      { cardId: requestB.cardId, question: "What does synthetic beta mean?", status: "pending" },
    ],
  );

  responseB.resolve(answerPayload("history-b", "B"));
  assert.equal(await requestB.completion, true);

  const afterB = rail.cards();
  assert.deepEqual(countAskThreadCards(afterB), { total: 2, pending: 1 });
  assert.deepEqual(afterB.map((card) => card.cardId), ["history:history-b", requestA.cardId]);
  assert.equal(afterB[0].question, "What does synthetic beta mean?");
  assert.equal(afterB[0].answerZh, "B 的合成回答");
  assert.equal(afterB[1].question, "What does synthetic alpha mean?");
  assert.equal(afterB[1].status, "pending");

  responseA.resolve(answerPayload("history-a", "A"));
  assert.equal(await requestA.completion, true);

  const completed = rail.cards();
  assert.deepEqual(countAskThreadCards(completed), { total: 2, pending: 0 });
  assert.deepEqual(completed.map((card) => card.cardId), ["history:history-b", "history:history-a"]);
  assert.equal(completed.find((card) => card.historyId === "history-a").answerZh, "A 的合成回答");
  assert.equal(completed.find((card) => card.historyId === "history-b").answerZh, "B 的合成回答");
});

test("collapse and expand preserve pending cards, completed results, and rail scroll", async () => {
  const rail = createSyntheticAskRail();
  const responseA = deferred();
  const responseB = deferred();
  const requestA = rail.ask({
    question: "Synthetic question A",
    selectedText: "alpha",
    response: responseA.promise,
  });
  const requestB = rail.ask({
    question: "Synthetic question B",
    selectedText: "beta",
    response: responseB.promise,
  });

  rail.collapse(384);
  assert.equal(rail.collapsed, true);

  responseB.resolve(answerPayload("history-b", "B"));
  assert.equal(await requestB.completion, true);
  assert.deepEqual(countAskThreadCards(rail.cards()), { total: 2, pending: 1 });

  const reopened = rail.expand();
  assert.equal(rail.collapsed, false);
  assert.equal(reopened.scrollTop, 384);
  assert.deepEqual(reopened.cards.map((card) => card.cardId), ["history:history-b", requestA.cardId]);
  assert.equal(reopened.cards.find((card) => card.cardId === requestA.cardId).status, "pending");
  assert.equal(reopened.cards.find((card) => card.historyId === "history-b").status, "complete");

  responseA.resolve(answerPayload("history-a", "A"));
  assert.equal(await requestA.completion, true);
});

test("reviewing and deleting one completed card never mutate its sibling", async () => {
  const rail = createSyntheticAskRail();
  const responseA = deferred();
  const responseB = deferred();
  const requestA = rail.ask({
    question: "Review synthetic alpha",
    selectedText: "alpha",
    response: responseA.promise,
  });
  const requestB = rail.ask({
    question: "Review synthetic beta",
    selectedText: "beta",
    response: responseB.promise,
  });

  responseB.resolve(answerPayload("history-b", "B"));
  await requestB.completion;
  responseA.resolve(answerPayload("history-a", "A"));
  await requestA.completion;

  rail.addReview("history:history-b");
  assert.deepEqual([...rail.reviewHistoryIds], ["history-b"]);
  assert.equal(rail.reviewHistoryIds.has("history-a"), false);

  rail.deleteQuestion("history:history-a");
  assert.deepEqual(rail.cards().map((card) => card.cardId), ["history:history-b"]);
  assert.equal(rail.cards()[0].question, "Review synthetic beta");
  assert.equal(rail.reviewHistoryIds.has("history-b"), true);
  assert.equal(rail.historyItems.some((item) => item.id === "history-a"), false);
  assert.equal(rail.transientCards.get(requestB.cardId).historyId, "history-b");
});
