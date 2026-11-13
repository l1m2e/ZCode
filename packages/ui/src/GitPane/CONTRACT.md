# Git 审查 UI

登记 `GitPane.tsx`、`GitPane/` 和 `lib/gitReviewSettings.ts`，把审查布局的实际 UI owner、子组件和纯偏好定义纳入同一 managed 模块。产品规则与验收场景以 [审查布局 spec](../../../../docs/git-review-split-layout.md) 为准。

- `GitPane` 持有选中文件、路径过滤、窄面板导航与 diff 展示缓存；数据源选择由调用方通过 props 控制。列表只投影过滤条件并管理滚动，内容区只管理当前选区与评论草稿，不建立第二份 Git 数据缓存。
- `gitReviewSettings` 的唯一可变状态与持久化路径仍是 `store/index.ts` 的切片及 `setGitReviewSettings`，只保存 diff 模式和列表显隐。纯偏好定义不读写 localStorage，不新增广播。
- 代码换行读取现有 `codePreviewSettings.wrapLongLines`，rich/patch 映射为 `overflow="wrap" / "scroll"`，轻量预览直接使用原设置。内容区不覆盖全局偏好，设置切换由渲染/尺寸事件更新概览，保留当前评论草稿。
- 内部分栏宽度复用共享 `ResizablePanelGroup` 的布局状态与持久化，`layoutId="git-review-layout"`，按可见 `file-list` / `diff` 组合分别记忆比例；不新增宽度 store 或拖拽 hook。双栏列表默认 240px、最小 180px、最大 60%，diff 最小 280px，单栏禁用拖拽且全宽，拖拽不折叠列表。显隐列表不重挂载仍可见的 diff，保留评论草稿。尺寸事件顺序见 spec。
- `GitPane.tsx` 是审查列表挂载入口；`lib/gitReviewSettings.ts` 是现有 store 的纯偏好入口；`contract.ts` 另公开 `DiffPreviewContent`，供历史 `patch` / `multi-file-diff` 预览复用同一内容区。调用方传只读 source、展示偏好、scope、滚动恢复接口和重内容可见性；内容区保留选区/评论 owner，隐藏重内容时不卸载草稿 owner。不读取 Git 或当前文件补历史全文。其他子组件、overview hook 与 helpers 仍为内部实现。
- `DiffPreviewContent` 通过现有 `hooks/useZCodeAgentService.ts` 的历史读取 hook，按 source 内 session/target/path/workspace scope 复用连接注册表与 session lease。历史引用中的 `contentPath` 保留 artifact 原始路径，不能随展示路径解码或绝对化；工具折叠组保留 path 对应 patch 与原始来源 row/path。全文只属于当前预览的临时展示投影，持久 source 只保存历史引用；不借用活跃会话 provider 或 summary 缓存。连接未 ready 不发请求；恢复水位后有限重取，切 source/连接及卸载丢弃旧响应。完整 pair 投影到 `GitDiffResult` 并优先完整渲染；等待、缺引用、不可用及错误有可见本地化提示，既有内容组件继续持有滚动和草稿生命周期。
- 概览条组件只测量当前渲染的变更行并投影视口，滚动位置唯一所有者仍是 diff 的既有滚动容器。点击/键盘只发出滚动意图；完整渲染映射全文，降级映射可见预览，折行和评论高度参与几何测量，不重新计算 diff 或扩大既有渲染阈值。
- 共享评论 UI 属于 `code-comment`；发送复用 `dispatchCodeCommentAddToChat`，workspace 身份、草稿接收和后续提交沿用既有 composer 链路。本模块不新增 Agent admission、owner/lease 或远程恢复协议。

```mermaid
sequenceDiagram
    participant Caller as 调用方（数据源）
    participant Pane as GitPane（选择与 diff 缓存）
    participant Git as 既有 Git 服务
    participant Content as 内容区（评论草稿）
    participant Composer as 既有 composer 接收方
    Caller->>Pane: 数据源与 repository revision
    Pane->>Git: 按 source/path 请求 diff，同 key 在途去重
    Git-->>Pane: 返回 diff，仅当前 generation 写入缓存
    Pane->>Content: 只读 diff 与文件作用域
    Content->>Content: 框选，冻结文本与行区间，编辑评论
    Content->>Composer: 既有 CodeCommentPayload 事件（含 workspaceIdentity）
    Composer-->>Content: 同步 claimed 结果（不是服务端接收确认）
```

```mermaid
sequenceDiagram
    participant Source as 历史预览 source
    participant Hook as UI 读取 hook
    participant Registry as workspace 连接注册表
    participant Store as session lease/store
    participant Query as 既有 fileChanges 只读接口
    Source->>Hook: workspace scope + session/target/path
    Hook->>Registry: ready 后 acquire 真实来源连接
    Hook->>Store: acquire(sessionId)，订阅当前水位
    Store-->>Hook: live + projectionReady + revision/logEpoch
    Hook->>Query: contentPath + 当前水位
    alt authority 过期
        Hook->>Store: recoverFromStaleAuthority
        Store-->>Hook: 恢复后的 live 水位
        Hook->>Query: 有限重试
    end
    Query-->>Hook: 当前来源的完整 pair / unavailable
    Hook->>Hook: 校验来源与 epoch；仅更新临时展示
    Source->>Hook: 切换或卸载
    Hook->>Store: 取消观察并 release
    Hook->>Registry: release；旧完成不得更新展示
```

Desktop continuous 与 mobile replayable 使用原 store 的各自恢复语义；hook 不新增订阅协议、超时或第二份业务 store。

`ui`、`shared` 仍是 legacy 依赖。此次登记检查本模块的源码规模、依赖声明、公开入口和 UI 实现导入限制；不意味着 store、Git hooks、DiffViewer、composer 或远程交付边界已经整体受管。generation 防陈旧结果、身份隔离、桌面与手机行为仍须按 spec 运行时验收；架构门禁不能证明这些语义。
