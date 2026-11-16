# Session Stats Chip TPS Caliber

会话统计芯片（`SessionStatsBadges` → `sessionStatsStore`）的输出速度（TPS）口径。CLI runtime 是时间戳的唯一权威来源；renderer 只消费已去重的会话事实（`usage.delta`），不自造时钟。

## 挂载位置

两枚芯片（会话统计 / Token 用量）由 `SessionPane` 组装成一条居中窄行，经 `ConversationTimeline` 的 `bottomStrip` 插槽渲染在**滚动视口之外**的时间线根节点底沿，贴窗口底沿。

- 不能放回 composer dock 内：dock 在滚动视口内 sticky，v3.18.0 为防 mask 闪黑把底部留白（`pb-4`）移到视口外后，视口内元素的越界绘制会被原生 overflow 裁掉（曾用 `h-0 + overflow-visible` 被裁掉下半截）。
- 插槽仅在 dock 存在且非居中空态 / 浮窗形态时渲染（与根节点底部留白条件一致）。timeline 把状态条 `absolute inset-x-0 bottom-0` 漂浮在根节点 16px 底部留白带上：**不参与 flex 流式布局**，视口几何与 scroll 边缘契约（`bottomGap=16px`，`conversation-session-v4-scroll` E2E 断言 ±1px）完全不变，输入框位置也不变；芯片行浮在输入框与窗口底沿之间的原留白带上，其顶部 8px 与滚动视口底沿轻微重叠（与旧版芯片行浮在滚动内容上的视觉一致）。

## 公式

```text
TPS = Σ 采样步 outputTokens ÷ Σ 采样步解码时长
采样步 = 本步解码窗口齐备；分子分母同步入账，缺窗口的步两边都不进
```

## 解码窗口（按优先级，取第一个可用者）

1. **`firstOutputAt`（权威，首选）**：`usage.delta.occurredAt - firstOutputAt`。`firstOutputAt` 是 CLI 在 `ModelComplete` 上随发的本步**首个任意通道输出事件**的 epoch ms——非空 `text_delta` / `reasoning_delta`，或 `tool_input_start` / 非空 `tool_input_delta`（见 core `firstModelOutputAt`）。它覆盖工具调用参数的流式生成期。
2. **`firstTokenAt`（旧事件回退）**：`occurredAt - firstTokenAt`。`firstTokenAt` 只标记首个 text/reasoning delta（用户感知首包，TTFT 语义保持不变）。
3. **stream.chunk 首尾差（最后回退）**：首末 chunk 事实差须 ≥ `MIN_ROUND_MS`（200ms）——高频 chunk 事实在实时链路会被裁掉，短差不可信。

## 为什么首选 `firstOutputAt`

工具密集会话中，模型每步的大部分时长在流式输出工具调用参数（`tool_input_delta` 持续到达，不算 text/reasoning）。`firstTokenAt` 窗口排除这段时长，而分子 `outputTokens` 包含工具参数 token——工具调用步的窗口只占总时长约 10%，混算后 TPS 虚高一个量级（实测 421 vs 端到端 29 tok/s）。`firstOutputAt` 让窗口对齐分母的实际生成期。

- TTFT（首 token 平均）保持 `model_request_started → firstTokenAt` 口径，不受本字段影响。
- 纯工具调用步缺 `firstOutputAt` 时按第 2/3 级回退；全部缺失则该步不入采样。
- `firstOutputAt` 晚于 `occurredAt` 或窗口非正时视为缺失，不得产生负窗口。
- 数据只覆盖本 renderer 存活期间收到的事实；恢复历史会话不回填（既有约束不变）。

## 协议承载

`ModelCompletePayload.firstOutputAt`（contracts，可选）→ bootstrap fact normalizer 经 `nonNegative` 过滤后透传为 `usage.delta.firstOutputAt`（`zcode-protocol-v4/telemetry.ts` strict schema，可选，缺省 = 旧 CLI）。
