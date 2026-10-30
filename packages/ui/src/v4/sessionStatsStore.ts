import { useCallback, useSyncExternalStore } from "react";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";

/**
 * 会话统计（dsh 风格状态条）：轮 / 步 / 模型用时 / 工具调用用时 / 首 token 平均（TTFT）/
 * 输出速度（TPS）。按 sessionId 分账，替代旧 tokensPerSecondStore 的单一 t/s 徽章。
 *
 * 口径（消费 renderer 已去重的会话事实，与 usage.delta 的账本口径保持一致）：
 * - 轮：turn.started，排除 controlOnly 与 background 唤起（bash/subagent/workflow 通知轮）；
 * - 步：usage.delta 次数，即主轮 / subagent / workflow_child 的模型请求完成数；
 * - 模型用时：model.request.status completed 的 durationMs 之和（同一来源白名单）；
 * - 工具调用用时：tool.lifecycle completed/failed 的 durationMs 之和；
 * - 首 token 平均：每步 model_request_started → 首包的间隔均值（优先 CLI 权威 firstTokenAt）；
 * - 输出速度：累计 outputTokens ÷ 每步解码时长之和；解码窗口优先用 CLI 权威
 *   「firstTokenAt → usage.delta occurredAt」，stream.chunk 首尾差只作旧事件回退，
 *   因为高频 chunk 事实在实时链路上到达不完整会把窗口压塌、TPS 虚高几十倍。
 *
 * in-flight 步不参与计算；短于 MIN_ROUND_MS 的流视为噪声丢弃。
 * 数据只覆盖本 renderer 存活期间收到的事实（旧 t/s store 同限），恢复历史会话不回填。
 * ponytail: 单槽 per-round 状态，主轮与 subagent 流式交错时 TTFT/TPS 会掺入相邻步的
 * 打点（旧 store 同样假设轮次串行）；需要精确按 requestId 分账时再升级为多槽。
 */

const MIN_ROUND_MS = 200;
const MAX_TRACKED_SESSIONS = 200;
// 与 ConversationTelemetryEngine 的 MAX_DEDUPE_KEYS 同容量；事实重放窗口之外的历史不再补账。
const MAX_DEDUPE_KEYS = 2_000;

/** FIFO 有界去重集合：容量超限时淘汰最早写入的 key（同引擎 BoundedKeySet 语义）。 */
class BoundedKeySet {
  private readonly keys = new Set<string>();

  remember(key: string): boolean {
    if (this.keys.has(key)) {
      return false;
    }
    this.keys.add(key);
    if (this.keys.size > MAX_DEDUPE_KEYS) {
      const oldest = this.keys.values().next().value;
      if (typeof oldest === "string") {
        this.keys.delete(oldest);
      }
    }
    return true;
  }
}

const seenFactEventIds = new BoundedKeySet();

/** 与 CLI isStepUsageQuerySource 同一白名单：sidecar/compact 等不进业务统计。 */
function isStepUsageQuerySource(querySource: string | undefined): boolean {
  return (
    querySource === undefined ||
    querySource === "main_turn" ||
    querySource === "subagent" ||
    querySource === "workflow_child"
  );
}

interface SessionStatState {
  turns: number;
  steps: number;
  outputTokens: number;
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
  /** 当前进行中步的流式打点；null 表示无进行中的步。 */
  runStartAt: number | null;
  lastChunkAt: number | null;
  /** 最近一次 model_request_started 打点；结算 TTFT 时回看本步首包前的起点。 */
  requestStartAt: number | null;
  /** 本步首包时刻快照的请求起点；null 表示本步缺少 TTFT 起点。 */
  roundRequestStartAt: number | null;
}

export interface SessionStatsSnapshot {
  turns: number;
  steps: number;
  outputTokens: number;
  llmMs: number;
  toolMs: number;
  /** 平均首 token 延迟（ms）；无采样时 null。 */
  ttftMs: number | null;
  /** 平均解码吞吐（tok/s，一位小数）；无采样时 null。 */
  tokensPerSecond: number | null;
}

const EMPTY_SNAPSHOT: SessionStatsSnapshot = {
  turns: 0,
  steps: 0,
  outputTokens: 0,
  llmMs: 0,
  toolMs: 0,
  ttftMs: null,
  tokensPerSecond: null,
};

const statsBySessionId = new Map<string, SessionStatState>();
const snapshotCacheBySessionId = new Map<
  string,
  { version: number; value: SessionStatsSnapshot }
>();
let version = 0;
const listeners = new Set<() => void>();

function ensureStat(sessionId: string): SessionStatState {
  let stat = statsBySessionId.get(sessionId);
  if (!stat) {
    stat = {
      turns: 0,
      steps: 0,
      outputTokens: 0,
      llmMs: 0,
      toolMs: 0,
      ttftMs: 0,
      ttftSteps: 0,
      decodeMs: 0,
      runStartAt: null,
      lastChunkAt: null,
      requestStartAt: null,
      roundRequestStartAt: null,
    };
    statsBySessionId.set(sessionId, stat);
    if (statsBySessionId.size > MAX_TRACKED_SESSIONS) {
      const oldest = statsBySessionId.keys().next().value;
      if (oldest !== undefined && oldest !== sessionId) {
        statsBySessionId.delete(oldest);
        snapshotCacheBySessionId.delete(oldest);
      }
    }
  }
  return stat;
}

function notify(): void {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

function noteModelRequestStatus(stat: SessionStatState, fact: Extract<ConversationTelemetryFact, { kind: "model.request.status" }>): void {
  if (!isStepUsageQuerySource(fact.querySource)) {
    return;
  }
  if (fact.status === "model_request_started") {
    stat.requestStartAt = fact.occurredAt;
    return;
  }
  if (fact.status === "model_request_completed") {
    stat.llmMs += Math.max(0, fact.durationMs ?? 0);
  }
}

function noteStreamChunk(stat: SessionStatState, occurredAt: number): void {
  if (stat.runStartAt === null) {
    stat.runStartAt = occurredAt;
    // 首包即本步 TTFT 终点；起点取最近一次请求 started（本步缺 started 时结算侧跳过）。
    stat.roundRequestStartAt = stat.requestStartAt;
  }
  stat.lastChunkAt = occurredAt;
}

function settleRound(
  stat: SessionStatState,
  outputTokens: number,
  firstTokenAt?: number,
  completedAt?: number,
): void {
  const runStartAt = stat.runStartAt;
  const lastChunkAt = stat.lastChunkAt;
  stat.runStartAt = null;
  stat.lastChunkAt = null;
  stat.requestStartAt = null;
  const roundRequestStartAt = stat.roundRequestStartAt;
  stat.roundRequestStartAt = null;
  stat.steps += 1;
  stat.outputTokens += outputTokens;
  // 解码分母优先用 CLI 权威「首包→完成」窗口（dsh 同口径）：stream.chunk 事实是高频
  // 旁路信号，实时链路上到达不完整时窗口会塌缩，TPS 被放大几十倍。chunk 累计只在
  // 旧事件缺失 firstTokenAt 时回退使用。
  let decodeWindowMs: number | null = null;
  let ttftEndAt: number | null = null;
  if (firstTokenAt !== undefined && completedAt !== undefined && completedAt >= firstTokenAt) {
    decodeWindowMs = completedAt - firstTokenAt;
    ttftEndAt = firstTokenAt;
  } else if (runStartAt !== null && lastChunkAt !== null) {
    decodeWindowMs = lastChunkAt - runStartAt;
    ttftEndAt = runStartAt;
  }
  if (decodeWindowMs !== null && outputTokens > 0 && decodeWindowMs >= MIN_ROUND_MS) {
    stat.decodeMs += decodeWindowMs;
  }
  if (ttftEndAt !== null && roundRequestStartAt !== null) {
    stat.ttftMs += Math.max(0, ttftEndAt - roundRequestStartAt);
    stat.ttftSteps += 1;
  }
}

/**
 * 每条会话事实调用：按 kind 归账到所属会话。
 * 去重口径与 ConversationTelemetryEngine.handleFact 相同（`sessionId\0eventId` 有界集合），
 * 挂接点在引擎去重之前，因此这里必须自行去重，避免同一事实在 pane 复用/重连重放时重复记账。
 */
export function noteConversationFactForSessionStats(fact: ConversationTelemetryFact): void {
  const eventKey = `${fact.sessionId}\0${fact.eventId}`;
  if (!seenFactEventIds.remember(eventKey)) {
    return;
  }
  const stat = ensureStat(fact.sessionId);
  switch (fact.kind) {
    case "turn.started":
      // 轮只计真实任务轮：控制轮与后台唤起（bash/subagent/workflow 通知）不入轮计数。
      if (fact.executionKind !== "controlOnly" && fact.backgroundSource === undefined) {
        stat.turns += 1;
      }
      break;
    case "model.request.status":
      noteModelRequestStatus(stat, fact);
      break;
    case "stream.chunk":
      noteStreamChunk(stat, fact.occurredAt);
      break;
    case "tool.lifecycle":
      if (
        (fact.phase === "completed" || fact.phase === "failed") &&
        fact.durationMs !== undefined
      ) {
        stat.toolMs += Math.max(0, fact.durationMs);
      }
      break;
    case "usage.delta":
      settleRound(stat, fact.outputTokens, fact.firstTokenAt, fact.occurredAt);
      break;
    default:
      break;
  }
  notify();
}

function resolveSnapshot(sessionId: string): SessionStatsSnapshot {
  const cached = snapshotCacheBySessionId.get(sessionId);
  if (cached && cached.version === version) {
    return cached.value;
  }
  const stat = statsBySessionId.get(sessionId);
  let value: SessionStatsSnapshot;
  if (!stat || (stat.steps === 0 && stat.turns === 0)) {
    value = EMPTY_SNAPSHOT;
  } else {
    value = {
      turns: stat.turns,
      steps: stat.steps,
      outputTokens: stat.outputTokens,
      llmMs: stat.llmMs,
      toolMs: stat.toolMs,
      ttftMs:
        stat.ttftSteps > 0 ? Math.round(stat.ttftMs / stat.ttftSteps) : null,
      tokensPerSecond:
        stat.decodeMs > 0
          ? Math.round((stat.outputTokens / (stat.decodeMs / 1_000)) * 10) / 10
          : null,
    };
  }
  snapshotCacheBySessionId.set(sessionId, { version, value });
  return value;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSessionStats(sessionId: string | null): SessionStatsSnapshot {
  const getSnapshot = useCallback(
    () => (sessionId ? resolveSnapshot(sessionId) : EMPTY_SNAPSHOT),
    [sessionId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
