# SpawnSession：Agent 发起新会话线程（原名 CreateSession）

## 背景

Codex 桌面版允许 Agent 在对话中发起一个新的会话线程：新线程带初始任务独立运行，出现在会话
列表里，父会话在合适时机得知它的结果。ZCode 目前只有两条「无界面创建会话」的路径：Host 侧的
cron / 闲时 / Bot 派发（跨进程，经 `createTask` + `sendPrompt`），以及 CLI 进程内的子代理与
workflow child（`taskType` 为 `subagent_child` / `workflow_child`，不进侧栏任务列表）。两者都不
是「当前对话的模型自主发起一个用户可见、可继续对话的顶层会话」。

本 spec 增加内置工具 `SpawnSession`（原名 `SpawnSession`；2026-11-11 官方 v3.18.0
session-control 工具族新增同名 `SpawnSession`（创建根会话+首条 prompt），为避免真实运行时
被同名工具遮蔽（注册循环里命中会话控制名集合即跳过内置项），个人工具更名。工具行为不变）：模型在当前会话中创建一个**顶层会话线程**（侧栏可见、
落盘、可被用户打开继续对话），带可选标题与必需的初始任务；子会话首轮 run 结算后，父会话收到
一条后台任务通知并触发父会话一个新 turn。

## 目标

- 工具 `SpawnSession`，输入 `{ prompt, title? }`，输出 `{ sessionId, title }`。
- 子会话是侧栏普通任务：`taskType = spawned_thread`，进 `TASK_LIST_SESSION_TYPES`，经既有
  sessions-index 与 Host 任务索引出现在列表，带未读标记。
- 子会话继承父会话的模型选型与权限模式；只支持当前 workspace（workspaceId 取父会话）。
- 子会话首轮 `TurnComplete` / `TurnError` 结算后，父会话收到**恰好一次**后台通知（复用
  `enqueueBackgroundTaskNotification`），触发父会话新 turn。
- 防递归：子会话永远看不到 `SpawnSession`；automation / off-peak 轮与子代理工具池禁用该工具。

## 非目标

- 不支持跨 workspace 创建（不解析其他 workspace 的 host 路由）。
- 不支持父会话向子会话持续追问（不新增 send-to-session 工具）；用户可自行打开子会话继续对话。
- 不改变子代理、workflow、cron / 闲时的既有创建与通知语义。
- 不做 CLI 崩溃后的通知补发：与子代理后台通知同语义（内存队列，崩溃即丢；台账留痕收口为
  discarded）。父会话**未加载**（冷）时的补发是唯一例外，见「通知投递」。

## 设计

### 会话身份与持久化

- 新 `SessionTaskType`：`spawned_thread`（`contracts/src/interfaces/session-store.port.ts`）。
  加入 `bootstrap/src/zcode-protocol-v4/task-list-session-membership.ts` 的
  `TASK_LIST_SESSION_TYPES`，侧栏与 Host 任务索引自动覆盖，不改 UI 列表逻辑。
- 父子关系复用 session 表既有 `parent_id`：创建参数经 legacy create/resume 参数的
  `parentSessionId` 落盘（`packages/shared/src/zcode-protocol/index.ts`
  `zcodeSessionCreateParamsSchema` / `zcodeSessionResumeParamsSchema` 增加可选 `taskType`，
  `.strict()` 下显式声明；resume 同加，仿 `offPeakToolEnabled` 的注释模式，冷恢复不丢类型）。
- 标题：有 `title` 时创建后立即执行 `renameSession`（`titleSource = custom`，屏蔽自动生成）；
  无 `title` 时走既有 `first_input` / 自动生成标题链路。

### 创建路径（进程内，不新增协议命令）

`SessionSpawnPort`（`contracts/src/interfaces/session-spawn.port.ts`，bootstrap 实现
`bootstrap/src/zcode-protocol/session-spawn-port.ts`）：

1. 守卫：父会话 `taskType === spawned_thread` 拒绝（双保险，工具面已 deny）；同 workspace 活跃
   （phase 非终态）`spawned_thread` 会话数 ≥ 8 拒绝，错误文案提示模型复用或等待。
2. 构造一条 `createSession` v4 信封：`sessionId` 预分配 `sess_<uuid>`、`workspaceId` 取父
   record、`firstInput.text = prompt`、`config` 继承父会话 `getSessionModelSelection()` 与当前
   mode、`parentSessionId`、`taskType = spawned_thread`、`toolDenylist: ["SpawnSession"]`
   （create/resume 参数既有字段，持久生效，子会话及其冷恢复都看不到该工具）。
3. 交给既有 `V4CommandExecutor`（`v4-bridge.ts` 的 `nativeExecutor`）执行——CommandInbox 幂等、
   session_input 账本、deferred→immediate 提升、失败清理全部免费获得；不旁路 admission。
4. ACK 为 accepted 后，有 `title` 则再执行一条 `renameSession` 信封（同一 executor）。
5. 在 spawn 登记表（进程内 `Map<childSessionId, { parentSessionId, notified }>`）登记，供通知
   钩子查询；返回 `{ sessionId, title }`。

### 通知投递

```text
子会话 runtime                v4-gateway 事件管线                 v4-bridge（登记表）        父会话 runtime
─────────────                ──────────────────                 ─────────────────        ──────────────
TurnComplete/TurnError ──▶ 既有终态分支 + onSpawnedThreadTurnTerminal(sessionId, event, snapshot)
                                                                │ 查登记表：child→parent
                                                                │ notified? 仅首轮?
                              父已加载 ────────────────────────▶ enqueueBackgroundTaskNotification
                                                                │   （台账 kind=backgroundNotification，
                                                                │     触发父会话新 turn，notified=true）
                              父未加载 ──▶ 父会话写 pending 标记（session_entry，
                                           先例 v4_command_fact: entry）
                                           父会话下次 resume/加载时 drain 补发同一条通知
```

- 挂钩点：`v4-gateway.ts` 事件管线中 `TurnComplete` / `TurnError` 的既有分支，新增可选 host 钩子
  `onSpawnedThreadTurnTerminal`（先例：`onHighspeedTurnTerminal`、`onTargetCompleted`），带
  publisher snapshot 供摘要取材。
- 仅首轮：登记表记录子会话是否已通知；子会话后续 turn（用户手动续聊）不再通知。
- 通知结算不回写 SpawnSession 工具行：行的 `ToolCallResult`（含 sessionId 的 JSON）是创建时
  终态快照，轮尾卡（`renderers/session-create.tsx`）靠它解析 sessionId；product projection 的
  background-task-notification 回写只服务 background Agent 的 launch-ACK 语义（BG26），对
  SpawnSession 行跳过——子会话首轮结果由通知轮自身承载，不落在派生动作的行上。
- 通知文本：`core/src/subagent/spawned-thread-notification.ts`（仿
  `completion-notification.ts`），含子会话标题、sessionId、状态（completed / interrupted /
  error）、末段 assistant 摘要（≤500 字，取自 snapshot 最后一条 assistantText row）。
  `BackgroundResultOriginMeta.backgroundSource` 新增 `spawned_thread` 分支
  （contracts + `packages/shared/src/zcode-protocol-v4` schema）。
- 父会话已删除 / runtime 关闭：通知丢弃并记 warn（与 `enqueueBackgroundTaskNotification` 的
  shutdown drop 先例一致）。

### 工具面与权限

- 注册：`core/src/tool/handlers/session-create.ts` + `handlers/index.ts` `builtInTools`；port
  缺省时不注册（同 automation 门控模式）。`provider-visible-order.ts` 的
  `SORTED_PROVIDER_TOOL_NAMES` 加 `SpawnSession` 保稳定字节序。
- 权限声明：`permission: "session.create"`、`needsApproval: false`、`riskLevel: low`、
  `readOnly: false`、`destructive: false`、`allowedInPlanMode: false`——Plan 模式经既有闸门
  （`16-plan-mode.md`）天然拒绝。
- 禁用矩阵：spawned_thread 会话经 create/resume `toolDenylist` 永久禁用；automation 轮与
  off-peak 轮在 `prompt-turn.ts` 的 `AUTOMATION_MUTATION_TOOL_NAMES` /
  `OFF_PEAK_MUTATION_TOOL_NAMES` 加入 `SpawnSession`；子代理工具池
  （`runtime/helpers/tool-allowlist.ts`）deny。

### UI

`packages/ui/src/ToolCallBlocks/renderers/session-create.tsx`：卡片显示标题、sessionId、创建
状态；「打开会话」按钮复用侧栏行导航动作（`WorkspaceShellLayout.tsx` 的
`handleSelectTaskInChat` 暴露路径）。结构化 display 走 `tool-result-metadata.ts` +
`shared/zcode-protocol-v4/toolDisplay.ts` 的 `sessionCreate` 分支。

## 验收场景

1. 对话中调用 `SpawnSession(prompt, title)`：工具卡渲染标题与 sessionId；侧栏出现该会话且
   phase=running；子会话独立执行首轮。
2. 子会话首轮成功结束：父会话出现后台通知（含标题与摘要）并自动续一个 turn；通知仅一条，
   子会话再续聊不产生新通知。
3. 子会话首轮失败 / 被中断：父会话通知带 error / interrupted 状态。
4. spawned_thread 会话内模型工具面不含 `SpawnSession`（含冷恢复后）；Plan 模式父会话调用被
   闸门拒绝；automation 轮与子代理内调用不可见。
5. 同 workspace 活跃 spawned_thread 达 8 时调用返回上限错误，不创建会话。
6. 无 `title` 时子会话标题走 first_input / 自动生成链路，与手工新建会话一致。
