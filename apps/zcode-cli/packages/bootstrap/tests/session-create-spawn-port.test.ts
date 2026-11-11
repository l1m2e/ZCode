import { describe, expect, it, vi } from "vitest";
import {
  SPAWNED_THREAD_CONCURRENCY_LIMIT,
  SPAWNED_THREAD_PENDING_ENTRY_TYPE,
  createSessionSpawnPort,
  deliverSpawnedThreadNotification,
  drainSpawnedThreadPendingNotifications,
  registerSpawn,
  takeSpawnRegistration,
  type SpawnedThreadPendingNotification,
} from "../src/zcode-protocol/session-spawn-port.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

function makeParentRecord(overrides: Record<string, unknown> = {}) {
  return {
    taskType: "interactive",
    workspace: { workspaceKey: "/work/repo" },
    title: "父会话",
    traceContext: { traceId: "trace-parent" },
    app: {
      sessionId: "sess-parent",
      runtime: {
        enqueueHostBackgroundTaskNotification: vi.fn(),
      },
    },
    ...overrides,
  };
}

function makeSpawnedRecord(index: number) {
  return {
    taskType: "spawned_thread",
    workspace: { workspaceKey: "/work/repo" },
    persistence: "immediate",
    app: { sessionId: `sess-child-${index}` },
  };
}

function makeContext(options: {
  parent?: ReturnType<typeof makeParentRecord>;
  spawnedCount?: number;
  ackStatus?: "accepted" | "rejected";
  sessionStore?: Record<string, unknown>;
}) {
  const sessions = new Map<string, unknown>();
  if (options.parent) sessions.set(options.parent.app.sessionId, options.parent);
  for (let index = 0; index < (options.spawnedCount ?? 0); index += 1) {
    const spawned = makeSpawnedRecord(index);
    sessions.set(spawned.app.sessionId, spawned);
  }
  const executeSpawnCommand = vi.fn(async () => ({
    commandId: "cmd-1",
    status: options.ackStatus ?? "accepted",
    reasonCode: options.ackStatus === "rejected" ? "proto.invalidPayload" : undefined,
    revisionAtDecision: 1,
  }));
  return {
    context: {
      sessions,
      v4Gateway: { executeSpawnCommand },
      deps: { sessionStore: options.sessionStore },
      logger: { warn: vi.fn(), info: vi.fn() },
    } as unknown as ZCodeProtocolAgentServerContext,
    executeSpawnCommand,
  };
}

describe("createSessionSpawnPort", () => {
  it("父 record 缺席时报 unknown 且不执行命令", async () => {
    const { context, executeSpawnCommand } = makeContext({});
    const port = createSessionSpawnPort(context, () => undefined);
    const outcome = await port.create({
      prompt: "x",
      parentSessionId: "sess-parent",
      sourceToolCallId: "tool-1",
    });
    expect(outcome).toMatchObject({ ok: false, errorCategory: "unknown" });
    expect(executeSpawnCommand).not.toHaveBeenCalled();
  });

  it("spawned_thread 会话内创建报 recursion 且不执行命令", async () => {
    const parent = makeParentRecord({ taskType: "spawned_thread" });
    const { context, executeSpawnCommand } = makeContext({ parent });
    const port = createSessionSpawnPort(context, () => parent);
    const outcome = await port.create({
      prompt: "x",
      parentSessionId: parent.app.sessionId,
      sourceToolCallId: "tool-1",
    });
    expect(outcome).toMatchObject({ ok: false, errorCategory: "recursion" });
    expect(executeSpawnCommand).not.toHaveBeenCalled();
  });

  it("同 workspace 活跃 spawned_thread 达上限时报 concurrency_limit", async () => {
    const parent = makeParentRecord();
    const { context, executeSpawnCommand } = makeContext({
      parent,
      spawnedCount: SPAWNED_THREAD_CONCURRENCY_LIMIT,
    });
    const port = createSessionSpawnPort(context, () => parent);
    const outcome = await port.create({
      prompt: "x",
      parentSessionId: parent.app.sessionId,
      sourceToolCallId: "tool-1",
    });
    expect(outcome).toMatchObject({ ok: false, errorCategory: "concurrency_limit" });
    expect(executeSpawnCommand).not.toHaveBeenCalled();
  });

  it("createSession ACK 非 accepted 时报 create_rejected", async () => {
    const parent = makeParentRecord();
    const { context, executeSpawnCommand } = makeContext({ parent, ackStatus: "rejected" });
    const port = createSessionSpawnPort(context, () => parent);
    const outcome = await port.create({
      prompt: "x",
      parentSessionId: parent.app.sessionId,
      sourceToolCallId: "tool-1",
    });
    expect(outcome).toMatchObject({ ok: false, errorCategory: "create_rejected" });
    expect(executeSpawnCommand).toHaveBeenCalledTimes(1);
  });

  it("成功创建：信封带 spawned_thread 类型、父子关系与 CreateSession deny；登记后可取", async () => {
    const parent = makeParentRecord();
    const { context, executeSpawnCommand } = makeContext({ parent });
    const port = createSessionSpawnPort(context, () => parent);
    const outcome = await port.create({
      prompt: "核对 Mastra 实现",
      title: "核对实现",
      parentSessionId: parent.app.sessionId,
      sourceToolCallId: "tool-1",
    });
    expect(outcome.ok).toBe(true);
    const createEnvelope = executeSpawnCommand.mock.calls[0][0] as {
      type: string;
      sessionId: string | null;
      payload: Record<string, unknown>;
    };
    expect(createEnvelope.type).toBe("createSession");
    expect(createEnvelope.sessionId).toBeNull();
    expect(createEnvelope.payload).toMatchObject({
      taskType: "spawned_thread",
      parentSessionId: "sess-parent",
      toolDenylist: ["SpawnSession"],
      firstInput: { text: "核对 Mastra 实现" },
    });
    // 有 title → 追加 renameSession 信封
    const renameEnvelope = executeSpawnCommand.mock.calls[1][0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(renameEnvelope.type).toBe("renameSession");
    expect(renameEnvelope.payload).toMatchObject({ title: "核对实现" });

    const sessionId = (outcome as { sessionId: string }).sessionId;
    const registration = takeSpawnRegistration(context, sessionId);
    expect(registration).toMatchObject({
      parentSessionId: "sess-parent",
      parentToolCallId: "tool-1",
      title: "核对实现",
    });
    // 仅一次
    expect(takeSpawnRegistration(context, sessionId)).toBeUndefined();
  });
});

describe("spawned thread 通知投递", () => {
  it("父会话已加载：直接入队后台通知，且仅一次", async () => {
    const parent = makeParentRecord();
    const { context } = makeContext({ parent });
    registerSpawn(context, {
      childSessionId: "sess-child",
      parentSessionId: "sess-parent",
      parentToolCallId: "tool-1",
      title: "核对实现",
    });
    await deliverSpawnedThreadNotification(context, {
      childSessionId: "sess-child",
      status: "completed",
      summary: "结论：支持。",
      settledAt: 1,
    });
    const enqueue = parent.app.runtime.enqueueHostBackgroundTaskNotification;
    expect(enqueue).toHaveBeenCalledTimes(1);
    const call = (enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      originMeta: { backgroundSource: string; title: string };
      text: string;
    };
    expect(call.originMeta).toMatchObject({
      backgroundSource: "spawned_thread",
      title: "核对实现",
    });
    expect(call.text).toContain("<task-type>spawned_thread</task-type>");
    expect(call.text).toContain("结论：支持。");
    // 第二次投递：登记已消费，不再入队
    await deliverSpawnedThreadNotification(context, {
      childSessionId: "sess-child",
      status: "error",
      settledAt: 2,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("父会话未加载：写 pending entry；父会话加载后 drain 补发并标记 delivered", async () => {
    // 真实 store 的 saveSessionEntry 按 id upsert；mock 必须同语义，
    // 否则 drain 的 delivered 覆盖会表现为新增条目。
    const saved = new Map<string, Record<string, unknown>>();
    const sessionStore = {
      saveSessionEntry: vi.fn(async (entry: Record<string, unknown>) => {
        saved.set(String(entry.id), entry);
      }),
      sessionEntries: vi.fn(async () => [...saved.values()]),
    };
    const { context } = makeContext({ parent: undefined, sessionStore });
    registerSpawn(context, {
      childSessionId: "sess-child",
      parentSessionId: "sess-parent",
      parentToolCallId: "tool-1",
      title: "核对实现",
    });
    await deliverSpawnedThreadNotification(context, {
      childSessionId: "sess-child",
      status: "interrupted",
      settledAt: 1,
    });
    expect(saved.size).toBe(1);
    const pending = [...saved.values()][0];
    expect(pending).toMatchObject({
      type: SPAWNED_THREAD_PENDING_ENTRY_TYPE,
      sessionID: "sess-parent",
    });

    // 父会话此时加载
    const parent = makeParentRecord();
    (context.sessions as Map<string, unknown>).set("sess-parent", parent);
    await drainSpawnedThreadPendingNotifications(context, "sess-parent");
    const enqueue = parent.app.runtime.enqueueHostBackgroundTaskNotification;
    expect(enqueue).toHaveBeenCalledTimes(1);
    // drain 经 saveSessionEntry upsert 覆盖写 delivered；从 map 重读最新条目。
    const updated = [...saved.values()][0];
    const data = updated.data as SpawnedThreadPendingNotification;
    expect(data.delivered).toBe(true);

    // 再 drain 一次不再补发
    await drainSpawnedThreadPendingNotifications(context, "sess-parent");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
