# 个人修改分支（personal-mods）

本文件只存在于 `personal-mods` 分支，不进官方代码。用于记录本地自定义改动与同步流程。

## 分支约定

- `main`：始终等于官方 `origin/main`，不放任何本地提交；同步官方代码直接 `git pull`（fast-forward）。
- `personal-mods`：全部个人修改都提交到这里，基于最新 `main` 重放。
- 提交信息用中文：更新弹窗「个人修改」与 GitHub Release 说明直接取提交主题展示。
- 历史残留分支 `feat/session-tokens-per-second`、`backup/session-tokens-per-second` 是旧版徽章的迭代备份，已被 personal-mods 取代，可随时删除。

## 应用内「更新」按钮：自编译更新链路（2026-10-30 起；2026-11-05 改为远程唯一自动通道）

不再用 launchd 定时任务。检查/安装由**运行中的 app** 驱动：

1. **远程通道（唯一自动更新源）**：`packages/desktop/src/main/personalSelfBuiltUpdate.ts`
   每 60 秒轮询 CI 发布清单（见下方 CI 章节），buildId 比已安装新即点亮更新胶囊
   （复用官方更新 UI：胶囊 → 更新日志弹窗 → 「立即重启更新」确认框）；点击确认走
   `sync-personal-mods.sh --install-remote <zipUrl> <sha256>`。
2. **本地构建源（仅手动构建）**：不做启动检查、不做周期轮询、不再拉起官方同步构建
   （官方同步归 CI schedule 负责）。只有自己运行 `scripts/sync-personal-mods.sh` 构建完成、
   写入更新清单 `~/.zcode/v2/personal-mods-update.json` 与构建 ID `$DIST/.personal-build-id`
   时，manifest watch 立即点亮；点击确认走 `--install-only`（等待 app 退出 → ditto 替换 →
   自动重启）。脚本**不安装**，源码没变时跳过校验与构建。

自编译标识：关于面板 applicationVersion 显示「（自编译 p<N>，p<N> 为个人构建序号）」；
更新弹窗顶部说明「本包为自编译版本（personal-mods 分支）」。

构建元数据（`write_build_metadata`，流水线构建路径与手动 `--record` 共用同一条写入路径）：
- 构建 ID `<version>-p<N>-<UTC 时间戳>` 写入 dist app 内 `.personal-build-id`。N 以 fork 的
  `personal-*` tag 数为准（本地与 CI 共用计数器）；离线时退回历史文件行数，可能与 CI
  撞号，因此 app 端序号相同时以 buildId 尾部 UTC 时间戳决胜（见 CI 章节第 4 条）。
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
3. **产物**：Release = zip/dmg + `personal-update.json`（version/buildId/zipUrl/sha256/officialBase/personal[]）+ Windows NSIS 安装包（x64，未签名，`windows` job 在 mac job 后对同一 HEAD 构建并追加上传；仅供手动下载安装，app 内绿点与 `--install-remote` 自动更新是 macOS 专属，不消费 win 资产）。构建序号 p<N> 以仓库 `personal-*` tag 数为准，本地与 CI 共用同一计数器。构建 ID 由 Record 步骤后补注进 zip（dmg 不含，手动装 dmg 的 app 无构建号，走一次远程自动更新即补齐）。
4. **app 消费**：`personalSelfBuiltUpdate.ts` 的 `PERSONAL_UPDATE_MANIFEST_URL` 填入后，60 秒轮询 `releases/latest/download/personal-update.json`；防回退比对用「p<N> 序号（补零）+ 尾部 UTC 时间戳」排序键——序号更大即点亮，序号相同（本地历史行数计数与 CI tag 计数撞号）时时间戳必须严格更新才点亮；点更新走 `sync-personal-mods.sh --install-remote <zipUrl> <sha256>`（下载 → sha256 校验 → 剥 quarantine → 替换重启）。URL 留空 = 远程通道关闭，只剩手动构建的 watch 点亮。
5. **注意**：Actions 定时任务在仓库 60 天无活动后自动停用；CI rebase 冲突时 job 失败，按手动同步流程在本地解。

## 手动安装 CI 产物（浏览器下载）

app 内更新按钮永远不遇到 Gatekeeper（安装器自动剥 quarantine）；只有浏览器直接下载会报「已损坏」，处理：

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
