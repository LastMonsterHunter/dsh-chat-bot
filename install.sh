#!/usr/bin/env bash
# install.sh — 把本套件接进 DSH 的 desktop profile（仅 macOS）。
#
# 做四件事：
#   1. 检查 macOS / Node / Python / DSH profile；
#   2. 建 bot/envs/bilibili 虚拟环境并安装依赖；
#   3. 把四个插件写进 profile 的 package.json（link: 依赖 + dsh.profile.bundles）；
#   4. 在 profile 的 node_modules 里建符号链接。
#
# 幂等：重复执行不会重复添加，profile 的 package.json 每次都会先备份。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME/profiles/desktop"
PLUGINS=(dsh-self dsh-qq dsh-bili-dm dsh-tieba)
VENV="$ROOT/bot/envs/bilibili"
PYTHON="${PYTHON:-python3.12}"

ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "本套件目前只支持 macOS。"

command -v node >/dev/null 2>&1 || die "找不到 node。先安装 Node.js ≥ 22。"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 版本过低（$NODE_MAJOR），需要 ≥ 22。"

if command -v "$PYTHON" >/dev/null 2>&1; then
  PY="$PYTHON"
elif command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,12) else 1)'; then
  PY="python3"
else
  die "需要 Python 3.12（python3.12 不在 PATH 中）。"
fi
ok "Node $(node -v) / $($PY -V 2>&1)"

[ -d "$PROFILE" ] || die "找不到 DSH desktop profile：$PROFILE。先启动一次 DSH 应用再运行本脚本。"
[ -d "$ROOT/plugins/dsh-self" ] || die "仓库不完整：缺少 plugins/dsh-self。"

if [ ! -x "$VENV/bin/python" ]; then
  echo "• 创建 Python 虚拟环境：$VENV"
  "$PY" -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install -q --upgrade pip
"$VENV/bin/python" -m pip install -q -r "$ROOT/bot/requirements.txt"
ok "Python 依赖就绪"

BACKUP="$PROFILE/package.json.bak-$(date +%Y%m%d%H%M%S)"
if [ -f "$PROFILE/package.json" ]; then
  cp "$PROFILE/package.json" "$BACKUP"
  ok "已备份 profile 配置：$BACKUP"
else
  warn "profile 没有 package.json，将新建一个。"
fi

ROOT="$ROOT" PROFILE="$PROFILE" PLUGINS="${PLUGINS[*]}" node <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.ROOT
const file = path.join(process.env.PROFILE, 'package.json')
const names = process.env.PLUGINS.split(/\s+/).filter(Boolean)

let pkg = {}
try { pkg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { pkg = {} }
pkg.name ||= 'dsh-profile-desktop'
pkg.private = true
pkg.dependencies ||= {}
pkg.dsh ||= {}
pkg.dsh.profile ||= {}
pkg.dsh.profile.bundles ||= []

const added = []
for (const name of names) {
  pkg.dependencies[name] = `link:${path.join(root, 'plugins', name)}`
  if (!pkg.dsh.profile.bundles.includes(name)) {
    pkg.dsh.profile.bundles.push(name)
    added.push(name)
  }
}
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log(added.length ? `• 已加入 profile bundles：${added.join(', ')}` : '• profile bundles 已包含四个插件，无需变更')
NODE

mkdir -p "$PROFILE/node_modules"
for name in "${PLUGINS[@]}"; do
  ln -sfn "$ROOT/plugins/$name" "$PROFILE/node_modules/$name"
done
ok "插件已链接到 profile"

cat <<EOF

安装完成。

下一步：
  1. 重启 DeepSeek Harness；
  2. 运行 ./doctor.sh 检查还缺什么；
  3. 按 docs/install.md 登录 QQ / B 站 / 贴吧。

提示：如果 DSH 更新后清掉了 profile 的链接，重新跑一次本脚本即可。
EOF
