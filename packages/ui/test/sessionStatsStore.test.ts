// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import {
  noteConversationFactForSessionStats,
  useSessionStats,
} from "@/v4/sessionStatsStore.js";
import { renderHook } from "@testing-library/react";

let factSeq = 0;

function fact(base: Omit<ConversationTelemetryFact, "version" | "eventId" | "eventSeq" | "occurredAt" | "sessionId"> & { sessionId: string; occurredAt: number }): ConversationTelemetryFact {
  factSeq += 1;
  return {
    ...base,
    version: 1,
    eventId: `event-${factSeq}`,
    eventSeq: factSeq,
  } as ConversationTelemetryFact;
}

function turnStarted(sessionId: string, occurredAt: number, extra: { executionKind?: "agent" | "controlOnly"; backgroundSource?: "bash" | "subagent" | "workflow" } = {}): ConversationTelemetryFact {
  return fact({ kind: "turn.started", sessionId, occurredAt, ...extra });
}

function requestStarted(sessionId: string, occurredAt: number, querySource?: string): ConversationTelemetryFact {
  return fact({
    kind: "model.request.status",
    sessionId,
    occurredAt,
    requestId: "req-1",
    status: "model_request_started",
    providerId: "p",
    modelId: "m",
    transport: "stream",
    attempt: 0,
    maxAttempts: 1,
    ...(querySource ? { querySource } : {}),
  });
}

function requestCompleted(sessionId: string, occurredAt: number, durationMs: number, querySource?: string): ConversationTelemetryFact {
  return fact({
    kind: "model.request.status",
    sessionId,
    occurredAt,
    requestId: "req-1",
    status: "model_request_completed",
    providerId: "p",
    modelId: "m",
    transport: "stream",
    attempt: 0,
    maxAttempts: 1,
    durationMs,
    ...(querySource ? { querySource } : {}),
  });
}

function streamChunk(sessionId: string, occurredAt: number, firstChunk = false): ConversationTelemetryFact {
  return fact({ kind: "stream.chunk", sessionId, occurredAt, channel: "text", chunkLength: 8, firstChunk });
}

function usageDelta(
  sessionId: string,
  occurredAt: number,
  outputTokens: number,
  firstTokenAt?: number,
): ConversationTelemetryFact {
  return fact({
    kind: "usage.delta",
    sessionId,
    occurredAt,
    inputTokens: 1_000,
    outputTokens,
    totalTokens: 1_000 + outputTokens,
    reasoningTokens: 0,
    cacheReadTokens: 800,
    cacheWriteTokens: 0,
    ...(firstTokenAt !== undefined ? { firstTokenAt } : {}),
  });
}

function toolCompleted(sessionId: string, occurredAt: number, durationMs: number): ConversationTelemetryFact {
  return fact({ kind: "tool.lifecycle", sessionId, occurredAt, phase: "completed", toolCallId: "t-1", durationMs });
}

describe("sessionStatsStore", () => {
  it("按事实归账轮/步/用时/TTFT/TPS，排除控制轮与后台唤起轮", () => {
    const sessionId = "stats-1";
    noteConversationFactForSessionStats(turnStarted(sessionId, 1_000));
    // 控制轮与后台唤起不入轮计数。
    noteConversationFactForSessionStats(turnStarted(sessionId, 1_001, { executionKind: "controlOnly" }));
    noteConversationFactForSessionStats(turnStarted(sessionId, 1_002, { backgroundSource: "subagent" }));

    noteConversationFactForSessionStats(requestStarted(sessionId, 2_000));
    noteConversationFactForSessionStats(streamChunk(sessionId, 2_500, true));
    noteConversationFactForSessionStats(streamChunk(sessionId, 3_500));
    noteConversationFactForSessionStats(requestCompleted(sessionId, 3_600, 1_600));
    noteConversationFactForSessionStats(toolCompleted(sessionId, 3_700, 12_000));
    noteConversationFactForSessionStats(usageDelta(sessionId, 3_800, 100));

    const { result } = renderHook(() => useSessionStats(sessionId));
    expect(result.current).toMatchObject({
      turns: 1,
      steps: 1,
      outputTokens: 100,
      llmMs: 1_600,
      toolMs: 12_000,
      ttftMs: 500,
      tokensPerSecond: 100,
    });
  });

  it("sidecar 等非 step 来源不计模型用时，短流不计解码时长", () => {
    const sessionId = "stats-2";
    noteConversationFactForSessionStats(requestStarted(sessionId, 1_000, "title"));
    noteConversationFactForSessionStats(requestCompleted(sessionId, 2_000, 1_000, "title"));
    // 噪声步：流长 <200ms 且无输出 → 不进 decode，但仍是完成的一步。
    noteConversationFactForSessionStats(streamChunk(sessionId, 3_000, true));
    noteConversationFactForSessionStats(usageDelta(sessionId, 3_100, 0));

    const { result } = renderHook(() => useSessionStats(sessionId));
    expect(result.current).toMatchObject({
      steps: 1,
      llmMs: 0,
      tokensPerSecond: null,
      ttftMs: null,
    });
  });

  it("不同会话分账，空会话返回空快照", () => {
    const { result: empty } = renderHook(() => useSessionStats("stats-none"));
    expect(empty.current).toMatchObject({ turns: 0, steps: 0, tokensPerSecond: null, ttftMs: null });

    noteConversationFactForSessionStats(usageDelta("stats-a", 1_000, 10));
    const { result: a } = renderHook(() => useSessionStats("stats-a"));
    const { result: b } = renderHook(() => useSessionStats("stats-b"));
    expect(a.current.steps).toBe(1);
    expect(b.current.steps).toBe(0);
  });

  it("chunk 稀疏时解码分母用 CLI 权威首包时间，TPS 不再虚高", () => {
    const sessionId = "stats-authoritative";
    // 真实窗口 10s（首包 2s → 完成 12s），但实时链路上 renderer 只见到末尾一条 chunk：
    // 旧口径窗口塌缩成 0（被 200ms 门槛丢弃），TPS 会虚高几十倍。
    noteConversationFactForSessionStats(requestStarted(sessionId, 1_000));
    noteConversationFactForSessionStats(streamChunk(sessionId, 11_900));
    noteConversationFactForSessionStats(requestCompleted(sessionId, 12_000, 11_000));
    noteConversationFactForSessionStats(usageDelta(sessionId, 12_000, 500, 2_000));

    const { result } = renderHook(() => useSessionStats(sessionId));
    expect(result.current).toMatchObject({
      steps: 1,
      outputTokens: 500,
      // 500 tok ÷ 10s = 50 tok/s，而不是塌缩分母推出的数千 tok/s。
      tokensPerSecond: 50,
      ttftMs: 1_000,
    });
  });
});
