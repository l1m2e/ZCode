# 个人修改分支（personal-mods）

本文件只存在于 `personal-mods` 分支，不进官方代码。用于记录本地自定义改动与同步流程。

## 分支约定

- `main`：始终等于官方 `origin/main`，不放任何本地提交；同步官方代码直接 `git pull`（fast-forward）。
- `personal-mods`：全部个人修改都提交到这里，基于最新 `main` 重放。
- 历史残留分支 `feat/session-tokens-per-second`、`backup/session-tokens-per-second` 是旧版徽章的迭代备份，已被 personal-mods 取代，可随时删除。

## 同步官方代码的流程

```bash
git checkout main
git pull origin main          # main 保持纯官方
git checkout personal-mods
git rebase main               # 个人修改重放到最新官方之上；冲突逐个解
pnpm typecheck && pnpm lint && pnpm architecture:check --changed
```

## 编译并替换本地安装的 Preview 版

```bash
# 必须带 PREVIEW 身份（app id dev.zcode.app.preview），否则会打包成
# ZCode.app 并与官方安装的 /Applications/ZCode.app 冲突。
ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1 pnpm --filter @zcode/desktop build
ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1 pnpm --filter @zcode/desktop bundle

# 替换 /Applications 里的自编译版（先退出正在运行的 ZCode Preview）
rm -rf "/Applications/ZCode Preview.app"
ditto "packages/desktop/dist/mac-arm64/ZCode Preview.app" "/Applications/ZCode Preview.app"
```

## 当前个人提交清单

| 提交 | 内容 |
| --- | --- |
| `a78d281e` | composer 工具条会话平均 tokens/s 徽章（已被 471ed0e9 取代其 UI 形态，store 逻辑并入新模块） |
| `0b743ea5` | 终端工具调用摘要显示简短中文描述（bash 工具 description 提示词中文化 + execute 渲染器适配） |
| `7759a721` | 子代理终端摘要强制简体中文：工具级描述 + 字段提示词双重声明「与对话语言无关」，修复子代理跟随任务语言输出英文；顺带补齐 tool-contracts 测试断言 |
| `471ed0e9` | dsh 风格会话统计芯片：输入框正下方居中零高行（轮/步/TPS + Token 用量/缓存命中，悬浮面板），数据来自会话事实归账（sessionStatsStore）与 usage.cumulative |

## 新增文件与架构豁免

`packages/ui/src/v4/sessionStatsStore.ts`、`packages/ui/src/v4/SessionStatsBadges.tsx`
通过 `architecture-policy.yaml` 的 `session-stats-unmanaged-new-files` 例外登记。
同步官方代码时若 `architecture-policy.yaml` 冲突，保留 exceptions 列表末尾的这条即可。
