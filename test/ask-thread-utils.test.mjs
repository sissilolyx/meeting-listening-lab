import assert from "node:assert/strict";
import test from "node:test";

import { classifyAskAnchor, resolveAskPanelTop } from "../public/ask-thread-utils.js";

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
