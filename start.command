#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "英语精听训练目前仅支持 macOS。"
  exit 1
fi

# Finder 双击启动时通常不会读取 shell profile。兼容 Apple Silicon、
# Intel Homebrew、nvm/Volta，以及 ChatGPT macOS 应用内置的 Codex。
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/local/sbin:/usr/local/opt/node@22/bin:$HOME/.volta/bin:$HOME/.local/bin:$PATH"
for candidate in "$HOME"/.nvm/versions/node/*/bin; do
  [[ -d "$candidate" ]] && export PATH="$candidate:$PATH"
done
for resources in \
  "/Applications/ChatGPT.app/Contents/Resources" \
  "$HOME/Applications/ChatGPT.app/Contents/Resources"; do
  [[ -d "$resources" ]] && export PATH="$resources:$resources/bin:$PATH"
done

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先双击 setup.command 查看安装指引。"
  exit 1
fi

if ! node scripts/doctor.mjs; then
  echo "启动已停止：本机能力尚未就绪。请先双击 setup.command。"
  exit 1
fi

# 为避免材料暴露到局域网，本地版始终只监听本机。
export HOST="127.0.0.1"
requested_port="${PORT:-4173}"
selected_port="$(node --input-type=module -e '
  import net from "node:net";
  const host = process.argv[1];
  const start = Number(process.argv[2]);
  if (!Number.isInteger(start) || start < 1024 || start > 65535) process.exit(2);
  const isFree = (port) => new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
  for (let port = start; port <= Math.min(start + 100, 65535); port += 1) {
    if (await isFree(port)) {
      console.log(port);
      process.exit(0);
    }
  }
  process.exit(3);
' "$HOST" "$requested_port")" || {
  echo "无法在 $requested_port 起的 101 个端口中找到空闲端口。"
  exit 1
}

export PORT="$selected_port"
url="http://$HOST:$PORT"
if [[ "$PORT" != "$requested_port" ]]; then
  echo "端口 $requested_port 已被占用，已改用 ${PORT}。"
fi
echo "正在启动英语精听训练：$url"

# 等服务真正可访问后再打开浏览器，避免启动较慢时出现连接被拒绝。
# LISTENING_NO_OPEN 仅供自动检查使用；正常双击不需要设置。
if [[ "${LISTENING_NO_OPEN:-0}" != "1" ]]; then
  (
    for _ in $(seq 1 80); do
      if /usr/bin/curl --silent --fail --max-time 1 "$url/" >/dev/null 2>&1; then
        /usr/bin/open "$url"
        exit 0
      fi
      sleep 0.25
    done
    echo "服务启动后请在浏览器打开：$url"
  ) &
fi

exec node server.mjs
