# 个人修改分支（personal-mods）

本文件只存在于 `personal-mods` 分支，不进官方代码。用于记录本地自定义改动与同步流程。

## 分支约定

- `main`：始终等于官方 `origin/main`，不放任何本地提交；同步官方代码直接 `git pull`（fast-forward）。
- `personal-mods`：全部个人修改都提交到这里，基于最新 `main` 重放。
- 历史残留分支 `feat/session-tokens-per-second`、`backup/session-tokens-per-second` 是旧版徽章的迭代备份，已被 personal-mods 取代，可随时删除。

## 全自动同步（2026-10-30 起）

`scripts/sync-personal-mods.sh`（仅存在于 personal-mods 分支）+ launchd 定时任务
`dev.zcode.personal-mods-sync`（`~/Library/LaunchAgents/`，每 4 小时触发）自动完成：
fetch 官方 → main fast-forward → rebase personal-mods → install/typecheck/lint/architecture
→ 构建 → 替换 `/Applications/ZCode Preview.app`（运行中会先退出-替换-重启）。
任一步失败弹系统通知并停在安全状态；日志在 `~/.cache/personal-mods-sync.log`。

- `SYNC_INSTALL=0`：只构建不替换（验证流水线，不打断运行中的 app）。
- `RESTART_RUNNING=0`：应用运行中时跳过替换。
- fetch 连续 3 次失败（直连 github 抖动，脚本已用 HTTP/1.1 规避 HTTP2 framing layer 错误）
  会降级用缓存的 `origin/main` 继续跑，弱网下只是可能滞后一轮。
- 工作区有未提交的**已跟踪文件**改动时跳过本次（保护未提交工作）；脚本本身未提交不影响。
- 停用定时任务：`launchctl bootout gui/$(id -u)/dev.zcode.personal-mods-sync`。

rebase 冲突仍需人工解（脚本会自动中止并通知）；解完 `git rebase --continue` 后重跑脚本即可。

## 手动同步官方代码的流程（备用）

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

注意：自编译 Preview（flavor=preview）在编译期就没有更新器
（`index.ts` 里 `enabled: flavor === "production" && ZCODE_AUTO_UPDATE_ENABLED`，
菜单项也只在 production flavor 渲染），不会被 app 内「检查更新」覆盖；
`/Applications/ZCode.app` 官方正式版的自动更新与本分支无关。

## 当前个人提交清单

| 提交 | 内容 |
| --- | --- |
| `19b0abe5` | composer 工具条会话平均 tokens/s 徽章（已被 f315f8c0 取代其 UI 形态，store 逻辑并入新模块） |
| `e85a7046` | 终端工具调用摘要显示简短中文描述（bash 工具 description 提示词中文化 + execute 渲染器适配） |
| `e6606841` | 子代理终端摘要强制简体中文：工具级描述 + 字段提示词双重声明「与对话语言无关」，修复子代理跟随任务语言输出英文；顺带补齐 tool-contracts 测试断言 |
| `2a2462ff` | 会话统计 TPS 分母改用 CLI 权威「首包→完成」窗口（dsh 同口径）：ModelComplete 载荷带 firstTokenAt 随 usage.delta 下发，修复 chunk 事实到达不完整导致的 TPS 虚高几十倍；TTFT 同步受益 |
| `f315f8c0` | dsh 风格会话统计芯片：输入框正下方居中零高行（轮/步/TPS + Token 用量/缓存命中，悬浮面板），数据来自会话事实归账（sessionStatsStore）与 usage.cumulative |
| `88712019` | 修复 2026-10-30 rebase 自动合并丢失的 `V4ComposerToolbar` sessionId 解构（官方新增 sessionConfigPending 依赖它） |

## 2026-10-30 同步（官方 3c5b2276 → a60ba6a7）冲突解法记录

- `conversationTelemetrySupervisor.ts`：官方把遥测重写为 `ConversationTelemetryEngine`
  （shared）+ observers 架构。个人挂钩改为覆写 `handleFact`：先 `noteConversationFactForSessionStats(fact)`
  再 `super.handleFact(fact)`。因为挂在引擎去重（`eventIds` private）之前，
  `sessionStatsStore` 改为**自行去重**：同口径 `sessionId\0eventId` 有界集合（容量 2000，
  同引擎 `MAX_DEDUPE_KEYS`），文档契约从「消费已去重事实」改为「自行去重」。
- `architecture-policy.yaml`：保留官方全部新豁免条目，末尾保留
  `session-stats-unmanaged-new-files`（既有约定）。
- bash 工具 description 提示词：保留中文版，官方新增的「不要照抄命令原文/参数/路径」
  指引意译为中文并入；`tool-contracts.test.ts` 断言与最终提示词逐字对齐。
- 官方删除了 `packages/ui/test/executeToolCallBlock.test.tsx` 与
  `packages/shared/test/zcodeProtocolV4Telemetry.test.ts`（测试体系重构：UI 转 browser
  fixture，shared 协议测试并入 bootstrap）：
  - firstTokenAt schema 断言移植到
    `apps/zcode-cli/packages/bootstrap/tests/v4-gateway.test.ts` 的 usage fact 用例
    （ModelComplete 带 firstTokenAt → gateway 透传到 fact）。
  - **待办**：execute 渲染器中文描述的渲染断言暂无新家；
    `packages/ui/test/sessionStatsStore.test.ts` 也不在任何 vitest workspace project 里，
    需要接入官方新测试体系后恢复。

## 新增文件与架构豁免

`packages/ui/src/v4/sessionStatsStore.ts`、`packages/ui/src/v4/SessionStatsBadges.tsx`
通过 `architecture-policy.yaml` 的 `session-stats-unmanaged-new-files` 例外登记。
同步官方代码时若 `architecture-policy.yaml` 冲突，保留 exceptions 列表末尾的这条即可。
