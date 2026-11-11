// ============================================================
// Spawned session thread turn-settlement notification
// ============================================================
// CreateSession 派生的顶层会话线程首轮结算后，向父会话投递的后台通知文本。
// 复用整条后台通知管线（enqueueBackgroundTaskNotification → task-notification 轮），
// 但**不**经 formatTaskNotification 的 RuntimeTaskType 分派：spawned thread 不是
// runtime task（没有 registry 条目、不可 TaskStop），通知只表达「那个会话的首轮
// 结算了」，模型据此决定是否跟进，不解析文本（产品状态读 originMeta）。

import { dropTrailingHighSurrogate } from "@zcode/contracts";
import { escapeXml } from "../runtime-task/notification.js";

/** 末段 assistant 摘要上限：通知会进父会话上下文，摘要只够模型判断是否跟进。 */
const SPAWNED_THREAD_SUMMARY_MAX_CHARS = 500;
/** 结构化 error 上限，与 subagent 通知同档。 */
const SPAWNED_THREAD_ERROR_MAX_CHARS = 2_000;

export type SpawnedThreadSettlementStatus = "completed" | "interrupted" | "error";

export interface SpawnedThreadNotificationInput {
  childSessionId: string;
  title: string;
  status: SpawnedThreadSettlementStatus;
  /** 子会话末段 assistant 文本摘要；error/interrupted 可缺省。 */
  summary?: string;
  error?: string;
  /** 父会话里 CreateSession 的工具调用 ID；通知归属与卡片关联用。 */
  parentToolCallId: string;
}

export function formatSpawnedThreadNotification(input: SpawnedThreadNotificationInput): string {
  const lines = [
    "<task-notification>",
    `  <task-id>${escapeXml(input.childSessionId)}</task-id>`,
    `  <tool-use-id>${escapeXml(input.parentToolCallId)}</tool-use-id>`,
    "  <task-type>spawned_thread</task-type>",
    `  <status>${escapeXml(input.status)}</status>`,
    `  <description>${escapeXml(input.title)}</description>`,
    `  <summary>${escapeXml(spawnedThreadSummaryLine(input))}</summary>`,
  ];
  if (input.summary?.trim()) {
    lines.push(`  <result>${escapeXml(boundSummary(input.summary))}</result>`);
  }
  if (input.error?.trim()) {
    lines.push(`  <error>${escapeXml(boundError(input.error))}</error>`);
  }
  lines.push(
    "  The session thread remains open in the session list; the user can continue it there.",
    "  Do not poll it. Respond to the user only if this outcome changes your own work.",
    "</task-notification>",
  );
  return lines.join("\n");
}

function spawnedThreadSummaryLine(input: SpawnedThreadNotificationInput): string {
  if (input.status === "completed") {
    return `Session thread "${input.title}" finished its first turn.`;
  }
  if (input.status === "interrupted") {
    return `Session thread "${input.title}" was interrupted during its first turn.`;
  }
  return `Session thread "${input.title}" failed its first turn: ${boundError(input.error ?? "")}`;
}

function boundSummary(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length <= SPAWNED_THREAD_SUMMARY_MAX_CHARS) return trimmed;
  return `${dropTrailingHighSurrogate(trimmed.slice(0, SPAWNED_THREAD_SUMMARY_MAX_CHARS - 1))}…`;
}

function boundError(error: string): string {
  const trimmed = error.trim();
  if (trimmed.length <= SPAWNED_THREAD_ERROR_MAX_CHARS) return trimmed;
  return `${dropTrailingHighSurrogate(trimmed.slice(0, SPAWNED_THREAD_ERROR_MAX_CHARS - 1))}…`;
}
