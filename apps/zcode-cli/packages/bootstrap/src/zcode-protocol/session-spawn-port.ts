// ============================================================
// SessionSpawnPort：CreateSession 的进程内建会话实现
// ============================================================
// 创建走既有 v4 createSession 信封经 nativeExecutor 执行（CommandInbox 幂等、
// session_input 账本、deferred→immediate 提升与失败清理全部复用，不旁路 admission）；
// 有 title 时再执行一条 renameSession 信封（titleSource=custom，屏蔽自动生成）。
// 完成通知：spawn 登记表（child → parent）+ gateway 的 onSpawnedThreadTurnTerminal
// 钩子；父会话未加载时写 session_entry pending 标记，父会话下次加载时 drain 补发。
// 见 docs/design/v2/tool/21-session-create.md。

import { randomUUID } from "node:crypto";
import {
  CREATE_SESSION_TOOL_NAME,
  type SessionId,
  type SessionSpawnOutcome,
  type SessionSpawnPort,
  type SessionSpawnRequest,
} from "@zcode/contracts";
import { formatSpawnedThreadNotification } from "@zcode/core";
import type { CommandEnvelope, CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

/** 同一 workspace 活跃 spawned_thread 上限；超限工具报错提示模型复用或等待。 */
export const SPAWNED_THREAD_CONCURRENCY_LIMIT = 8;

/** 父会话 pending 通知的 session_entry 类型；drain 只认这个 type。 */
export const SPAWNED_THREAD_PENDING_ENTRY_TYPE = "spawned_thread_pending_notification";

export type SpawnedThreadSettlementStatus = "completed" | "interrupted" | "error";

/** 写入 pending entry 的完整通知载荷（title/parentToolCallId 在写入时从登记表固化）。 */
export interface SpawnedThreadPendingNotification {
  childSessionId: string;
  title: string;
  status: SpawnedThreadSettlementStatus;
  summary?: string;
  error?: string;
  parentToolCallId: string;
  settledAt: number;
  delivered?: boolean;
}

interface SpawnRegistration {
  parentSessionId: string;
  parentToolCallId: string;
  title: string;
  notified: boolean;
}

function buildEnvelope(
  type: CommandEnvelope["type"],
  sessionId: string | null,
  payload: unknown,
): CommandEnvelope {
  return {
    commandId: `spawn_${randomUUID()}`,
    clientId: "cli-session-spawn",
    sessionId,
    type,
    payload,
    issuedAt: Date.now(),
  };
}

export function createSessionSpawnPort(
  context: ZCodeProtocolAgentServerContext,
  getParentRecord: () => ZCodeProtocolSessionRecord | undefined,
): SessionSpawnPort {
  return {
    create: async (request: SessionSpawnRequest): Promise<SessionSpawnOutcome> => {
      const parentRecord = getParentRecord();
      if (!parentRecord) {
        return {
          ok: false,
          errorCategory: "unknown",
          message: "The parent session runtime is unavailable; cannot create a session thread.",
        };
      }
      if (parentRecord.taskType === "spawned_thread") {
        return {
          ok: false,
          errorCategory: "recursion",
          message:
            "CreateSession cannot run inside a spawned session thread. Do the work in this session instead.",
        };
      }
      const activeSpawned = [...context.sessions.values()].filter(
        (record) =>
          record.taskType === "spawned_thread" &&
          record.workspace.workspaceKey === parentRecord.workspace.workspaceKey &&
          record.persistence !== "deferred",
      ).length;
      if (activeSpawned >= SPAWNED_THREAD_CONCURRENCY_LIMIT) {
        return {
          ok: false,
          errorCategory: "concurrency_limit",
          message: `This workspace already has ${activeSpawned} active session threads (limit ${SPAWNED_THREAD_CONCURRENCY_LIMIT}). Reuse or wait for one to settle before creating another.`,
        };
      }

      const childSessionId = `sess_${randomUUID()}`;
      const createPayload: CommandPayloadMap["createSession"] = {
        sessionId: childSessionId,
        workspaceId: parentRecord.workspace.workspaceKey,
        taskType: "spawned_thread",
        parentSessionId: parentRecord.app.sessionId,
        toolDenylist: [CREATE_SESSION_TOOL_NAME],
        firstInput: { text: request.prompt },
      };
      const gateway = context.v4Gateway;
      if (!gateway) {
        return {
          ok: false,
          errorCategory: "unknown",
          message: "The v4 gateway is unavailable; cannot create a session thread.",
        };
      }
      const createAck = await gateway.executeSpawnCommand(
        buildEnvelope("createSession", null, createPayload),
      );
      if (!createAck || createAck.status !== "accepted") {
        return {
          ok: false,
          errorCategory: "create_rejected",
          message: `Session thread creation was rejected: ${createAck?.reasonCode ?? "unknown"}${createAck?.message ? ` (${createAck.message})` : ""}`,
        };
      }
      const title = request.title?.trim();
      if (title) {
        const renameAck = await gateway.executeSpawnCommand(
          buildEnvelope("renameSession", childSessionId, { title }),
        );
        if (!renameAck || renameAck.status !== "accepted") {
          // 会话已建、首 turn 已起；标题失败不能伪装成整体失败（那会让模型重试创建）。
          context.logger?.warn("spawned thread rename failed; keeping derived title", {
            childSessionId,
            event: "zcode_protocol.session_spawn.rename_failed",
            module: "bootstrap.zcode_protocol",
            reasonCode: renameAck?.reasonCode,
          });
        }
      }
      registerSpawn(context, {
        childSessionId,
        parentSessionId: parentRecord.app.sessionId,
        parentToolCallId: request.sourceToolCallId,
        title: title || request.prompt.slice(0, 60),
      });
      const resolvedTitle =
        context.deps.sessionStore === undefined
          ? (title ?? request.prompt.slice(0, 60))
          : ((await context.deps.sessionStore.getSession(childSessionId as SessionId))?.title ??
            title ??
            request.prompt.slice(0, 60));
      return { ok: true, sessionId: childSessionId, title: resolvedTitle };
    },
  };
}

// ── spawn 登记表与通知投递 ────────────────────────────────────────

const spawnRegistryByContext = new WeakMap<
  ZCodeProtocolAgentServerContext,
  Map<string, SpawnRegistration>
>();

export function registerSpawn(
  context: ZCodeProtocolAgentServerContext,
  registration: Omit<SpawnRegistration, "notified"> & { childSessionId: string },
): void {
  const registry = spawnRegistryByContext.get(context) ?? new Map<string, SpawnRegistration>();
  spawnRegistryByContext.set(context, registry);
  registry.set(registration.childSessionId, {
    parentSessionId: registration.parentSessionId,
    parentToolCallId: registration.parentToolCallId,
    title: registration.title,
    notified: false,
  });
}

export function takeSpawnRegistration(
  context: ZCodeProtocolAgentServerContext,
  childSessionId: string,
): SpawnRegistration | undefined {
  const registry = spawnRegistryByContext.get(context);
  const registration = registry?.get(childSessionId);
  if (!registration || registration.notified) return undefined;
  registration.notified = true;
  return registration;
}

/**
 * 子会话首轮结算：父 runtime 已加载则直接入队后台通知；未加载则写 pending 标记，
 * 父会话下次加载时由 drainSpawnedThreadPendingNotifications 补发。
 */
export async function deliverSpawnedThreadNotification(
  context: ZCodeProtocolAgentServerContext,
  input: {
    childSessionId: string;
    status: SpawnedThreadSettlementStatus;
    summary?: string;
    error?: string;
    settledAt: number;
  },
): Promise<void> {
  const registration = takeSpawnRegistration(context, input.childSessionId);
  if (!registration) return;
  const payload: SpawnedThreadPendingNotification = {
    childSessionId: input.childSessionId,
    title: registration.title,
    status: input.status,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.error ? { error: input.error } : {}),
    parentToolCallId: registration.parentToolCallId,
    settledAt: input.settledAt,
    delivered: false,
  };
  const parentRecord = context.sessions.get(registration.parentSessionId);
  if (parentRecord) {
    enqueueNotification(parentRecord, payload);
    return;
  }
  const store = context.deps.sessionStore;
  if (!store?.saveSessionEntry) return;
  await store.saveSessionEntry({
    id: `spawned_thread_pending:${input.childSessionId}`,
    sessionID: registration.parentSessionId as SessionId,
    type: SPAWNED_THREAD_PENDING_ENTRY_TYPE,
    data: payload,
    time: { created: Date.now(), updated: Date.now() },
  });
}

function enqueueNotification(
  record: ZCodeProtocolSessionRecord,
  payload: SpawnedThreadPendingNotification,
): void {
  record.app.runtime.enqueueHostBackgroundTaskNotification({
    originMeta: {
      backgroundSource: "spawned_thread",
      workId: payload.childSessionId,
      title: payload.title,
    },
    taskId: payload.childSessionId,
    text: formatSpawnedThreadNotification({
      childSessionId: payload.childSessionId,
      title: payload.title,
      status: payload.status,
      ...(payload.summary ? { summary: payload.summary } : {}),
      ...(payload.error ? { error: payload.error } : {}),
      parentToolCallId: payload.parentToolCallId,
    }),
    traceContext: record.traceContext,
  });
}

/** 父会话加载/恢复时补发 pending 通知；entry 覆盖写 delivered 收口（无删除 API）。 */
export async function drainSpawnedThreadPendingNotifications(
  context: ZCodeProtocolAgentServerContext,
  parentSessionId: string,
): Promise<void> {
  const store = context.deps.sessionStore;
  const record = context.sessions.get(parentSessionId);
  if (!store?.sessionEntries || !record) return;
  const entries = await store.sessionEntries({
    sessionID: parentSessionId as SessionId,
    type: SPAWNED_THREAD_PENDING_ENTRY_TYPE,
  });
  for (const entry of entries) {
    const data = entry.data as SpawnedThreadPendingNotification | undefined;
    if (!data || data.delivered || typeof data.childSessionId !== "string") continue;
    enqueueNotification(record, data);
    await store.saveSessionEntry?.({
      ...entry,
      data: { ...data, delivered: true },
      time: { created: entry.time.created, updated: Date.now() },
    });
  }
}
