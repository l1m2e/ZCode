# 个人修改分支（personal-mods）

本文件只存在于 `personal-mods` 分支，不进官方代码。用于记录本地自定义改动与同步流程。

## 分支约定

- `main`：始终等于官方 `origin/main`，不放任何本地提交；同步官方代码直接 `git pull`（fast-forward）。
- `personal-mods`：全部个人修改都提交到这里，基于最新 `main` 重放。
- 历史残留分支 `feat/session-tokens-per-second`、`backup/session-tokens-per-second` 是旧版徽章的迭代备份，已被 personal-mods 取代，可随时删除。

## 应用内「更新」按钮：与官方一致的自编译更新链路（2026-10-30 起）

不再用 launchd 定时任务。检查/构建/安装全部由**运行中的 app** 驱动，节奏与官方更新器一致：

1. **检查（15 分钟一次，同官方轮询间隔）**：`packages/desktop/src/main/personalSelfBuiltUpdate.ts`
   用 `git ls-remote`（HTTP/1.1，廉价 ref 查询）比对官方 GitHub main；**没新提交不触发任何
   构建与合并**；有新提交才拉起 `scripts/sync-personal-mods.sh`（detached，日志
   `~/.cache/personal-mods-sync.log`）。
2. **构建**：脚本 fetch → main fast-forward → rebase personal-mods → install/校验 →
   构建 dist → 写更新清单 `~/.zcode/v2/personal-mods-update.json` 与构建 ID
   `$DIST/.personal-build-id`。脚本**不安装**，源码没变时跳过校验与构建。
3. **点亮**：主进程每轮检查后比对 dist 与已安装 app 的构建 ID，发现新构建即点亮现成的
   更新胶囊（复用官方更新 UI：胶囊 → 更新日志弹窗 → 「立即重启更新」确认框）。
4. **安装**：点击确认 → 拉起 `sync-personal-mods.sh --install-only`（等待 app 退出 →
   ditto 替换 → 自动重启）。

自编译标识：关于面板 applicationVersion 显示「（自编译 p<N>，p<N> 为个人构建序号）」；
更新弹窗顶部说明「本包为自编译版本（personal-mods 分支）」。

构建元数据（`write_build_metadata`，流水线构建路径与手动 `--record` 共用同一条写入路径）：
- 构建 ID `<version>-p<N>-<UTC 时间戳>` 写入 dist app 内 `.personal-build-id`，N 为
  `~/.zcode/v2/personal-mods-builds.jsonl` 的行数 +1。
- 更新清单 `~/.zcode/v2/personal-mods-update.json` 额外带 `buildId`。
- 历史文件 `personal-mods-builds.jsonl` 每次构建追加一条：官方基线（`git rev-parse main`）
  + 个人补丁栈主题（`git log main..HEAD --pretty=%s`，主题跨 rebase 稳定）。

更新弹窗按真实区间组装（点亮的比对逻辑在 personalSelfBuiltUpdate）：
- 官方基线不同 → 列 `installedBase..currentBase` 官方提交（「官方更新」段）；
- 个人补丁栈按主题集合差 → 只列新增的个人提交（「个人修改」段）；
- 只有官方只显示官方，只有个人只显示个人，两者都有合并显示（官方在前）；
- 历史缺失（旧格式构建升级）退回时间戳 `git log` / 官方待装日志；都没有退回固定文案。
- 手动 bundle 后运行 `scripts/sync-personal-mods.sh --record` 补写元数据（不 fetch/构建）。

- `--install-only`：按钮专用安装模式（等待退出 → 替换 → 重启）。
- 工作区有未提交的**已跟踪文件**改动时脚本跳过本次（保护未提交工作）。
- 官方检查失败（网络/GitHub 不可达）静默跳过本轮，不做任何合并。

rebase 冲突仍需人工解（脚本会自动中止并通知）；解完 `git rebase --continue` 后等下一轮
检查或在 app 内重试即可。

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
