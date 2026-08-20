import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCTOR = path.join(ROOT, "scripts", "doctor.mjs");
const REQUIRED_MODEL_BYTES = 101 * 1024 * 1024;

test("doctor keeps AI providers optional when local listening dependencies are ready", {
  skip: process.platform !== "darwin" ? "macOS-only application check" : false,
}, () => {
  const fixture = createFixture();
  try {
    const result = runDoctor(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /本地听音与转写能力已经就绪/);
    assert.match(result.stdout, /网站仍可启动/);
    assert.match(result.stdout, /Codex CLI（AI 讲解服务，可选）/);
    assert.match(result.stdout, /Cursor Agent CLI（AI 讲解服务，可选）/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("doctor reports a synthetic authenticated Cursor provider without reading real user state", {
  skip: process.platform !== "darwin" ? "macOS-only application check" : false,
}, () => {
  const fixture = createFixture({ cursor: true });
  try {
    const result = runDoctor(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /已登录 Cursor/);
    assert.match(result.stdout, /至少一个可用的 AI 讲解服务/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("doctor recognizes the current Cursor agent command without mistaking a generic binary", {
  skip: process.platform !== "darwin" ? "macOS-only application check" : false,
}, () => {
  const fixture = createFixture({ cursor: true, cursorCommand: "agent" });
  try {
    const result = runDoctor(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /命令：agent/);
    assert.match(result.stdout, /已登录 Cursor/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("doctor ignores an unrelated executable named agent", {
  skip: process.platform !== "darwin" ? "macOS-only application check" : false,
}, () => {
  const fixture = createFixture({ genericAgent: true });
  try {
    const result = runDoctor(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /未找到 agent \/ cursor-agent/);
    assert.doesNotMatch(result.stdout, /已登录 Cursor/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "listening-doctor-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const model = path.join(root, "ggml-small.en.bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(model, "");
  fs.truncateSync(model, REQUIRED_MODEL_BYTES);

  for (const name of ["ffmpeg", "ffprobe", "whisper-cli"]) {
    installExecutable(bin, name, "#!/bin/sh\nexit 0\n");
  }
  if (options.cursor) {
    installExecutable(bin, options.cursorCommand || "cursor-agent", [
      "#!/bin/sh",
      "[ \"$1\" = --help ] && echo 'Cursor Agent CLI' && exit 0",
      "[ \"$1\" = status ] && echo 'Logged in as synthetic@example.invalid'",
      "exit 0",
      "",
    ].join("\n"));
  }
  if (options.genericAgent) {
    installExecutable(bin, "agent", "#!/bin/sh\necho 'unrelated task runner'\nexit 0\n");
  }
  return { root, bin, home, model };
}

function runDoctor(fixture) {
  return spawnSync(process.execPath, [DOCTOR], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: fixture.bin,
      WHISPER_MODEL_PATH: fixture.model,
      LISTENING_DOCTOR_TEST_PATH_ONLY: "1",
    },
  });
}

function installExecutable(directory, name, contents) {
  const target = path.join(directory, name);
  fs.writeFileSync(target, contents, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
}
