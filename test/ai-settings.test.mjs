import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAiSettingsStore, validateAiSettingsInput } from "../lib/ai-settings.mjs";

test("AI settings persist only a non-secret provider and model selection", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-settings-"));
  const settingsPath = path.join(directory, "settings.json");
  const store = createAiSettingsStore(settingsPath);
  try {
    assert.deepEqual(await store.read(), { configured: false, provider: "", model: "" });
    assert.deepEqual(await store.save({ provider: "cursor", model: "  auto  " }), {
      configured: true,
      provider: "cursor",
      model: "auto",
    });
    assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, "utf8")), {
      provider: "cursor",
      model: "auto",
    });
    assert.deepEqual(await store.read(), { configured: true, provider: "cursor", model: "auto" });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("AI settings reject secrets, unknown providers, and empty models", () => {
  assert.throws(
    () => validateAiSettingsInput({ provider: "codex", model: "gpt-test", token: "must-not-be-stored" }),
    /只能包含 provider 和 model/,
  );
  assert.throws(() => validateAiSettingsInput({ provider: "other", model: "gpt-test" }), /codex 或 cursor/);
  assert.throws(() => validateAiSettingsInput({ provider: "codex", model: "" }), /model 名称无效/);
  assert.throws(() => validateAiSettingsInput({ provider: "codex", model: "--unsafe-option" }), /model 名称无效/);
});
