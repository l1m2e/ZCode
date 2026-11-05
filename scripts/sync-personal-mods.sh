#!/bin/bash
# personal-mods 专用（见 LOCAL-MODS.md）：同步官方代码并重编译构建产物。
# 由 launchd 定时触发（dev.zcode.personal-mods-sync）或手动运行。流程：
#   fetch 官方 → main fast-forward → rebase personal-mods → install/校验 → 构建 → 写更新清单。
# 本脚本不安装：构建完成后在 app 内点「更新」按钮安装（personalSelfBuiltUpdate 模块
# 拉起本脚本 --install-only 完成退出-替换-重启）。任一步失败弹系统通知并停在安全状态；
# 日志在 ~/.cache/personal-mods-sync.log。
set -euo pipefail
# 仓库根从脚本自身位置推导：按钮触发的安装器继承 app 的 cwd（不在本仓库），
# git rev-parse 会解析到别的仓库导致「构建产物缺失」
cd "$(dirname "$0")/.."

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

# 写自编译构建元数据（流水线构建路径与手动 --record 共用同一条写入路径）。
# 构建 ID：<version>-p<N>-<UTC 时间戳>，p<N> 为个人构建序号（历史文件行数 +1）；
# 同时追加构建历史 JSONL（官方基线 + 个人补丁栈主题），app 内更新弹窗据此
# 区分「官方更新 / 个人修改」区间（personalSelfBuiltUpdate 模块消费）。
write_build_metadata() {
  if [ ! -d "$DIST" ]; then
    fail "构建产物缺失：$PWD/$DIST"
  fi
  mkdir -p "$HOME/.zcode/v2"
  local history="$HOME/.zcode/v2/personal-mods-builds.jsonl"
  local dist_version build_number build_id official_base built_at
  dist_version=$(defaults read "$PWD/$DIST/Contents/Info.plist" CFBundleShortVersionString)
  # 构建序号以 fork 上的 personal-* tag 数为准（与 CI 发布共用同一计数器）；
  # 离线时退回本地历史文件行数（可能与远端漂移，联网构建后会自动对齐）
  build_number=$(git ls-remote --tags fork 'personal-*' 2>/dev/null | wc -l | tr -d ' ') || true
  if [ -z "$build_number" ] || [ "$build_number" = "0" ]; then
    if [ -f "$history" ]; then
      build_number=$(wc -l < "$history" | tr -d ' ')
    else
      build_number=0
    fi
  fi
  build_number=$((build_number + 1))
  build_id="${dist_version}-p${build_number}-$(date -u +%Y%m%d%H%M%S)"
  official_base=$(git rev-parse main) || fail "无法读取 main 官方基线"
  built_at=$(date -u +%FT%TZ)

  printf '%s\n' "$build_id" > "$DIST/.personal-build-id"
  printf '{\n  "version": "%s",\n  "buildId": "%s",\n  "distPath": "%s",\n  "scriptPath": "%s",\n  "repoPath": "%s",\n  "builtAt": "%s"\n}\n' \
    "$dist_version" "$build_id" "$PWD/$DIST" "$PWD/scripts/sync-personal-mods.sh" "$PWD" "$built_at" \
    > "$HOME/.zcode/v2/personal-mods-update.json"

  # main..HEAD 的提交主题即个人补丁栈；主题跨 rebase 稳定，可跨构建做集合差
  local personal_json="" sep="" subject
  while IFS= read -r subject; do
    [ -n "$subject" ] || continue
    subject=${subject//\\/\\\\}
    subject=${subject//\"/\\\"}
    personal_json+="${sep}\"${subject}\""
    sep=", "
  done < <(git log main..HEAD --pretty=format:%s)
  printf '{"buildId":"%s","builtAt":"%s","officialBase":"%s","personal":[%s]}\n' \
    "$build_id" "$built_at" "$official_base" "$personal_json" >> "$history"
}

echo "=== $(date '+%F %T') start ==="

# 等待运行中的 app 退出（安装前置步骤，--install-only / --install-remote 共用）
wait_app_exit() {
  wait_seconds="${PERSONAL_INSTALL_WAIT_MS:-90000}"
  wait_seconds=$((wait_seconds / 1000))
  for _ in $(seq 1 "$wait_seconds"); do
    pgrep -f "ZCode Preview" >/dev/null || break
    sleep 1
  done
  if pgrep -f "ZCode Preview" >/dev/null; then
    fail "应用未能退出，未替换"
  fi
}

# --record：手动 bundle 后补写构建元数据（构建 ID / 更新清单 / 构建历史），
# 不做 fetch、rebase、校验与构建
if [ "${1:-}" = "--record" ]; then
  write_build_metadata
  notify "已记录自编译构建，可在应用内点「更新」安装"
  echo "recorded $(date '+%F %T')"
  exit 0
fi

# --install-remote <zipUrl> <sha256>：下载 CI 发布的 zip，校验、剥 quarantine
# 后替换安装。下载的文件带 com.apple.quarantine xattr，不剥掉 Gatekeeper 会拦截启动
if [ "${1:-}" = "--install-remote" ]; then
  zip_url="${2:-}"
  want_sha="${3:-}"
  [ -n "$zip_url" ] && [ -n "$want_sha" ] || fail "用法：--install-remote <zipUrl> <sha256>"
  stage="$(mktemp -d)"
  curl -fsSL --retry 3 "$zip_url" -o "$stage/build.zip" || fail "下载构建包失败：$zip_url"
  echo "$want_sha  $stage/build.zip" | shasum -a 256 -c - >/dev/null || fail "sha256 校验失败，已中止安装"
  ditto -x -k "$stage/build.zip" "$stage/app" || fail "解包失败"
  xattr -dr com.apple.quarantine "$stage/app" 2>/dev/null || true
  wait_app_exit
  rm -rf "$APP"
  ditto "$stage/app" "$APP"
  rm -rf "$stage"
  echo "installed (install-remote) $(date '+%F %T')"
  open "$APP"
  notify "自编译更新已安装并重启"
  exit 0
fi

# --install-only：由 app 内「更新」按钮触发。app 正在退出，等待退出后替换并重启
if [ "${1:-}" = "--install-only" ]; then
  wait_app_exit
  if [ ! -d "$DIST" ]; then
    fail "构建产物缺失：$PWD/$DIST"
  fi
  rm -rf "$APP"
  ditto "$DIST" "$APP"
  echo "installed (install-only) $(date '+%F %T')"
  open "$APP"
  notify "自编译更新已安装并重启"
  exit 0
fi

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
# 已是最新且已安装的构建就是当前产物（ditto 保留 mtime，比较构建 ID 而非时间）
if [ "$(git rev-parse main)" = "$remote_main" ] &&
  [ "$(git merge-base main personal-mods)" = "$remote_main" ] &&
  [ -f "$DIST/.personal-build-id" ] &&
  cmp -s "$DIST/.personal-build-id" "$APP/.personal-build-id"; then
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

# 源码自上次构建后未变（dist 比最新提交还新）时跳过校验与构建，直接走安装
if [ -d "$DIST" ] &&
  [ "$(stat -f %m "$DIST")" -ge "$(git log -1 --format=%ct)" ]; then
  echo "dist newer than HEAD, skip validate+build"
else
  pnpm typecheck || fail "typecheck 未通过，未安装更新"
  pnpm lint || fail "lint 未通过，未安装更新"
  pnpm architecture:check --changed || fail "architecture check 未通过，未安装更新"

  env "${BUILD_ENV[@]}" pnpm --filter @zcode/desktop build ||
    fail "desktop build 失败，未安装更新"
  env "${BUILD_ENV[@]}" pnpm --filter @zcode/desktop bundle ||
    fail "desktop bundle 失败，未安装更新"

  write_build_metadata
fi

notify "同步构建完成，可在应用内点「更新」安装"
echo "done $(date '+%F %T')"
