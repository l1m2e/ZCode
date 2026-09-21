import { useCallback, useSyncExternalStore } from "react";

/**
 * 会话平均生成速度（tokens/s）：权威口径，不做字符估算。
 *
 * - tokens：累计 usage.delta 事实的 outputTokens（每轮模型请求完成时由 agent 上报，账本口径）；
 * - 时间：累计每轮 chunk 流「首包→末包」时长（stream.chunk 事实打点），不含首包前网络延迟；
 * - 每轮 usage.delta 到达时重算，即每轮更新一次；数值常驻，直到会话结束前不再消失。
 *
 * in-flight 轮次不参与计算（还没收到权威 usage）；短于 MIN_ROUND_MS 的轮次视为噪声丢弃。
 * 按 sessionId 分账：切换会话即切换到该会话自己的平均值。
 */

const MIN_ROUND_MS = 200;
const MAX_TRACKED_SESSIONS = 200;

interface SessionGenerationStat {
  totalOutputTokens: number;
  totalGenerationMs: number;
  roundCount: number;
  /** 当前轮 chunk 流起点；null 表示无进行中的轮次。 */
  runStartAt: number | null;
  lastChunkAt: number | null;
}

export interface SessionTokensPerSecondSnapshot {
  tokensPerSecond: number | null;
  roundCount: number;
}

const EMPTY_SNAPSHOT: SessionTokensPerSecondSnapshot = { tokensPerSecond: null, roundCount: 0 };

const statsBySessionId = new Map<string, SessionGenerationStat>();
const snapshotCacheBySessionId = new Map<string, { version: number; value: SessionTokensPerSecondSnapshot }>();
let version = 0;
const listeners = new Set<() => void>();

function ensureStat(sessionId: string): SessionGenerationStat {
  let stat = statsBySessionId.get(sessionId);
  if (!stat) {
    stat = { totalOutputTokens: 0, totalGenerationMs: 0, roundCount: 0, runStartAt: null, lastChunkAt: null };
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

/** 每条 stream.chunk 事实调用：为该会话当前轮打点（首包建起点，末包刷新终点）。 */
export function noteSessionStreamChunkForTokensPerSecond(sessionId: string): void {
  const stat = ensureStat(sessionId);
  const nowMs = Date.now();
  if (stat.runStartAt === null) {
    stat.runStartAt = nowMs;
  }
  stat.lastChunkAt = nowMs;
  notify();
}

/** 每条 usage.delta 事实调用：结算当前轮（权威 tokens + 实测时长）并重算平均值。 */
export function noteSessionUsageForTokensPerSecond(sessionId: string, outputTokens: number): void {
  const stat = ensureStat(sessionId);
  const runStartAt = stat.runStartAt;
  const lastChunkAt = stat.lastChunkAt;
  stat.runStartAt = null;
  stat.lastChunkAt = null;
  if (runStartAt === null || lastChunkAt === null) {
    return;
  }
  const roundMs = lastChunkAt - runStartAt;
  if (outputTokens <= 0 || roundMs < MIN_ROUND_MS) {
    return;
  }
  stat.totalOutputTokens += outputTokens;
  stat.totalGenerationMs += roundMs;
  stat.roundCount += 1;
  notify();
}

function resolveSnapshot(sessionId: string): SessionTokensPerSecondSnapshot {
  const cached = snapshotCacheBySessionId.get(sessionId);
  if (cached && cached.version === version) {
    return cached.value;
  }
  const stat = statsBySessionId.get(sessionId);
  let value: SessionTokensPerSecondSnapshot;
  if (!stat || stat.roundCount === 0 || stat.totalGenerationMs <= 0) {
    value = EMPTY_SNAPSHOT;
  } else {
    value = {
      tokensPerSecond: Math.round((stat.totalOutputTokens / (stat.totalGenerationMs / 1000)) * 10) / 10,
      roundCount: stat.roundCount,
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

export function useSessionTokensPerSecond(sessionId: string | null): SessionTokensPerSecondSnapshot {
  const getSnapshot = useCallback(
    () => (sessionId ? resolveSnapshot(sessionId) : EMPTY_SNAPSHOT),
    [sessionId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
