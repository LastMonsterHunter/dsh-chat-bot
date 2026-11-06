#!/usr/bin/env bash
# 启动 QQ（NapCat），供 dsh-qq 通过 OneBot 11 连接。
# 密码不落盘，存在 macOS 钥匙串：service=qqbot-napcat（账号在钥匙串里，不写进仓库）。
set -uo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/data/qq/logs"
WEBUI="http://127.0.0.1:6099"
mkdir -p "$LOG_DIR"

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }

echo "• 启动 QQ（NapCat）"
if ! port_open 6099; then
  open -a /Applications/QQ.app
  for _ in $(seq 1 30); do port_open 6099 && break; sleep 1; done
fi
port_open 6099 && echo "  NapCat 已就绪" || { echo "  ✗ NapCat 未启动"; exit 1; }

echo "• 检查登录状态"
if [ "${NAPCAT_AUTOLOGIN:-0}" = "1" ]; then
  # 自动登录脚本含账号信息，默认不入库；需要时用 NAPCAT_AUTOLOGIN_SCRIPT 指定。
  python3 "${NAPCAT_AUTOLOGIN_SCRIPT:-$ROOT/scripts/napcat-autologin.py}"
  rc=$?
  [ "$rc" -eq 2 ] && echo "  需要你在浏览器完成短信/滑块验证"
  [ "$rc" -eq 1 ] && echo "  登录失败，请打开 $WEBUI/webui 手动处理"
else
  echo "  跳过自动登录（默认；需要时 NAPCAT_AUTOLOGIN=1 scripts/start-bot.sh）"
fi

# AstrBot 已停用（2026-11-03）：QQ 管线由 dsh-qq 桥直连 NapCat 接管。
echo "• AstrBot 已停用，跳过"
