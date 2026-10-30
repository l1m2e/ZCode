#!/bin/bash
# personal-mods 专用（见 LOCAL-MODS.md）：同步官方代码并重编译替换本地 Preview 安装。
# 由 launchd 定时触发（dev.zcode.personal-mods-sync）或手动运行。流程：
#   fetch 官方 → main fast-forward → rebase personal-mods → install/校验 → 构建 → 替换安装。
# 任一步失败都停在安全状态并弹系统通知，不会留下半安装状态；日志在 ~/.cache/personal-mods-sync.log。
# SYNC_INSTALL=0    只构建不替换（验证流水线，不打断正在运行的 app）。
# RESTART_RUNNING=0 应用运行中时跳过替换（默认会退出-替换-重启运行中的 app）。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

APP="/Applications/ZCode Preview.app"
DIST="packages/desktop/dist/mac-arm64/ZCode Preview.app"
LOG="$HOME/.cache/personal-mods-sync.log"
BUILD_ENV=(ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1)
# launchd 的最小 PATH 里没有 fnm/node/pnpm，显式挂上 fnm default 别名（node >=24，满足 engines）
export PATH="$HOME/.local/share/fnm/aliases/default/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

notify() {
  osascript -e "display notification \"$1\" with title \"personal-mods 同步\"" >/dev/null 2>&1 || true
}

fail() {
  echo "[sync-personal-mods] $1"
  notify "$1"
  exit 1
}

echo "=== $(date '+%F %T') start ==="

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "dirty worktree, skip"
  notify "工作区有未提交改动，跳过本次"
  exit 0
fi

# 直连 github.com 常见抖动：HTTP/1.1 规避 HTTP2 framing layer 错误，失败退避重试；
# 3 次仍失败则退回最近一次成功 fetch 的 origin/main（弱网下流水线不卡死，只是可能滞后一轮）
fetch_ok=0
for attempt in 1 2 3; do
  if git -c http.version=HTTP/1.1 fetch origin main; then
    fetch_ok=1
    break
  fi
  echo "fetch attempt $attempt failed, retrying..."
  sleep 15
done
if [ "$fetch_ok" != "1" ]; then
  echo "fetch failed after retries; falling back to cached origin/main"
fi

remote_main=$(git rev-parse origin/main)
# 已是最新且已安装的 app 不旧于待装构建才早退；dist 更新（延迟安装场景）则继续走安装
if [ "$(git rev-parse main)" = "$remote_main" ] &&
  [ "$(git merge-base main personal-mods)" = "$remote_main" ] &&
  [ "$APP" -nt "$DIST" ] 2>/dev/null; then
  echo "up to date, exit"
  exit 0
fi

git checkout --quiet main
git merge --ff-only origin main
git checkout --quiet personal-mods

if ! git rebase main; then
  git rebase --abort
  fail "rebase 冲突已中止，请手动同步（LOCAL-MODS.md）"
fi

pnpm install --frozen-lockfile || fail "pnpm install 失败，未安装更新"

pnpm typecheck || fail "typecheck 未通过，未安装更新"
pnpm lint || fail "lint 未通过，未安装更新"
pnpm architecture:check --changed || fail "architecture check 未通过，未安装更新"

env "${BUILD_ENV[@]}" pnpm --filter @zcode/desktop build ||
  fail "desktop build 失败，未安装更新"
env "${BUILD_ENV[@]}" pnpm --filter @zcode/desktop bundle ||
  fail "desktop bundle 失败，未安装更新"

if [ ! -d "$DIST" ]; then
  fail "构建产物缺失：$DIST"
fi

if [ "${SYNC_INSTALL:-1}" = "0" ]; then
  echo "SYNC_INSTALL=0, skip install"
  notify "同步构建完成（未替换安装）"
  exit 0
fi

reopen=0
if pgrep -f "ZCode Preview.app/Contents/MacOS" >/dev/null; then
  if [ "${RESTART_RUNNING:-1}" = "0" ]; then
    echo "app running, skip install (RESTART_RUNNING=0)"
    notify "应用运行中，已构建待替换（本次跳过）"
    exit 0
  fi
  osascript -e 'quit app "ZCode Preview"' || true
  for _ in $(seq 1 30); do
    pgrep -f "ZCode Preview.app/Contents/MacOS" >/dev/null || break
    sleep 1
  done
  if pgrep -f "ZCode Preview.app/Contents/MacOS" >/dev/null; then
    fail "应用未能退出，本次未替换"
  fi
  reopen=1
fi

rm -rf "$APP"
ditto "$DIST" "$APP"
echo "installed $(date '+%F %T')"
if [ "$reopen" = "1" ]; then
  open "$APP"
fi
notify "已同步官方更新并替换 Preview"
