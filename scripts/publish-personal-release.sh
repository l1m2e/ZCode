#!/bin/bash
# CI 专用（.github/workflows/personal-build.yml 调用）：发布 GitHub Release。
# 消费 sync-personal-mods.sh --record 写入的元数据（更新清单 + 构建历史），
# 上传 zip/dmg + personal-update.json 发布清单；app 轮询
# /releases/latest/download/personal-update.json 比对 buildId 点亮更新。
set -euo pipefail
cd "$(dirname "$0")/.."

DIST="packages/desktop/dist/mac-arm64/ZCode Preview.app"
UPDATE_MANIFEST="$HOME/.zcode/v2/personal-mods-update.json"
BUILD_HISTORY="$HOME/.zcode/v2/personal-mods-builds.jsonl"

fail() {
  echo "[publish-personal-release] $1"
  exit 1
}

command -v gh >/dev/null || fail "gh 不可用"
[ -f "$UPDATE_MANIFEST" ] || fail "更新清单缺失：先运行 sync-personal-mods.sh --record"
[ -f "$DIST/.personal-build-id" ] || fail "构建 ID 缺失：先运行 sync-personal-mods.sh --record"

zip_path=$(ls -t packages/desktop/dist/ZCode\ Preview-*-mac-arm64.zip | head -1)
[ -n "$zip_path" ] || fail "zip 产物缺失"
dmg_path=$(ls -t packages/desktop/dist/ZCode\ Preview-*-mac-arm64.dmg | head -1 || true)

version=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version" "$UPDATE_MANIFEST")
build_id=$(cat "$DIST/.personal-build-id")
# tag 必须以 personal- 开头：构建序号 p<N> 靠统计 personal-* tag 数生成，
# 前缀丢了计数器就永远不涨
tag="personal-$build_id"
zip_name=$(basename "$zip_path")
zip_url="https://github.com/${GITHUB_REPOSITORY}/releases/download/${tag}/${zip_name}"
sha256=$(shasum -a 256 "$zip_path" | cut -d' ' -f1)
size=$(stat -f %z "$zip_path")
built_at=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).builtAt" "$UPDATE_MANIFEST")

# 官方基线 + 个人补丁栈主题：--record 追加的历史尾行就是本次构建的记录
official_base=$(git rev-parse main)
personal=$(git log main..HEAD --pretty=%s | jq -R -s -c 'split("\n")|map(select(length>0))')

release_manifest=$(jq -n \
  --arg version "$version" \
  --arg buildId "$build_id" \
  --arg tag "$tag" \
  --arg zipUrl "$zip_url" \
  --arg sha256 "$sha256" \
  --arg builtAt "$built_at" \
  --arg officialBase "$official_base" \
  --argjson size "$size" \
  --argjson personal "$personal" \
  '{version:$version, buildId:$buildId, tag:$tag, zipUrl:$zipUrl, sha256:$sha256, size:$size, builtAt:$builtAt, officialBase:$officialBase, personal:$personal}')

tmp=$(mktemp -d)
printf '%s\n' "$release_manifest" > "$tmp/personal-update.json"

notes=$(git log --oneline --no-merges "$(git tag --list 'personal-*' --sort=-creatordate | head -1)..HEAD" 2>/dev/null | head -30)
[ -n "$notes" ] || notes="personal build $build_id"

# fork 仓库里同时存在 origin（fork）与 upstream（官方），gh 默认会解析到上游父仓库；
# GITHUB_TOKEN 只有 fork 权限，必须显式指定 --repo 避免 403
gh release create "$tag" "$zip_path" --repo "$GITHUB_REPOSITORY" --title "$tag" --notes "$notes"
gh release upload "$tag" "$tmp/personal-update.json" --repo "$GITHUB_REPOSITORY" --clobber
if [ -n "${dmg_path:-}" ]; then
  gh release upload "$tag" "$dmg_path" --repo "$GITHUB_REPOSITORY" --clobber
fi
rm -rf "$tmp"
echo "published $tag"
