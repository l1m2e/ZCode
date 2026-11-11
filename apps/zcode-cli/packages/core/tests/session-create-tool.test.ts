import { describe, expect, it, vi } from "vitest";
import { registerBuiltInTools, createToolRegistry } from "../src/tool/index.js";
import { createSessionToolEntry } from "../src/tool/handlers/session-create.js";
import {
  SPAWN_SESSION_TOOL_NAME,
  CoreErrorType,
  type SessionSpawnOutcome,
  type SessionSpawnPort,
  type SessionSpawnRequest,
  type TraceId,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../src/tool/types.js";

function createContext(
  port: SessionSpawnPort | undefined,
  options: { taskType?: "spawned_thread" } = {},
): ToolExecutionContext {
  return {
    toolCallId: "tool-session-create",
    traceId: "trace-session-create" as TraceId,
    abortSignal: new AbortController().signal,
    sessionSpawnPort: port,
    taskType: options.taskType,
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
    sessionId: "sess-parent" as never,
  };
}

function createPort(
  outcome: SessionSpawnOutcome,
): SessionSpawnPort & { requests: SessionSpawnRequest[] } {
  const requests: SessionSpawnRequest[] = [];
  return {
    requests,
    create: async (request) => {
      requests.push(request);
      return outcome;
    },
  };
}

describe("CreateSession tool", () => {
  it("端口缺席时不注册工具", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, { includeSessionCreate: false });
    expect(registry.has(SPAWN_SESSION_TOOL_NAME)).toBe(false);
  });

  it("端口在场且门控打开时注册工具", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, { includeSessionCreate: true });
    expect(registry.has(SPAWN_SESSION_TOOL_NAME)).toBe(true);
  });

  it("成功创建时把 prompt/title/父会话/工具调用 ID 交给端口", async () => {
    const port = createPort({ ok: true, sessionId: "sess-child", title: "核对实现" });
    const output = (await createSessionToolEntry.handler(
      { prompt: "核对 Mastra 实现", title: "核对实现" },
      createContext(port),
    )) as { sessionId: string; title: string; message: string };
    expect(output.sessionId).toBe("sess-child");
    expect(output.title).toBe("核对实现");
    expect(output.message).toContain("sess-child");
    expect(port.requests).toHaveLength(1);
    expect(port.requests[0]).toMatchObject({
      prompt: "核对 Mastra 实现",
      title: "核对实现",
      parentSessionId: "sess-parent",
      sourceToolCallId: "tool-session-create",
    });
  });

  it("spawned_thread 会话内调用被 handler 终检拒绝", async () => {
    const port = createPort({ ok: true, sessionId: "sess-child", title: "x" });
    await expect(
      createSessionToolEntry.handler({ prompt: "nested" }, createContext(port, {
        taskType: "spawned_thread",
      })),
    ).rejects.toMatchObject({ type: CoreErrorType.PermissionDenied });
    expect(port.requests).toHaveLength(0);
  });

  it("端口缺席时报配置错误而不是未定义调用", async () => {
    await expect(
      createSessionToolEntry.handler({ prompt: "x" }, createContext(undefined)),
    ).rejects.toMatchObject({ type: CoreErrorType.ConfigurationError });
  });

  it("并发上限失败翻译为可重试错误，递归失败不可重试", async () => {
    const limitPort = createPort({
      ok: false,
      errorCategory: "concurrency_limit",
      message: "limit reached",
    });
    await expect(
      createSessionToolEntry.handler({ prompt: "x" }, createContext(limitPort)),
    ).rejects.toMatchObject({
      type: CoreErrorType.PermissionDenied,
      recoverable: true,
    });

    const recursionPort = createPort({
      ok: false,
      errorCategory: "recursion",
      message: "no recursion",
    });
    await expect(
      createSessionToolEntry.handler({ prompt: "x" }, createContext(recursionPort)),
    ).rejects.toMatchObject({
      type: CoreErrorType.PermissionDenied,
      recoverable: false,
    });
  });

  it("创建被拒翻译为可重试的执行失败", async () => {
    const port = createPort({
      ok: false,
      errorCategory: "create_rejected",
      message: "rejected",
    });
    await expect(
      createSessionToolEntry.handler({ prompt: "x" }, createContext(port)),
    ).rejects.toMatchObject({
      type: CoreErrorType.ToolExecutionFailed,
      recoverable: true,
    });
  });

  it("权限声明为低危、免审批且 Plan 不放行", () => {
    expect(createSessionToolEntry.permission).toMatchObject({
      permission: "session.create",
      riskLevel: "low",
      needsApproval: false,
    });
    expect(createSessionToolEntry.metadata.needsApproval).toBe(false);
    expect(createSessionToolEntry.metadata.allowedInPlanMode).toBeFalsy();
  });

  it("子代理强制禁用名单包含 CreateSession", async () => {
    const { SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS } = await import(
      "../src/subagent/tool-policy.js"
    );
    expect(SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS).toContain(SPAWN_SESSION_TOOL_NAME);
  });

  it("通知格式化包含子会话身份、状态与摘要边界", async () => {
    const { formatSpawnedThreadNotification } = await import(
      "../src/subagent/spawned-thread-notification.js"
    );
    const text = formatSpawnedThreadNotification({
      childSessionId: "sess-child",
      title: "核对实现",
      status: "completed",
      summary: "结论：支持。",
      parentToolCallId: "tool-1",
    });
    expect(text).toContain("<task-type>spawned_thread</task-type>");
    expect(text).toContain("<status>completed</status>");
    expect(text).toContain("sess-child");
    expect(text).toContain("结论：支持。");

    const longSummary = "a".repeat(1200);
    const bounded = formatSpawnedThreadNotification({
      childSessionId: "sess-child",
      title: "t",
      status: "error",
      summary: longSummary,
      error: "boom",
      parentToolCallId: "tool-1",
    });
    expect(bounded).toContain("<status>error</status>");
    expect(bounded).toContain("boom");
    // 摘要被截断：原文 1200 字符不应整段出现。
    expect(bounded).not.toContain(longSummary);
  });

  it("spy 校验 handler 不吞端口异常", async () => {
    const port: SessionSpawnPort = {
      create: vi.fn(async () => {
        throw new Error("port exploded");
      }),
    };
    await expect(
      createSessionToolEntry.handler({ prompt: "x" }, createContext(port)),
    ).rejects.toThrow("port exploded");
  });
});
