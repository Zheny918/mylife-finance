#!/usr/bin/env sh
#
# mylife-finance 技能安装器（Octop / Linux）
#
# 做两件事：
#   1. 把技能包解到 <octop_home>/agents/<agent>/skills/mylife-finance/
#   2. 打印 MCP 连接器的注册信息（这一步必须在 Octop 控制台点，脚本无法代劳）
#
# 为什么第 2 步不能自动化：自定义 MCP 存在 Octop 控制面数据库 octop.db 里，
# 官方只暴露了控制台 UI，没有稳定的写入接口。直接改库会在升级时被 schema 迁移踩掉。
#
# 用法：
#   ./install.sh --agent main --user alice
#   ./install.sh --agent main --user alice --print-only
#   OCTOP_HOME=/data/.octop ./install.sh --agent main --user alice
#
set -eu

AGENT="main"
USER_ID=""
PRINT_ONLY=0
MCP_HOST="mylife-finance-mcp"
MCP_PORT="3458"

usage() {
  cat <<'EOF'
用法: ./install.sh [选项]

  --agent <id>      目标 Octop Agent id，默认 main
  --user <id>       该 Agent 对应的财务用户标识（决定 MCP URL 里的隔离边界）
  --host <name>     MCP 容器服务名，默认 mylife-finance-mcp
  --port <n>        MCP 端口，默认 3458
  --print-only      只打印配置，不复制技能文件
  -h, --help        显示本帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --agent) AGENT="$2"; shift 2 ;;
    --user) USER_ID="$2"; shift 2 ;;
    --host) MCP_HOST="$2"; shift 2 ;;
    --port) MCP_PORT="$2"; shift 2 ;;
    --print-only) PRINT_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 1 ;;
  esac
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OCTOP_HOME="${OCTOP_HOME:-$HOME/.octop}"

echo "==> Octop 数据目录: $OCTOP_HOME"
if [ ! -d "$OCTOP_HOME" ]; then
  echo "错误：$OCTOP_HOME 不存在。请先安装并至少启动一次 Octop（octop run）。" >&2
  exit 1
fi

AGENT_DIR="$OCTOP_HOME/agents/$AGENT"
if [ ! -d "$AGENT_DIR" ]; then
  echo "错误：找不到 Agent 工作区 $AGENT_DIR" >&2
  echo "可用的 Agent：" >&2
  ls -1 "$OCTOP_HOME/agents" 2>/dev/null | sed 's/^/  - /' >&2 || echo "  （无）" >&2
  exit 1
fi

# 找技能包
ZIP=$(ls -1 "$SCRIPT_DIR"/dist/mylife-finance-skill-*.zip 2>/dev/null | tail -n 1 || true)
if [ -z "$ZIP" ]; then
  echo "错误：$SCRIPT_DIR/dist/ 下没有技能包。先执行：node scripts/pack-octop-skill.mjs" >&2
  exit 1
fi

if [ "$PRINT_ONLY" -eq 0 ]; then
  SKILLS_DIR="$AGENT_DIR/skills"
  mkdir -p "$SKILLS_DIR"

  echo "==> 解压技能包 $(basename "$ZIP")"
  if command -v unzip >/dev/null 2>&1; then
    unzip -oq "$ZIP" -d "$SKILLS_DIR"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$ZIP" "$SKILLS_DIR"
  elif command -v python >/dev/null 2>&1; then
    python -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$ZIP" "$SKILLS_DIR"
  else
    echo "错误：需要 unzip 或 python(3) 来解压。" >&2
    exit 1
  fi

  if [ ! -f "$SKILLS_DIR/mylife-finance/SKILL.md" ]; then
    echo "错误：解压后未找到 $SKILLS_DIR/mylife-finance/SKILL.md" >&2
    exit 1
  fi
  echo "    已安装到 $SKILLS_DIR/mylife-finance/"
fi

if [ -z "$USER_ID" ]; then
  echo
  echo "提示：未指定 --user，下面用占位符 <用户名>。它是数据隔离的边界，每个用户各不相同。"
  USER_ID="<用户名>"
fi

MCP_URL="http://$MCP_HOST:$MCP_PORT/mcp/$USER_ID"

if [ "$PRINT_ONLY" -eq 0 ]; then
  SKILL_LINE="技能已装到：$AGENT_DIR/skills/mylife-finance/"
  STEP1="  1. 打开 Octop 控制台 → 「连接器」→ 添加自定义 MCP"
else
  SKILL_LINE="技能未复制（--print-only）。手动解压：unzip -o $(basename "$ZIP") -d $AGENT_DIR/skills/"
  STEP1="  1. 先把技能包装上（去掉 --print-only 重跑，或手动解压），再打开控制台 →「连接器」→ 添加自定义 MCP"
fi

cat <<EOF

================================================================
下一步：在 Octop 控制台注册 MCP 连接器（必须手动，约 1 分钟）

$STEP1
  2. 类型选 Streamable HTTP，填入：

       URL: $MCP_URL

     若你启用了 MYLF_HTTP_TOKEN，再加请求头：
       Authorization: Bearer <你的令牌>

  3. 保存后，在同一页面把它挂到 Agent「$AGENT」上
  4. 回到对话，说一句「记一笔餐饮 88 元，用招行卡」验证

================================================================

$SKILL_LINE
MCP 地址   ：$MCP_URL

排查：
  curl -s http://127.0.0.1:$MCP_PORT/health        # 容器健康（在宿主机上）
  docker logs mylife-finance-mcp                   # 容器日志
EOF
