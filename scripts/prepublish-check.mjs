#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const self = "scripts/prepublish-check.mjs";
const forbiddenPathPatterns = [
  /(^|\/)\.data(\/|$)/,
  /(^|\/)\.models(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)output(\/|$)/,
  /(^|\/)\.playwright-cli(\/|$)/,
  /(^|\/)\.env(?:\.|$)/,
  /\.(?:mp3|m4a|wav|aac|flac|mp4|mov|mkv|webm|srt|vtt)$/i,
];
const forbiddenContentPatterns = [
  { label: "飞书妙记地址", pattern: /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*larkoffice\.com\/minutes\/[a-z0-9_-]{8,}/i },
  { label: "本机绝对用户路径", pattern: /\/Users\/[^/\s"'`]+\//i },
];
const localPrivacyIndex = buildLocalPrivacyIndex();

function trackedFiles() {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
    return output.split("\0").filter(Boolean);
  } catch (error) {
    throw new Error(`无法读取 Git 文件清单。请先在项目目录初始化 Git：${error.message}`);
  }
}

const files = trackedFiles();
if (!files.length) throw new Error("Git 中还没有已跟踪文件，无法执行发布隐私检查");

const failures = [];
for (const relative of files) {
  if (forbiddenPathPatterns.some((pattern) => pattern.test(relative))) {
    failures.push(`${relative}: 不允许提交本地数据、模型、构建产物或媒体文件`);
    continue;
  }
  const absolute = path.join(root, relative);
  const stat = fs.statSync(absolute);
  if (stat.size > 5 * 1024 * 1024) {
    failures.push(`${relative}: 文件超过 5 MB，请确认它不是模型或学习材料`);
    continue;
  }
  if (relative === self || stat.size === 0) continue;
  const content = fs.readFileSync(absolute);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  for (const fingerprint of forbiddenContentPatterns) {
    if (fingerprint.pattern.test(text)) failures.push(`${relative}: 检测到${fingerprint.label}`);
  }
  if (containsLocalPrivateTerm(text, localPrivacyIndex.terms)) {
    failures.push(`${relative}: 检测到本机私有材料标识`);
  }
  if (containsLocalTranscriptWindow(text, localPrivacyIndex.transcriptWindows)) {
    failures.push(`${relative}: 检测到与本机私有逐字稿重合的连续词组`);
  }
}

if (failures.length) {
  console.error("发布隐私检查失败：");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`发布隐私检查通过：已检查 ${files.length} 个 Git 跟踪文件，未发现本地材料或已知个人信息。`);

function buildLocalPrivacyIndex() {
  const terms = new Set(readOptionalDenylist());
  const transcriptWindows = new Set();
  const dataRoot = path.join(root, ".data");
  if (!fs.existsSync(dataRoot)) return { terms, transcriptWindows };

  for (const materialPath of findMaterialFiles(dataRoot)) {
    let material;
    try {
      material = JSON.parse(fs.readFileSync(materialPath, "utf8"));
    } catch {
      continue;
    }
    for (const value of [material.id, material.title, material.sourceUrl, material.minuteToken]) {
      addPrivateTerm(terms, value);
    }
    for (const sentence of material.sentences || []) {
      if (!isGenericSpeaker(sentence.speaker)) addPrivateTerm(terms, sentence.speaker);
      addTranscriptWindows(transcriptWindows, sentence.text);
    }
  }
  return { terms, transcriptWindows };
}

function findMaterialFiles(directory) {
  const matches = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name === "material.json") matches.push(absolute);
    }
  }
  return matches;
}

function readOptionalDenylist() {
  const denylistPath = path.join(root, ".privacy-denylist.local");
  if (!fs.existsSync(denylistPath)) return [];
  return fs.readFileSync(denylistPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim().toLocaleLowerCase("en-US"))
    .filter((line) => line && !line.startsWith("#"));
}

function addPrivateTerm(terms, value) {
  const normalized = String(value || "").trim().toLocaleLowerCase("en-US");
  if (normalized.length >= 4) terms.add(normalized);
}

function isGenericSpeaker(value) {
  return /^(?:speaker|unknown|unknown speaker|speaker \d+|speaker [a-z])$/i.test(String(value || "").trim());
}

function containsLocalPrivateTerm(text, terms) {
  const normalized = String(text).toLocaleLowerCase("en-US");
  return [...terms].some((term) => normalized.includes(term));
}

function addTranscriptWindows(target, text) {
  const tokens = tokenize(text);
  for (let index = 0; index + 5 <= tokens.length; index += 1) {
    target.add(hashWords(tokens.slice(index, index + 5)));
  }
}

function containsLocalTranscriptWindow(text, windows) {
  if (!windows.size) return false;
  const tokens = tokenize(text);
  for (let index = 0; index + 5 <= tokens.length; index += 1) {
    if (windows.has(hashWords(tokens.slice(index, index + 5)))) return true;
  }
  return false;
}

function tokenize(text) {
  return (String(text).match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [])
    .map((token) => token.toLocaleLowerCase("en-US"));
}

function hashWords(words) {
  return createHash("sha256").update(words.join(" ")).digest("hex");
}
