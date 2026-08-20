#!/bin/bash
set -uo pipefail

cd "$(dirname "$0")"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "英语精听训练目前仅支持 macOS。"
  exit 1
fi

# Finder 双击启动时通常不会读取 shell profile，因此显式补齐常见路径。
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/local/sbin:/usr/local/opt/node@22/bin:$HOME/.volta/bin:$HOME/.local/bin:$PATH"
for candidate in "$HOME"/.nvm/versions/node/*/bin; do
  [[ -d "$candidate" ]] && export PATH="$candidate:$PATH"
done
for resources in \
  "/Applications/ChatGPT.app/Contents/Resources" \
  "$HOME/Applications/ChatGPT.app/Contents/Resources"; do
  [[ -d "$resources" ]] && export PATH="$resources:$resources/bin:$PATH"
done

echo
echo "英语精听训练 · macOS 本地版设置"
echo "================================"
echo "此脚本只检查和给出命令，不会自动安装软件、登录账号或上传材料。"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未找到 Node.js。请先安装 Homebrew 和 Node.js 22+："
  echo "  https://brew.sh/"
  echo "  brew install node@22"
  echo
  echo "安装后重新双击 setup.command。"
  exit 1
fi

node scripts/doctor.mjs
doctor_status=$?

echo "说明："
echo "- 交给 Codex/Cursor 安装时，可在原对话中选择模型；手动安装也可在首次网页中设置。"
echo "- 仓库不捆绑 AI CLI：先检测，已有就复用，只安装当前选择且缺失的一个服务。"
echo "- 交给本地 Agent 时，获批后应由 Agent 完成官方安装、发起登录并重新检测，不要只把命令交给用户。"
echo "- 当前安装代理只建议它自身对应的服务，不会静默换用另一账号。"
echo "- 当前版本只支持 Codex 和 Cursor；选择哪一个，就消耗当前登录的对应账号额度或 token。"
echo "- 每位使用者使用自己的账号登录；本项目不提供共享 token，也不保存账号凭据。"
echo "- Codex 登录命令：codex login"
echo "- Cursor Agent 登录命令：agent login（旧版兼容命令：cursor-agent login）"
echo "- 本地文件、学习进度和问问记录只保存在当前电脑的 .data 目录。"
echo "- 原始音视频留在本机；AI 讲解会把所需逐字稿片段发送给你选择的服务。"
echo "- 飞书导入是可选能力；不安装 lark-cli 仍可使用本地音频或录屏。"
echo "- Whisper 模型只会在你明确运行 npm run setup:model 后下载。"
echo

if [[ $doctor_status -eq 0 ]]; then
  echo "设置完成。双击 start.command，或运行："
  echo "  ./start.command"
else
  echo "请按检查结果逐项处理，然后重新运行："
  echo "  npm run doctor"
fi

exit "$doctor_status"
