# Git UI

产品规则以 [源代码管理](source-control-panel.md) 和 [审查布局](../git-review-split-layout.md) 为准。

## 所有者

App 的 `useGitRepository` 提供唯一仓库快照；header、SCM 标签 和右侧 GitPane 共享 staged/unstaged/branch/last-turn 数据。GitPane 按需读取单文件 diff，继续使用 generation 拒绝旧响应。

SourceControlPanel 由右侧 SidePane 独立标签挂载，提交区和文件操作通过 GitPane 的 SCM 组合接口注入。SCM 草稿与确认仅属于当前身份/cwd；文件列表、选择、diff cache/generation、分栏和窄屏返回均由内嵌 GitPane 唯一持有，点击文件不跳转其他标签。

`useGitActions` 接入真实 Git service，并为同身份/cwd 的写操作提供共同 admission；顶部 GitActionMenu 复用该入口。SCM 默认仅提交当前范围暂存内容；顶部既有会话摘要过滤仍属于其独立提交弹窗。

## AI 提交消息

使用现有 generateCommitMessage、解析后的 locale、Host preferred model 和 workspace/generateText，不创建新会话。生成期间允许编辑，草稿版本变化后结果不得覆盖；失败保留草稿。模型链路和语言规则见 [提交消息语言](commit-message-language.md)。

## 验证入口

- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`
- Desktop E2E `test/e2e/git/commit/git-commit-dialog-ui-flow.test.ts`
- Desktop E2E `test/e2e/conversation-session/projects/conversation-session-git-review-entry.test.ts`
- 隔离临时 Git 仓库验证 index 范围、unborn、rename 和明确路径删除。

不新增或恢复 App 业务单测；实际执行结果由本次实施报告给出。

## 提交消息生成模型链路

- 顶部“提交”弹窗采用带标准 overlay 的紧凑轻量操作面板：顶部展示当前分支和本次选择范围的 `+/-` 统计，中间是提交信息输入区，底部是提交动作列表。
- 弹窗顶部的当前分支入口复用 `GitBranchSwitcher`，点击后只展开可切换的本地分支列表；切换成功后会重新读取当前分支的提交范围，避免继续展示旧分支的 staged / unstaged 快照。
- 弹窗顶部 `+/-` 统计优先复用当前对话的文件修改 summary，避免当前对话只改了少量文件时被工作区里其他未提交改动放大；没有对话 summary 时才回退到当前提交范围的 Git 统计。
- 提交信息输入区支持手动填写，也支持点击图标先生成；如果用户直接点击 `提交` / `提交并推送` 且消息为空，UI 会先生成 Conventional Commit 消息再继续执行动作。
- 提交面板默认包含未暂存更改，用户可以关闭 `包含未暂存的更改`，此时提交、统计和生成消息都只参考已暂存更改。
- 生成提交消息会随请求携带当前会话最近的用户 / assistant 文本上下文，用于让模型理解本轮修改意图；上下文按消息数和字符数裁剪，且生成结果不得显式写“根据对话”“按用户要求”等元叙述。
- 生成提交消息复用当前 workspace 的当前模型选择；Git service 只负责读取 Git status/diff、构造受限 prompt、校验 Conventional Commit 输出。
- 模型调用链路统一为 `Git service -> IZCodeAgentService -> ZCode Protocol workspace/generateText -> AgentRuntime -> modelAdapter.generateText`。
- UI 不再为提交消息生成预取 Start Plan / zcode-plan 的请求期鉴权材料，也不向 Git service 传 scoped runtime headers。
- Start Plan 的请求期 runtime headers 由 AgentRuntime 在 `modelAdapter.generateText` 每次真实请求前通过 `providerRuntimeHeaders.request` 自动刷新；该机制与普通对话、prompt enhance 等独立模型请求一致。
- Git service 不再直连 OpenAI / Anthropic 兼容 HTTP endpoint，也不解析 provider response / SSE；协议层返回纯文本后由 Git service 做输出清洗和错误收敛。

### 7. 对话输入区底栏

- 对话输入框内部现在只保留编辑相关控件（输入区、附件、发送 / 停止按钮）
- 当前 agent、当前模型、mode 设置、token 上下文统计从输入框壳体中拆出，统一放到输入框下方的底栏
- Git 分支切换入口与这些状态控件共用同一条底栏，并固定到最右侧，减少输入框内部横向拥挤
- 当前 agent 图标优先跟随“当前正在查看的 task provider”，避免切到历史 task / fork task 时出现展示与真实会话不一致

### 半真实数据

- `上一轮更改` 已优先复用当前 task 在 ZCode task store 里的 per-turn 文件快照和摘要
- 这部分是当前 UI 中最接近真实 agent 输出的数据来源
