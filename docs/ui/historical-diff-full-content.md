# Historical Diff Full Content

## Product rules

- 会话工具的编辑文件名和回合变更摘要 Review 默认打开历史前后完整文件，未修改上下文全部展开；新版在左，可切单栏。框选单一版本代码后，在选区末行下编辑可空评论并加入当前会话草稿，不自动发送。
- 完整内容已知时，不因旧的 1200 行 / 180000 字符富 diff 阈值自动退回局部 hunk。内容由现有 diff renderer 展示，不改变全局字体、字号或换行偏好。
- 工具入口表示该次工具修改；回合入口表示该 product turn 的 first-before → final-after。后续磁盘修改、其他工具或其他回合不能污染这两个版本。
- 原始记录缺少历史版本或读取失败时明确提示，保留现有 patch。已安全解析的单文件 patch 可以引用确实包含的完整行，遇到省略区间、跨版本、未知文件或行号越界必须拒绝，不近似映射。

## Ownership and contracts

- Durable checkpoint artifacts remain the historical file-content owner. No copy of full files is added to tool display, realtime snapshots, ordinary file summaries or share publications.
- Extend existing `v4/conversation/fileChanges` read params with optional `contentPath`. Default requests retain existing lightweight response. Only the selected path may include `content: { status: "available", beforeContent, afterContent } | { status: "unavailable" }`.
- Existing `target` resolves to a turnHeader or a toolCall for this read only. A tool target derives the authoritative toolCallId from its server row; clients cannot supply arbitrary toolCallIds or artifact paths. Rewind guards remain turn-only. Workspace cold-resume routing, row revision/logEpoch validation and session authorization remain unchanged.
- Server reconstructs afterContent with existing exact patch application (no fuzz) and uses persisted beforeContent; absent-before is empty only when the checkpoint declares a created file. If a later checkpoint cannot reconstruct the final file, do not reuse an earlier afterContent as the final version. No current disk reads or current Git fallback.
- UI preview source carries a small historical reference `{sessionId, target, contentPath?}` and existing workspace scope. `contentPath` preserves the exact path stored by the tool/checkpoint, including relative paths; attachment `sourcePath` is separately resolved against the source workspace. Existing conversation service and UI hook issue the read at preview-open using current conversation revision/logEpoch; stale completion may not replace a different source/workspace. No callback or full response is persisted in side-pane source.
- History reference participates in source identity, including tool/turn row identity, so equal-looking patches from different edits do not reuse the wrong tab. Opening current source file strips history metadata.
- Shared diff content owns selection/comment draft; composer owns accepted draft attachment. `side=R` is after and `L` before regardless of visual column. Only a claimed attachment event clears the comment draft.

```mermaid
sequenceDiagram
    participant User as 用户
    participant Tab as Preview source owner
    participant Hook as UI historical-content hook
    participant Query as Existing conversation fileChanges service
    participant Runtime as CLI query + row guard
    participant Checkpoint as Durable checkpoint owner
    participant Diff as Shared diff / draft owner
    participant Composer as Composer attachment owner
    User->>Tab: 工具文件名或回合 Review
    Tab->>Hook: session + row target + path + workspace scope
    Hook->>Query: contentPath + current revision/logEpoch
    Query->>Runtime: Existing host/remote-session route
    Runtime->>Runtime: Validate row target; resolve turn/tool scope
    Runtime->>Checkpoint: Read original artifacts and reconstruct exact pair
    Checkpoint-->>Hook: Available pair or explicit unavailable
    Hook->>Diff: Current-source response only; full files expanded
    User->>Diff: Select same-version lines and submit comment
    Diff->>Composer: Existing code-comment-add-to-chat event
    Composer-->>Diff: claimed; clear draft only on acceptance
```

Desktop continuous 与手机 replayable 继续使用同一只读请求/历史 owner，既有 snapshot/stream/queue 语义不变；移动端使用当前 workspace identity 和 remoteSessionId 路由，不回落到同路径本机内容。

## Regression evidence

- CLI regression: turn pair first-before/final-after; tool target only matching toolCallId; multiple writes; create file; exact patch failure; latest unknown must not return earlier after; legacy artifacts; default response omits full content; target validation preserves rewind restrictions.
- UI/E2E maintenance: actual Edit chip and turn Review open full context including lines outside hunks; later formatter edits do not replace history; split/unified; large (>1200 lines) full pair still expanded; selection of new/old version adds accurate composer attachment without sending. Patch fallback permits exact in-hunk selections and rejects omitted ranges.
- 按用户要求，本轮不执行单测/E2E/自动界面操作。维护必要回归源码后执行根 typecheck、lint、architecture、Hooks 专项和定向格式检查，CLI 使用其实际包类型入口；开发服务保持供用户手测。未执行的运行时场景必须如实报告。
