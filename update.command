#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Finder 双击时补齐 Git、Node.js 与 Homebrew 的常见路径。
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/local/sbin:/usr/local/opt/node@22/bin:$HOME/.volta/bin:$HOME/.local/bin:$PATH"
for candidate in "$HOME"/.nvm/versions/node/*/bin; do
  [[ -d "$candidate" ]] && export PATH="$candidate:$PATH"
done

echo
echo "原声精听 · 安全更新"
echo "==================="
echo "只更新公开代码；不会 reset、clean、stash、删除或重新克隆。"
echo

if ! command -v git >/dev/null 2>&1; then
  echo "未找到 Git，无法更新。"
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先双击 setup.command 查看安装指引。"
  exit 1
fi

node scripts/safe-update.mjs

echo
echo "正在检查更新后的本机环境……"
node scripts/doctor.mjs

echo
echo "更新完成。双击 start.command 继续使用；原有材料和学习进度会直接出现。"
