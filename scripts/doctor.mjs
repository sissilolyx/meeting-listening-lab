#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_PATH = path.resolve(
  process.env.WHISPER_MODEL_PATH || path.join(APP_ROOT, ".models", "ggml-small.en.bin")
);
const MINIMUM_NODE_MAJOR = 22;
const REQUIRED_MODEL_BYTES = 100 * 1024 * 1024;

// Synthetic tests supply an isolated PATH so they never inspect or invoke the
// developer's real Codex/Cursor installations. Normal launches always augment
// Finder's minimal PATH as before.
if (process.env.LISTENING_DOCTOR_TEST_PATH_ONLY !== "1") augmentMacPath();

const checks = [];
const platformReady = process.platform === "darwin";
checks.push({
  id: "macos",
  label: "macOS",
  required: true,
  ok: platformReady,
  detail: platformReady ? `${os.type()} ${os.release()} (${process.arch})` : `当前系统：${process.platform}`,
  fix: "此测试版仅支持 macOS。",
});

const nodeMajor = Number(process.versions.node.split(".")[0]);
checks.push({
  id: "node",
  label: `Node.js >= ${MINIMUM_NODE_MAJOR}`,
  required: true,
  ok: Number.isFinite(nodeMajor) && nodeMajor >= MINIMUM_NODE_MAJOR,
  detail: `v${process.versions.node} (${process.execPath})`,
  fix: "brew install node@22",
});

for (const [id, label, command, fix] of [
  ["ffmpeg", "ffmpeg", "ffmpeg", "brew install ffmpeg"],
  ["ffprobe", "ffprobe", "ffprobe", "brew install ffmpeg"],
  ["whisper", "whisper-cli", "whisper-cli", "brew install whisper-cpp"],
]) {
  const commandPath = findExecutable(command);
  checks.push({
    id,
    label,
    required: true,
    ok: Boolean(commandPath),
    detail: commandPath || "未找到",
    fix,
  });
}

const codexPath = findExecutable("codex");
checks.push({
  id: "codex",
  label: "Codex CLI（AI 讲解服务，可选）",
  required: false,
  ok: Boolean(codexPath),
  detail: codexPath || "未找到",
  fix: "npm install -g @openai/codex",
});

let codexLoginDetail = "请先安装 Codex CLI";
let codexLoginReady = false;
if (codexPath) {
  const login = safeRun(codexPath, ["login", "status"], { timeoutMs: 15_000 });
  const output = compactOutput(`${login.stdout}\n${login.stderr}`);
  codexLoginReady = login.ok && /logged in using chatgpt/i.test(output);
  if (codexLoginReady) codexLoginDetail = "已使用 ChatGPT 登录";
  else if (output) codexLoginDetail = output;
  else if (login.timedOut) codexLoginDetail = "检查登录状态超时";
  else codexLoginDetail = "未检测到 ChatGPT 登录";
}
checks.push({
  id: "codex-login",
  label: "Codex ChatGPT 登录（可选）",
  required: false,
  ok: codexLoginReady,
  detail: codexLoginDetail,
  fix: "codex login",
});

const cursorExecutable = findCursorAgentExecutable();
const cursorPath = cursorExecutable?.path || null;
const cursorCommand = cursorExecutable?.command || "agent";
checks.push({
  id: "cursor-agent",
  label: "Cursor Agent CLI（AI 讲解服务，可选）",
  required: false,
  ok: Boolean(cursorPath),
  detail: cursorPath ? `${cursorPath}（命令：${cursorCommand}）` : "未找到 agent / cursor-agent；仍可选择 Codex",
  fix: "curl https://cursor.com/install -fsS | bash",
});

let cursorLoginDetail = "请先安装 Cursor Agent CLI";
let cursorLoginReady = false;
if (cursorPath) {
  const login = safeRun(cursorPath, ["status"], { timeoutMs: 15_000 });
  const output = compactOutput(`${login.stdout}\n${login.stderr}`);
  cursorLoginReady = login.ok && !/not authenticated|not logged in|unauthenticated/i.test(output);
  if (cursorLoginReady) cursorLoginDetail = "已登录 Cursor";
  else if (output) cursorLoginDetail = output;
  else if (login.timedOut) cursorLoginDetail = "检查登录状态超时";
  else cursorLoginDetail = "未检测到 Cursor 登录";
}
checks.push({
  id: "cursor-login",
  label: "Cursor 账号登录（可选）",
  required: false,
  ok: cursorLoginReady,
  detail: cursorLoginDetail,
  fix: `${cursorCommand} login`,
});

let modelSize = 0;
try {
  modelSize = fs.statSync(MODEL_PATH).size;
} catch {
  modelSize = 0;
}
checks.push({
  id: "model",
  label: "Whisper small.en 模型",
  required: true,
  ok: modelSize >= REQUIRED_MODEL_BYTES,
  detail: modelSize >= REQUIRED_MODEL_BYTES
    ? `${relativeToRoot(MODEL_PATH)} (${formatBytes(modelSize)})`
    : `${relativeToRoot(MODEL_PATH)} 未下载或文件不完整`,
  fix: "npm run setup:model",
});

const larkPath = findExecutable("lark-cli");
let larkDetail = larkPath || "未安装；本地文件导入不受影响";
let larkReady = false;
if (larkPath) {
  const auth = safeRun(larkPath, ["auth", "status", "--json"], {
    timeoutMs: 15_000,
    env: {
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
    },
  });
  const output = `${auth.stdout}\n${auth.stderr}`;
  larkReady = auth.ok && (/"tokenStatus"\s*:\s*"valid"/i.test(output)
    || /"status"\s*:\s*"ready"/i.test(output));
  larkDetail = larkReady ? "已登录，可导入飞书妙记" : "已安装但未检测到有效登录；本地文件导入不受影响";
}
checks.push({
  id: "lark",
  label: "飞书 lark-cli（可选）",
  required: false,
  ok: larkReady,
  detail: larkDetail,
  fix: larkPath ? "lark-cli auth login" : "npm install -g @larksuite/cli",
});

const requiredReady = checks.filter((check) => check.required).every((check) => check.ok);
const aiReady = codexLoginReady || cursorLoginReady;
printReport(checks, requiredReady, aiReady);
process.exitCode = requiredReady ? 0 : 1;

function augmentMacPath() {
  const home = os.homedir();
  const candidates = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/opt/homebrew/opt/node@22/bin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/local/opt/node@22/bin",
    "/Applications/ChatGPT.app/Contents/Resources",
    "/Applications/ChatGPT.app/Contents/Resources/bin",
    path.join(home, "Applications/ChatGPT.app/Contents/Resources"),
    path.join(home, "Applications/ChatGPT.app/Contents/Resources/bin"),
    path.join(home, ".volta/bin"),
    path.join(home, ".local/bin"),
  ];

  const nvmRoot = path.join(home, ".nvm", "versions", "node");
  try {
    const versions = fs.readdirSync(nvmRoot).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) candidates.push(path.join(nvmRoot, version, "bin"));
  } catch {
    // nvm is optional.
  }

  const current = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  process.env.PATH = [...new Set([...candidates.filter((candidate) => fs.existsSync(candidate)), ...current])]
    .join(path.delimiter);
}

function findExecutable(command) {
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching without treating a missing command as an error.
    }
  }
  return null;
}

function findCursorAgentExecutable() {
  for (const command of ["agent", "cursor-agent"]) {
    const commandPath = findExecutable(command);
    if (!commandPath) continue;
    if (command === "cursor-agent") return { path: commandPath, command };

    // `agent` is a generic binary name. Match the same Cursor signature used
    // by the runtime provider resolver so an unrelated executable is not
    // reported as Cursor Agent CLI.
    const help = safeRun(commandPath, ["--help"], { timeoutMs: 10_000 });
    const output = `${help.stdout}\n${help.stderr}`;
    if (help.ok && /cursor|cloud agent|agent cli/i.test(output)) {
      return { path: commandPath, command };
    }
  }
  return null;
}

function safeRun(command, args, options = {}) {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: options.timeoutMs || 10_000,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      ok: !result.error && result.status === 0,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      timedOut: result.error?.code === "ETIMEDOUT",
    };
  } catch (error) {
    return { ok: false, stdout: "", stderr: error?.message || String(error), timedOut: false };
  }
}

function printReport(items, ready, aiReady) {
  console.log("\n原声精听 · 本机检查");
  console.log("====================\n");
  for (const item of items) {
    const icon = item.ok ? "✓" : item.required ? "✗" : "○";
    console.log(`${icon} ${item.label}`);
    console.log(`  ${item.detail}`);
  }

  const fixes = items.filter((item) => !item.ok && item.fix);
  if (fixes.length) {
    console.log("\n需要处理：");
    for (const item of fixes) {
      const prefix = item.required ? "必需" : "可选";
      console.log(`- [${prefix}] ${item.label}`);
      console.log(`  ${item.fix}`);
    }
  }

  if (ready) {
    console.log("\n✓ 本地听音与转写能力已经就绪。运行 ./start.command 开始使用。");
    if (aiReady) {
      console.log("✓ 已检测到至少一个可用的 AI 讲解服务。首次启动时可选择服务和模型。\n");
    } else {
      console.log("○ 尚未检测到已登录的 AI 讲解服务。网站仍可启动；首次打开后按引导选择并登录 Codex 或 Cursor。\n");
    }
  } else {
    console.log("\n必需能力尚未全部就绪。按上方命令处理后，再运行 npm run doctor。\n");
  }
}

function compactOutput(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" · ");
}

function relativeToRoot(target) {
  const relative = path.relative(APP_ROOT, target);
  return relative && !relative.startsWith("..") ? relative : target;
}

function formatBytes(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
