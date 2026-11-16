#!/bin/bash
# personal-mods 专用（见 LOCAL-MODS.md）：同步官方代码并重编译构建产物。
# 手动运行；应用只检查本地完成的构建，不触发同步。流程：
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
  # 本地远端名叫 fork，CI 里叫 origin，依次尝试；离线时退回本地历史文件行数
  build_number=""
  for remote in fork origin; do
    # CI 上没有 fork 远端，ls-remote 必然失败；pipefail 下必须 || true 兜住，
    # 否则 set -e 会在第一个不存在的远端上直接终止脚本
    tags=$(git ls-remote --tags "$remote" 'personal-*' 2>/dev/null || true)
    # BRE 里 {} 本就是字面量；写 \{\} 在 BSD sed（macOS/CI）会被当区间量词报错
    build_number=$(printf '%s\n' "$tags" | awk 'NF {print $2}' | sed 's/\^{}$//' | sort -u | wc -l | tr -d ' ')
    [ -n "$build_number" ] && [ "$build_number" != "0" ] && break
    build_number=""
  done
  if [ -z "$build_number" ] && [ -f "$history" ]; then
    build_number=$(wc -l < "$history" | tr -d ' ')
  fi
  [ -n "$build_number" ] || build_number=0
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
  # 记录本次产物的源码 HEAD：守卫据此判断 dist 是否构建自当前 personal-mods
  git rev-parse HEAD > "$DIST/.personal-build-head"
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
  # 历史与产物完成后原子发布清单，watch 不会读到半写入 JSON。
  local manifest_tmp
  manifest_tmp=$(mktemp "$HOME/.zcode/v2/.personal-mods-update.XXXXXX")
  printf '{\n  "version": "%s",\n  "buildId": "%s",\n  "distPath": "%s",\n  "scriptPath": "%s",\n  "repoPath": "%s",\n  "builtAt": "%s"\n}\n' \
    "$dist_version" "$build_id" "$PWD/$DIST" "$PWD/scripts/sync-personal-mods.sh" "$PWD" "$built_at" \
    > "$manifest_tmp"
  mv -f "$manifest_tmp" "$HOME/.zcode/v2/personal-mods-update.json"
}

echo "=== $(date '+%F %T') start ==="

# 等待运行中的 app 退出（--install-only 的前置步骤）。
# 优先用 app 拉起安装器时注入的 APP_PID 做 kill -0 探测：旧的 pgrep -f "ZCode Preview"
# 会误匹配进程标题里内嵌 PATH（含 "ZCode Preview.app" 字样）的 zcode-cli/MCP 等
# 存活子进程，导致等待超时放弃安装；无 APP_PID（手动调用）时退回 pgrep。
wait_app_exit() {
  wait_seconds="${PERSONAL_INSTALL_WAIT_MS:-90000}"
  wait_seconds=$((wait_seconds / 1000))
  if [ -n "${APP_PID:-}" ]; then
    for _ in $(seq 1 "$wait_seconds"); do
      kill -0 "$APP_PID" 2>/dev/null || return 0
      sleep 1
    done
    fail "应用未能退出（pid $APP_PID），未替换"
  fi
  for _ in $(seq 1 "$wait_seconds"); do
    pgrep -f "ZCode Preview" >/dev/null || return 0
    sleep 1
  done
  fail "应用未能退出，未替换"
}

# --record：手动 bundle 后补写构建元数据（构建 ID / 更新清单 / 构建历史），
# 不做 fetch、rebase、校验与构建
if [ "${1:-}" = "--record" ]; then
  write_build_metadata
  notify "已记录自编译构建，可在应用内点「更新」安装"
  echo "recorded $(date '+%F %T')"
  exit 0
fi

# --install-only：由 app 内「更新」按钮触发。app 正在退出，等待退出后替换并重启
if [ "${1:-}" = "--install-only" ]; then
  expected_build_id="${2:-}"
  [ -n "$expected_build_id" ] || fail "用法：--install-only <buildId>"
  # 按按钮复验的 ID 固定候选；等待退出期间若重建，不能安装另一份未经确认的包。
  verify_install_candidate() {
    [ -f "$DIST/.personal-build-id" ] || fail "构建 ID 缺失"
    [ "$(cat "$DIST/.personal-build-id")" = "$expected_build_id" ] || fail "构建已变化，请重新检查更新"
    for file in "Contents/Info.plist" "Contents/MacOS/ZCode Preview" "Contents/Resources/app.asar"; do
      [ -f "$DIST/$file" ] || fail "构建产物不完整：$file"
    done
  }
  verify_install_candidate
  wait_app_exit
  verify_install_candidate
  rm -rf "$APP"
  ditto "$DIST" "$APP"
  echo "installed (install-only) $(date '+%F %T')"
  open "$APP"
  notify "自编译更新已安装并重启"
  exit 0
fi

# 未知入口必须在同步流程前拒绝，避免已移除选项意外触发 fetch/rebase/build。
[ "$#" -eq 0 ] || fail "未知参数：$1（支持 --record 或 --install-only <buildId>）"

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
# 已是最新且已安装的构建就是当前产物（ditto 保留 mtime，比较构建 ID 而非时间）。
# 还必须校验产物构建自当前 personal-mods HEAD：2026-11-06 实测分支新增提交后
# 守卫只比官方基线与「dist==已装」，把陈旧产物误判为最新直接跳过重建
if [ "$(git rev-parse main)" = "$remote_main" ] &&
  [ "$(git merge-base main personal-mods)" = "$remote_main" ] &&
  [ -f "$DIST/.personal-build-id" ] &&
  cmp -s "$DIST/.personal-build-id" "$APP/.personal-build-id" &&
  [ "$(cat "$DIST/.personal-build-head" 2>/dev/null)" = "$(git rev-parse personal-mods)" ]; then
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

# mtime 会被复制或目录写入改变，不能证明源码一致；只复用已记录同一 HEAD 的完整包。
if [ -f "$DIST/.personal-build-id" ] &&
  [ -f "$DIST/Contents/Resources/app.asar" ] &&
  [ "$(cat "$DIST/.personal-build-head" 2>/dev/null)" = "$(git rev-parse HEAD)" ]; then
  echo "dist matches HEAD, skip validate+build"
else
  pnpm typecheck || fail "typecheck 未通过，未安装更新"
  pnpm lint || fail "lint 未通过，未安装更新"
  pnpm architecture:check --changed || fail "architecture check 未通过，未安装更新"

  # 先撤销旧产物 ID：构建失败或正在覆盖包内容时，不允许旧清单继续点亮或安装。
  rm -f "$DIST/.personal-build-id" "$HOME/.zcode/v2/personal-mods-update.json"
  env "${BUILD_ENV[@]}" pnpm --filter @zcode/desktop build ||
    fail "desktop build 失败，未安装更新"
  env "${BUILD_ENV[@]}" pnpm --filter @zcode/desktop bundle ||
    fail "desktop bundle 失败，未安装更新"

  write_build_metadata
fi

notify "同步构建完成，可在应用内点「更新」安装"
echo "done $(date '+%F %T')"
