#!/usr/bin/env bash
# doctor.sh — 检查套件是否就绪（只读，不改任何东西）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME/profiles/desktop"
PLUGINS=(dsh-self dsh-qq dsh-bili-dm dsh-tieba)
VENV="$ROOT/bot/envs/bilibili"
FAIL=0

ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '\033[31m✗\033[0m %s\n' "$*"; FAIL=1; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }

echo "== 环境 =="
[ "$(uname -s)" = "Darwin" ] && ok "macOS" || bad "非 macOS"
if [ -d "/Applications/DeepSeek Harness.app" ]; then
  ok "DSH 已安装（$(defaults read "/Applications/DeepSeek Harness.app/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo unknown)）"
else
  bad "找不到 /Applications/DeepSeek Harness.app"
fi
command -v node >/dev/null 2>&1 && ok "Node $(node -v)" || bad "缺少 Node.js"

if [ -x "$VENV/bin/python" ]; then
  ok "Python venv：$VENV"
  "$VENV/bin/python" -c "import fastapi, uvicorn, httpx" 2>/dev/null && ok "Python 依赖完整" || bad "Python 依赖缺失（重跑 ./install.sh）"
else
  bad "缺少 bot/envs/bilibili 虚拟环境（跑 ./install.sh）"
fi

echo
echo "== 插件 =="
[ -d "$PROFILE" ] && ok "profile：$PROFILE" || bad "缺少 profile：$PROFILE"
for name in "${PLUGINS[@]}"; do
  [ -d "$ROOT/plugins/$name" ] && ok "源码 $name" || bad "缺少源码 plugins/$name"
  if [ -f "$PROFILE/package.json" ]; then
    node -e "
      const p=require('$PROFILE/package.json');
      const inBundles=(p.dsh?.profile?.bundles||[]).includes('$name');
      const dep=Boolean(p.dependencies?.['$name']);
      process.exit(inBundles&&dep?0:1)
    " 2>/dev/null && ok "profile 已登记 $name" || bad "profile 未登记 $name（重跑 ./install.sh）"
  fi
  [ -e "$PROFILE/node_modules/$name" ] && ok "已链接 $name" || bad "node_modules 缺 $name（重跑 ./install.sh）"
done

echo
echo "== 凭据（缺失不影响启动，只影响登录后的功能）=="
for f in data/secrets/bilibili_credential.json data/secrets/tieba_credential.json; do
  if [ -f "$ROOT/bot/$f" ]; then ok "$f"; else warn "缺 $f（按 docs/install.md 扫码登录）"; fi
done

echo
echo "== 外部依赖（可选）=="
[ -d "/Applications/QQ.app" ] && ok "QQ.app" || warn "没装 QQ（QQ 桥不可用）"
[ -f "$HOME/Library/Containers/com.tencent.qq/Data/Documents/napcat/napcat.mjs" ] && ok "NapCat loader 已注入" || warn "NapCat 未安装/未注入（QQ 桥不可用）"
PORT_3010="$(nc -z -G 1 127.0.0.1 3010 2>/dev/null && echo up || echo down)"
[ "$PORT_3010" = "up" ] && ok "NapCat OneBot :3010 在听" || warn "NapCat :3010 未监听"
PORT_6282="$(nc -z -G 1 127.0.0.1 6282 2>/dev/null && echo up || echo down)"
[ "$PORT_6282" = "up" ] && ok "贴吧 gateway :6282 在跑" || warn "贴吧 gateway 未启动（bot/scripts/tieba up）"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "基本就绪。重启 DSH 后到插件页确认四个插件已启用。"
else
  echo "有硬性项未通过，先处理上面标 ✗ 的条目。"
fi
exit "$FAIL"
