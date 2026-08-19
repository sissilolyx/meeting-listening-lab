import assert from "node:assert/strict";
import test from "node:test";

import {
  aiSelectionProblem,
  aiSettingsRailLabel,
  isAiSelectionReady,
  normalizeAiSettingsPayload,
} from "../public/ai-settings-utils.js";

const readyPayload = {
  settings: { configured: true, provider: "codex", model: "gpt-dynamic" },
  providers: {
    codex: {
      installed: true,
      authenticated: true,
      models: [{ id: "gpt-dynamic", label: "GPT Dynamic", reasoningLevels: ["low", "high"] }],
    },
    cursor: { installed: false, authenticated: false, models: [] },
  },
};

test("AI settings normalize a dynamic provider catalog without inventing models", () => {
  const normalized = normalizeAiSettingsPayload(readyPayload);
  assert.deepEqual(normalized.providers.codex.models, [{
    id: "gpt-dynamic",
    label: "GPT Dynamic",
    description: "",
    reasoningLevels: ["low", "high"],
  }]);
  assert.deepEqual(normalized.providers.cursor.models, []);
});

test("a selection is saveable only when the provider is installed, authenticated, and owns the model", () => {
  assert.equal(isAiSelectionReady(readyPayload, "codex", "gpt-dynamic"), true);
  assert.match(aiSelectionProblem(readyPayload, "cursor", "anything"), /尚未安装/);
  assert.match(aiSelectionProblem(readyPayload, "codex", "stale-model"), /当前账号可用/);
});

test("the global rail label uses the configured provider and live model label", () => {
  assert.equal(aiSettingsRailLabel(readyPayload), "AI讲解 · Codex / GPT Dynamic");
  assert.equal(aiSettingsRailLabel({ providers: readyPayload.providers }), "AI讲解 · 待设置");
});

test("provider model aliases from runtime catalogs remain compatible", () => {
  const normalized = normalizeAiSettingsPayload({
    settings: { configured: true, provider: "cursor", model: "cursor-model" },
    providers: {
      cursor: {
        installed: true,
        authenticated: true,
        models: [{ slug: "cursor-model", display_name: "Cursor Model" }],
      },
    },
  });
  assert.equal(normalized.providers.cursor.models[0].label, "Cursor Model");
  assert.equal(aiSettingsRailLabel(normalized), "AI讲解 · Cursor / Cursor Model");
});
