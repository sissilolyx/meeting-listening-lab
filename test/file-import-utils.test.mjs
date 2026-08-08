import assert from "node:assert/strict";
import test from "node:test";
import {
  clipboardContainsFiles,
  extractPastedMediaFile,
  normalizePastedMediaFile,
} from "../public/file-import-utils.js";

test("voice memo clipboard files keep their exported M4A name", () => {
  const voiceMemo = new File(["audio"], "Sample Voice Memo 8.m4a", { type: "audio/mp4" });
  const pasted = extractPastedMediaFile({ files: [voiceMemo], items: [] });

  assert.equal(pasted, voiceMemo);
});

test("voice memo files without an extension gain one from their audio MIME type", () => {
  const voiceMemo = new File(["audio"], "Sample Voice Memo 8", { type: "audio/mp4" });
  const pasted = normalizePastedMediaFile(voiceMemo);

  assert.equal(pasted.name, "Sample Voice Memo 8.m4a");
  assert.equal(pasted.type, "audio/mp4");
});

test("clipboard file items are detected and unsupported files stay rejected", () => {
  const documentFile = new File(["text"], "notes.txt", { type: "text/plain" });
  const clipboardData = {
    files: [],
    items: [{ kind: "file", getAsFile: () => documentFile }],
  };

  assert.equal(clipboardContainsFiles(clipboardData), true);
  assert.equal(extractPastedMediaFile(clipboardData), null);
});
