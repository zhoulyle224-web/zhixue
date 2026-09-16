#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(dirname "$SCRIPT_DIR")
PORT=${PORT:-8080}
HOST=${HOST:-127.0.0.1}

cd "$ROOT_DIR"
command -v node >/dev/null 2>&1 || {
  echo "未找到 Node.js，请安装 Node.js 22.13 或更高版本。" >&2
  exit 1
}

echo "正在启动智学双擎本地服务..."
echo "访问地址：http://${HOST}:${PORT}"
exec node server/local-api.mjs --host "$HOST" --port "$PORT"
