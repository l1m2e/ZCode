# 个人修改分支（personal-mods）

本文件只存在于 `personal-mods` 分支，不进官方代码。用于记录本地自定义改动与同步流程。

## 分支约定

- `main`：始终等于官方 `origin/main`，不放任何本地提交；同步官方代码直接 `git pull`（fast-forward）。
- `personal-mods`：全部个人修改都提交到这里，基于最新 `main` 重放。
- 提交信息用中文：更新弹窗「个人修改」与 GitHub Release 说明直接取提交主题展示。
- 历史残留分支 `feat/session-tokens-per-second`、`backup/session-tokens-per-second` 是旧版徽章的迭代备份，已被 personal-mods 取代，可随时删除。

## 应用内「更新」按钮：仅本地已打包构建

不再用 launchd 定时任务。应用启动检查一次，并监听本地构建完成后原子发布的
`~/.zcode/v2/personal-mods-update.json`。只有新的有效本地 build 才显示现有更新 tag；
不访问 CI 发布清单，不下载远程更新，不自动拉起同步或构建。

运行 `scripts/sync-personal-mods.sh` 完成本地同步构建后，点现有更新按钮并确认，应用
再次校验清单、build ID 与包文件，调用 `--install-only <buildId>` 等待应用退出，直接
复制本地已打包文件到 `/Applications/ZCode Preview.app` 并重启。相同、较旧、缺失或
不完整的 build 不提示也不安装；安装器在退出等待前后再次确认该 build ID。
具体规则和验收见 [本地构建更新规格](docs/desktop/personal-local-build-update.md)。

自编译标识：关于面板 applicationVersion 显示「（自编译 p<N>，p<N> 为个人构建序号）」；
更新弹窗顶部说明「本包为自编译版本（personal-mods 分支）」。

构建元数据（`write_build_metadata`，流水线构建路径与手动 `--record` 共用同一条写入路径）：
- 构建 ID `<version>-p<N>-<UTC 时间戳>` 写入 dist app 内 `.personal-build-id`。N 以 fork 的
  `personal-*` tag 数为准（本地与 CI 共用计数器）；离线时退回历史文件行数，可能与 CI
  撞号，因此 app 只以 buildId 尾部 UTC 时间戳判断新旧，p<N> 仅展示。已装无 ID 的旧包允许升级，有 ID 但无法解析时间时不自动提示。
- 更新清单 `~/.zcode/v2/personal-mods-update.json` 额外带 `buildId`。
- 历史文件 `personal-mods-builds.jsonl` 每次构建追加一条：官方基线（`git rev-parse main`）
  + 个人补丁栈主题（`git log main..HEAD --pretty=%s`，主题跨 rebase 稳定）。

更新弹窗按真实区间组装（点亮的比对逻辑在 personalSelfBuiltUpdate）：
- 官方基线不同 → 列 `installedBase..currentBase` 官方提交（「官方更新」段）；
- 个人补丁栈按主题集合差 → 只列新增的个人提交（「个人修改」段）；
- 只有官方只显示官方，只有个人只显示个人，两者都有合并显示（官方在前）；
- 历史缺失（旧格式构建升级）退回时间戳 `git log` / 官方待装日志；都没有退回固定文案。
- 手动 bundle 后运行 `scripts/sync-personal-mods.sh --record` 补写元数据（不 fetch/构建）。

- `--install-only <buildId>`：按钮专用安装模式（复验 → 等待退出 → 再验 → 替换 → 重启）。
- 工作区有未提交的**已跟踪文件**改动时脚本跳过本次（保护未提交工作）。

手动同步的 rebase 冲突仍需人工解（脚本会自动中止并通知）；解完 `git rebase --continue`
后重新构建即可。CI 侧冲突按下方 CI 章节处理。

## 手动同步官方代码的流程（备用）

```bash
git checkout main
git pull origin main          # main 保持纯官方
git checkout personal-mods
git rebase main               # 个人修改重放到最新官方之上；冲突逐个解
pnpm typecheck && pnpm lint && pnpm architecture:check --changed
```

## CI 自动构建与远程发布（GitHub Actions，2026-11-05 起）

fork 仓库（公开）+ `personal-mods` 设为默认分支后，`.github/workflows/personal-build.yml` 接管无人值守发包：

1. **触发**：schedule 15 分钟（守卫：官方没动且 HEAD 已发布则秒退）/ push personal-mods / 手动 dispatch。push 带 paths 过滤——只有 `packages/**` 等业务代码变更才构建，纯文档（`**/*.md`）与流水线（`.github/**`、`scripts/**`）改动不触发；schedule 不受 paths 影响。concurrency 串行化且不取消进行中的构建（`cancel-in-progress: false`，避免长构建被重叠触发掐死；排队的重复 run 由守卫秒退）。
2. **流程**：rebase 到官方 main（CI 会 force-push 回远端分支，本地 pull --rebase 跟进）→ 校验 → macos-latest 构建 → `--record` 写元数据 → `publish-personal-release.sh` 发 Release；随后 windows job 对同一 HEAD 构建 NSIS x64 追加上传。
3. **产物**：Release 保留 zip/dmg + `personal-update.json`（version/buildId/zipUrl/sha256/officialBase/personal[]）以及 Windows NSIS x64 安装包，供别人手动下载安装。构建 ID 在 Record 后补注进 zip，dmg 不含构建 ID。
4. **与应用隔离**：CI 发包保留，应用不消费远程清单；远程发布不会覆盖本地待装 build 或点亮更新 tag。
5. **注意**：Actions 定时任务在仓库 60 天无活动后自动停用；CI rebase 冲突时 job 失败，按手动同步流程在本地解。

## 手动安装 CI 产物（浏览器下载）

浏览器下载的未签名 CI 包可能被 Gatekeeper 拦截；确认下载来源后，可手动处理：

```bash
# dmg 拖进应用程序后启动报「已损坏」时
xattr -dr com.apple.quarantine "/Applications/ZCode Preview.app"
open "/Applications/ZCode Preview.app"
```

zip 完整手动替换流程：

```bash
ditto -x -k ~/Downloads/ZCode.Preview-*-mac-arm64.zip "$TMPDIR/zp"
xattr -dr com.apple.quarantine "$TMPDIR/zp/ZCode Preview.app"
osascript -e 'quit app "ZCode Preview"' >/dev/null 2>&1 || true; sleep 3
rm -rf "/Applications/ZCode Preview.app"
ditto "$TMPDIR/zp/ZCode Preview.app" "/Applications/ZCode Preview.app"
open "/Applications/ZCode Preview.app"
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

## 2026-11-23 同步（官方 fec97590 v3.18.2 → a4b44451 v4.0.0）冲突解法记录

- 官方从 v3.18.2 直接跳 v4.0.0，改 2209 个文件（+149753/-24801）。个人栈 61 个提交
  重放，8 轮冲突 + typecheck 暴露 4 处重放损伤，适配修复集中在一个提交
  （fix: 适配官方 v4.0.0 的重放修复）。
- `architecture-policy.yaml` ×2：官方新增 shortcuts、workspace-plugin-trust、
  workspace-plugin-declaration、windows-git-bash-discovery 四个 managed 模块与大量
  unmanaged 豁免；照例官方在前、个人 git-review / code-comment / session-stats 置末。
- `bash-prompt.ts`：官方 v4.0.0 重写 `cd` 语义行（主会话内成功执行才延续目录）；个人
  「description 一律简体中文」行保留在前并存。`tool-contracts.test.ts` 官方重构删除了
  工具级 description 逐字断言的旧测试，中文行断言以聚焦用例承接新家；字段级中文提示词
  断言（properties.description.description）自动合并保留。
- Git 审查 E2E（`conversation-session-git-review-entry.test.ts`）：官方重写 SP13 中段
  （composer 聚焦断言 + 分支菜单交互 + 重开 review）并新增「整轮刷新」用例。合并顺序：
  个人 split 断言（detail 态）→ 官方交互段（4→6 空格缩进放进 try）→ 衔接
  `clickGitReviewFileRow` + `waitForGitReviewDiffContent` 恢复评论流程依赖的 diff 态。
  两个完整用例同位插入时注意官方块的 `finally {` 需补闭合。官方已删
  `TID_CHAT_SUMMARY_PANEL` 与旧 label 常量，失效 import/常量一并清理。
- `ConversationTurnGroup.tsx`：**官方 v4.0.0 原生实现了「会话编辑审查展示历史全文」外壳**
  （historyContainer / CollapsedChangeSummary / getAssistantSummaryChangeFiles 全套），
  个人 a3f51800 只保留增量：onOpenFile 处并入 `withHistoricalDiffSource`（打开变更文件
  带历史版本上下文，依赖 `sourceRows`，该字段个人改动已并入官方同名函数）。
- 遥测类型：v4.0.0 把 `ModelRequestMetricsFact` 移出 wire `ConversationTelemetryFact`
  union（走独立通知，旧 App 不解析），基类 `handleFact` 入参放宽为
  `ConversationTelemetryInput`。个人 supervisor 覆写与 sessionStatsStore 归账签名同步
  放宽；TPS/TTFT 数据源不受影响。
- `ConversationTimeline.tsx`：v4.0.0 删除 status panel inline 偏移体系
  （`summaryPanelInlineOffsetClassName`、`getConversationStatusPanelOffsetClassName`），
  面板不再挤压消息列。个人统计条 bottomStrip 只复用 `contentWidthClassName` 即与输入框
  同中心；presentation E2E 保留官方新几何合同（hasNormalColumnLayout）+ 个人
  statsCenterError 断言（expectCapsuleLayout 内），旧 expectMiniPanelLayout 无宿主随官方
  删除。
- rebase 后 freshness 守卫会因本地与 fork 远端分叉拒绝 `--record`：按 CI 同款约定
  `git push fork personal-mods --force-with-lease` 同步远端后重跑即可。
- 验证：typecheck 0 错误；lint 0 错误、525 警告（较 v3.18.2 基线 526 降 1，个人改动
  零新增）；architecture:check --changed OK（9 条全在基线，0 新增）。
- 本地构建 `4.0.0-p26-20261123143912` 已发布更新清单；官方 /Applications/ZCode.app 在
  源码同步前已通过内部通道升到 3.19.0（源码仓库 11-23 才放出 v4.0.0）。

## 2026-11-16 同步（官方 b95ebaf v3.18.0 → fec97590 v3.18.2）冲突解法记录

- 官方 v3.18.1/v3.18.2 共改 148 个文件：新增 `memory-diagnostics` 模块（adapters/bootstrap/
  shared 三层）、系统凭据存储扩展、macOS 字体平滑、Windows 安装器改造等。rebase 后照例先
  `pnpm install --frozen-lockfile`。
- 冲突面很小（个人栈 55 个提交重放，仅 2 个文件 3 处冲突）：
  - `packages/ui/src/store/index.ts`（两处，分别来自「代码字体」与「Git 审查设置」提交）：
    官方 v3.18.2 新增 `FONT_SMOOTHING_STORAGE_KEY` / `applyFontSmoothing`（macOS 字体平滑），
    与个人 `applyCodeFontFamily`、`GIT_REVIEW_SETTINGS_KEY` 同区新增，并存即可，官方在前。
  - `architecture-policy.yaml`：官方 v3.18.1 新增 `cli-memory-diagnostics` managed 模块
    （architecture:adopt 登记），与个人 `git-review` / `code-comment` 两模块并存，官方在前。
    本次无 exceptions 冲突。
- 自动合并但同区敏感的文件：`v4-gateway.ts`（官方 4 行 vs 个人 firstTokenAt）、i18n 五语言
  文件、`App.tsx`、`WorkspaceShellLayout.tsx`、`shared/index.ts`、`platform.ts`、
  `test-ids.ts`、desktop `main/index.ts`、`wdio.conf.ts`、`settingsSearchIndex.ts`、
  `settingsCodePreview.tsx`——全部由 typecheck 背书。
- 验证结果：根 typecheck 通过；CLI contracts/core/adapters/bootstrap 逐包 tsc 通过
  （bootstrap 首跑报 `@zcode/adapters/memory-diagnostics` 找不到——官方新模块，构建
  adapters dist 后通过，与「CLI 包间依赖走 dist」同因）；lint 0 错误；**oxlint 警告基线
  从 84 涨到 526**，全部来自官方 v3.18.1/3.18.2 自带文件（191 个文件，多为新增测试），
  对照实验：11 个个人/官方交集文件在官方 main 上 73 条 vs 本分支 69 条，个人改动零新增
  警告，不要试图清零；`architecture:check --changed` OK（9 条全部已在基线，0 新增）。
- 并发注意：本会话同步期间，另一会话把源码面板 WIP 提交为「feat(git): 新增多目录源代码
  管理面板」并继续产出新 WIP；本轮 rebase 将该提交一并重放（新 SHA），stash 的后批 WIP
  已原样恢复。多会话并行时 rebase 前先确认无他会在写。

## 2026-11-11 同步（官方 a9fe401e v3.17.2 → b95ebaf v3.18.0）冲突解法记录

- 官方改了 51 个 `package.json` 与 lockfile（新增 `@napi-rs/keyring`、`@zcode/design-runtime`
  等），rebase 后必须先 `pnpm install --frozen-lockfile` 再 typecheck，否则报模块找不到。
- `execute.tsx`：官方 v3.18.0 **原生支持** description 摘要展示（`description` 变量 +
  `hideSecondaryTextWhenOpen`），与个人「终端摘要中文描述」提交同一意图且实现更完整。
  冲突的 title 行取官方实现；`bash.ts` 中文提示词自动合并保留，意图不受损。
- `architecture-policy.yaml`：照旧保留官方全部新豁免条目，个人两条
  （`session-stats-unmanaged-new-files`、`self-built-update-personal-files`）置末。
- `ConversationComposer.tsx`：官方新增 `ComposerStatusSlot` import 与个人
  `SessionStatsBadges` import 并存。
- `ConversationTurnGroup.tsx`：官方把轮尾区域整体加深缩进（新父级包裹）并给
  `ConversationAssistantTextActions` 增加 `turnId`/`sourceCommandIds` props；个人
  `SessionCreateTurnCards` 按官方缩进插回 `OffPeakTurnCards` 之后，删除个人侧重复块。
- `App.tsx`：官方把 `WorkspaceShellLayout` 包进新 `ExtensionViewsProvider`（扩展视图标签）。
  个人 `handleOpenSideChat` / `handleSideChatSessionCreated` 两个 props 插回
  `handleOpenSelectionSideChat` 之后，其余全取官方。
- `runtime-tools.ts` / `call-runner.ts` / `handlers/index.ts`：官方
  `includeTopicResource` / `pluginDiscoveryPort` 与个人 `includeSessionCreate` /
  `sessionSpawnPort` / `taskType` 并存（官方新功能与个人 CreateSession 同区域新增）。
- `engineering-test-files.json`：三方条目合并——个人 `sidePaneSideChatTabs.test.ts` +
  官方新增 `plugin-api/version`、`server/remoteOfficialPluginAssets`。
- **架构门禁新知**：rebase 后 `--changed` 的 base 是 merge-base(HEAD, fork/personal-mods)
  = 旧官方基线，首次真实扫到「官方 v3.18.0 + 个人」全量闭包。个人改过的官方存量文件
  （`diffsHighlighterEngine.ts`）不满足上游 pristine 准入，用
  `node scripts/architecture/architecture-check.mjs baseline:update --changed`
  登记进基线（新格式 `{version, violations}`，旧版是裸数组，工具两种都读）。
  注意：**未跟踪的临时文件会被算进 unmanaged-new-file**——收工前清理 `.tmp-*` 探针，
  否则基线会收进垃圾条目（updateBaseline 只替换闭包内条目，删文件后旧条目仍留存，
  需手改 JSON 移除）。
- fmt 上游漂移：官方 v3.18.0 自带约 1553 个文件不满足新 `.oxfmtrc.json`（含
  architecture-policy.yaml 的 flow-map 空格风格）。fmt 不在门禁链内，**不代官方全量
  格式化**（会造成每次同步的无谓冲突），只保持个人新增内容整洁。
- **命名冲突（本次同步最大的坑）**：官方 v3.18.0 session-control 工具族新增同名
  `CreateSession`（创建根会话+首条 prompt，CLI/App 两变体）。`registerBuiltInTools`
  里命中 `SESSION_CONTROL_TOOL_NAMES` 的内置项在未指定 sessionControlKind 时直接
  `continue`——个人同名工具在真实运行时（CLI/App 都设 kind）被**静默遮蔽失效**，
  仅 `session-create-tool.test.ts` 直连注册表的用例能暴露。经用户拍板，个人工具更名
  **`SpawnSession`**（常量 `SPAWN_SESSION_TOOL_NAME`）：内部 schema/类型名
  （`CreateSessionInputSchema` 等）与文件名（session-create.ts/tsx）保留不动，只改
  工具身份面（常量、工具名值、15 处字面量、UI 归一化名 `spawnsession`、注释与
  21-session-create.md）。automation / off-peak 禁用清单同步改名。
  遗留观察：官方 CreateSession 本身未进 AUTOMATION_MUTATION_TOOL_NAMES /
  OFF_PEAK_MUTATION_TOOL_NAMES——automation/off-peak 轮经官方工具建根会话是否该禁，
  归官方规则管，个人分支不代管。

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

审查面板 VS Code 式改造（spec: `docs/git-review-split-layout.md`）通过两个 managed 模块登记，
不新增 `unmanaged-new-file` 例外：

- `git-review`：`packages/ui/src/GitPane/`、精确文件 `GitPane.tsx` 与
  `lib/gitReviewSettings.ts`，包含审查 UI owner、子组件和纯偏好定义。
- `code-comment`：`packages/ui/src/code-comment/` 放契约四件套，精确登记
  `components/ui/code-comment.tsx`，供审查与文件预览共用。

同步时保留这两个 modules 条目及各自 `module.ts`、`contract.ts`、`contract.example.ts`、
`CONTRACT.md`，公开入口只包含既有挂载/纯偏好/共享组件入口与 contract；不扩大到整个
`components/ui`、`lib` 或 store。`ui` 仍是 legacy，架构检查通过不代表其余 UI、
持久化与远程运行时语义已整体受管。此前本任务误用 `baseline:update` 产生的 4 条新增和
2 条原有删除已撤回，保留原有基线；本次不用基线更新接受新问题。
