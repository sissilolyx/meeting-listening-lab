import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("alignment script persists only playback fields and updatedAt", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "listening-playback-script-"));
  const materialId = "material-script-safety";
  const directory = path.join(dataRoot, "materials", materialId);
  await fs.mkdir(path.join(directory, "whisper"), { recursive: true });
  const original = {
    id: materialId,
    title: "Keep every existing field",
    updatedAt: "2026-01-01T00:00:00.000Z",
    progress: { "paragraph-1": { heard: true } },
    paragraphs: [{ id: "paragraph-1", text: "Okay.", custom: { untouched: true } }],
    customTopLevel: { untouched: [1, 2, 3] },
    sentences: [{
      id: "sentence-1",
      sourceBlockId: "block-1",
      speaker: "Speaker A",
      start: 10,
      end: 14,
      text: "This is a complete sentence.",
      timingQuality: "estimated",
      analysis: { keep: "exactly" },
    }],
  };
  const whisperPayload = {
    transcription: [{
      tokens: [
        timedToken(" This", 10000, 10500),
        timedToken(" is", 10500, 11000),
        timedToken(" a", 11000, 11500),
        timedToken(" complete", 11500, 12500),
        timedToken(" sentence", 12500, 13500),
      ],
    }],
  };
  await fs.writeFile(path.join(directory, "material.json"), `${JSON.stringify(original, null, 2)}\n`);
  await fs.writeFile(path.join(directory, "whisper", "transcript.json"), JSON.stringify(whisperPayload));

  try {
    await execFileAsync(process.execPath, ["scripts/align-sentence-playback.mjs", materialId], {
      cwd: projectRoot,
      env: { ...process.env, LISTENING_DATA_DIR: dataRoot },
    });
    const saved = JSON.parse(await fs.readFile(path.join(directory, "material.json"), "utf8"));
    assert.notEqual(saved.updatedAt, original.updatedAt);
    assert.deepEqual(withoutAllowedChanges(saved), withoutAllowedChanges(original));
    assert.equal(saved.sentences[0].playbackTimingQuality, "whisper-aligned");
    const files = await fs.readdir(directory);
    assert.equal(files.filter((name) => name.startsWith("material.before-playback-alignment.")).length, 1);
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

function withoutAllowedChanges(value) {
  const clone = structuredClone(value);
  delete clone.updatedAt;
  for (const sentence of clone.sentences || []) {
    delete sentence.playbackStart;
    delete sentence.playbackEnd;
    delete sentence.playbackTimingQuality;
    delete sentence.playbackAlignmentCoverage;
  }
  return clone;
}

function timedToken(text, from, to) {
  return { text, offsets: { from, to } };
}
