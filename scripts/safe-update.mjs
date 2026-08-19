#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), "..");

export async function safeUpdate(root = defaultRoot, options = {}) {
  const logger = options.logger || console;
  const cwd = path.resolve(root);

  assertGitRepository(cwd);
  assertProtectedPathsIgnored(cwd);
  assertCleanPublicWorktree(cwd);

  const upstream = gitText(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (!upstream) throw new Error("当前分支没有上游分支，无法安全更新。请先确认 GitHub remote 和跟踪分支。");

  logger.log(`正在获取最新代码：${upstream}`);
  git(cwd, ["fetch", "--prune"]);

  const targetCommit = gitText(cwd, ["rev-parse", `${upstream}^{commit}`]);
  const forbiddenPaths = listTreePaths(cwd, targetCommit).filter(isForbiddenReleasePath);
  if (forbiddenPaths.length) {
    throw new Error([
      "更新已停止：远端版本包含不应进入 Git 的本地数据、模型、凭据或媒体路径。",
      ...forbiddenPaths.slice(0, 12).map((entry) => `- ${entry}`),
      forbiddenPaths.length > 12 ? `- 另有 ${forbiddenPaths.length - 12} 项` : "",
      "本机文件未被改动。请联系仓库维护者修复发布版本。",
    ].filter(Boolean).join("\n"));
  }

  const headCommit = gitText(cwd, ["rev-parse", "HEAD"]);
  if (headCommit === targetCommit) {
    logger.log("已经是最新版本；本机材料、进度、AI 设置和模型均保持不变。");
    return { updated: false, head: headCommit, target: targetCommit, upstream };
  }

  const ancestry = git(cwd, ["merge-base", "--is-ancestor", headCommit, targetCommit], { allowFailure: true });
  if (ancestry.status !== 0) {
    throw new Error("更新已停止：当前版本与远端不能快进合并。未执行 reset、stash 或覆盖，请让 Codex/Cursor 帮你检查本地代码改动。");
  }

  logger.log("安全检查通过，正在快进更新代码……");
  git(cwd, ["merge", "--ff-only", targetCommit], { inheritStdio: true });
  logger.log("更新完成；.data、.models、材料、进度、问问记录和 AI 设置均未改动。");
  return { updated: true, head: targetCommit, target: targetCommit, upstream };
}

export function isForbiddenReleasePath(value) {
  const relative = String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!relative) return false;
  return [
    /(^|\/)\.data(?:\/|$)/,
    /(^|\/)\.models(?:\/|$)/,
    /(^|\/)node_modules(?:\/|$)/,
    /(^|\/)coverage(?:\/|$)/,
    /(^|\/)\.nyc_output(?:\/|$)/,
    /(^|\/)output(?:\/|$)/,
    /(^|\/)\.playwright-cli(?:\/|$)/,
    /(^|\/)logs(?:\/|$)/,
    /(^|\/)(?:\.partial|partial)(?:\/|$)/,
    /(^|\/)\.auth(?:\/|$)/,
    /(^|\/)\.credentials(?:\/|$)/,
    /(^|\/)\.settings(?:\/|$)/,
    /(^|\/)\.env[^/]*(?:\/|$)/,
    /(^|\/)[^/]*\.local(?:\/|$)/,
    /(^|\/)(?:auth|settings)\.local\.json$/,
    /(^|\/)\.DS_Store$/,
    /\.(?:log|jsonl|partial|part|download|tmp)$/i,
    /\.(?:mp3|m4a|wav|aac|flac|mp4|mov|mkv|webm|srt|vtt)$/i,
  ].some((pattern) => pattern.test(relative));
}

function assertGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  if (result.status !== 0 || result.stdout.trim() !== "true") {
    throw new Error("当前目录不是 Git 安装目录，无法安全更新。请不要删除旧目录后重新克隆。");
  }
}

function assertProtectedPathsIgnored(cwd) {
  for (const probe of [".data/.safe-update-probe", ".models/.safe-update-probe"]) {
    const result = git(cwd, ["check-ignore", "--quiet", "--", probe], { allowFailure: true });
    if (result.status !== 0) {
      throw new Error(`更新已停止：${probe.split("/", 1)[0]}/ 不再受 Git 忽略规则保护。`);
    }
  }
}

function assertCleanPublicWorktree(cwd) {
  const status = gitText(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (status) {
    throw new Error([
      "更新已停止：代码或公开文档存在本地改动。",
      status,
      "没有执行 reset、clean、stash 或覆盖。请先让 Codex/Cursor 帮你确认这些改动。",
    ].join("\n"));
  }
}

function listTreePaths(cwd, commit) {
  const result = git(cwd, ["ls-tree", "-r", "--name-only", "-z", commit], { encoding: "buffer" });
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

function gitText(cwd, args) {
  return git(cwd, args).stdout.trim();
}

function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: options.encoding === "buffer" ? null : "utf8",
    stdio: options.inheritStdio ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.inheritStdio
      ? ""
      : String(result.stderr || result.stdout || "").trim();
    throw new Error(`Git 命令失败：git ${args.join(" ")}${detail ? `\n${detail}` : ""}`);
  }
  return {
    status: result.status,
    stdout: options.inheritStdio ? "" : String(result.stdout || ""),
    stderr: options.inheritStdio ? "" : String(result.stderr || ""),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const requestedRoot = process.argv[2] ? path.resolve(process.argv[2]) : defaultRoot;
  safeUpdate(requestedRoot).catch((error) => {
    console.error(`\n${error.message}\n`);
    process.exitCode = 1;
  });
}
