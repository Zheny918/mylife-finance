#!/bin/sh
# Finance MCP 容器入口：先校验 Node 版本，再交给 CMD。
# 必须保持 LF 换行——CRLF 在 alpine 的 sh 里会报 ": not found"。
set -e

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
NODE_MINOR=$(node -p "process.versions.node.split('.')[1]")

if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  echo "ERROR: 需要 Node >= 22.13（node:sqlite 免标志），当前 $(node -v)" >&2
  echo "       请改用更新的 node:22-alpine 基础镜像。" >&2
  exit 1
fi

if ! node -e "require('node:sqlite')" >/dev/null 2>&1; then
  echo "ERROR: 当前 Node 无法加载 node:sqlite，请升级基础镜像。" >&2
  exit 1
fi

DATA_DIR="${MYLF_DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

exec "$@"
