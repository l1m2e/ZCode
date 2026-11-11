// ============================================================
// CreateSession Tool Handler
// ============================================================
// 模型在当前会话中发起一个顶层会话线程（侧栏可见、落盘、可继续对话）。
// 创建与首 turn 启动全部在 bootstrap 的 SessionSpawnPort 内完成（进程内经既有
// V4CommandExecutor 执行 createSession 信封）；本 handler 只做守卫翻译与结果整形。
// 防递归的三层纵深：spawned_thread 会话的 create/resume toolDenylist（持久）、
// automation/off-peak 轮 turn denylist、以及本 handler 的 taskType 终检。

import {
  CoreErrorType,
  SPAWN_SESSION_TOOL_NAME,
  CreateSessionInputJsonSchema,
  CreateSessionInputSchema,
  CreateSessionOutputJsonSchema,
  CreateSessionOutputSchema,
  createCoreError,
  type CreateSessionToolInput,
  type CreateSessionToolOutput,
  type SessionSpawnOutcome,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const SESSION_CREATE_TOOL_TIMEOUT_MS = 30_000;
const SESSION_CREATE_MODEL_BYTES = 8_000;

function assertSessionSpawnPort(
  context: ToolExecutionContext,
): asserts context is ToolExecutionContext & {
  sessionSpawnPort: NonNullable<ToolExecutionContext["sessionSpawnPort"]>;
} {
  if (context.sessionSpawnPort) return;
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `SessionSpawnPort is not configured for ${SPAWN_SESSION_TOOL_NAME}`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName: SPAWN_SESSION_TOOL_NAME,
      },
      recoverable: false,
    },
  );
}

/**
 * spawned_thread 会话内的 handler 级拒绝（toolDenylist 之外的第二层纵深）。
 * denylist 只约束可见性与常规执行；异常 provider 仍可能直接提交工具调用。
 */
function assertNotSpawnedThreadSession(context: ToolExecutionContext): void {
  if (context.taskType !== "spawned_thread") return;
  throw createCoreError(
    CoreErrorType.PermissionDenied,
    `${SPAWN_SESSION_TOOL_NAME} is not allowed inside a spawned session thread. Continue the work in this session, or ask the user to open a new chat.`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName: SPAWN_SESSION_TOOL_NAME,
      },
      recoverable: false,
      retryable: false,
    },
  );
}

/** port 的判别联合翻译为模型可转述的稳定错误；分类驱动文案，禁止靠 message 猜。 */
function spawnFailureError(
  context: ToolExecutionContext,
  outcome: Extract<SessionSpawnOutcome, { ok: false }>,
): ReturnType<typeof createCoreError> {
  const recoverable =
    outcome.errorCategory === "concurrency_limit" || outcome.errorCategory === "create_rejected";
  return createCoreError(
    outcome.errorCategory === "recursion" || outcome.errorCategory === "concurrency_limit"
      ? CoreErrorType.PermissionDenied
      : CoreErrorType.ToolExecutionFailed,
    outcome.message,
    {
      context: {
        errorCategory: outcome.errorCategory,
        toolCallId: context.toolCallId,
        toolName: SPAWN_SESSION_TOOL_NAME,
      },
      recoverable,
      retryable: recoverable,
    },
  );
}

const createSessionHandler: ToolHandler<CreateSessionToolInput, CreateSessionToolOutput> = async (
  input,
  context,
) => {
  assertNotSpawnedThreadSession(context);
  assertSessionSpawnPort(context);
  const outcome = await context.sessionSpawnPort.create({
    prompt: input.prompt,
    ...(input.title ? { title: input.title } : {}),
    parentSessionId: context.sessionId,
    sourceToolCallId: context.toolCallId,
  });
  if (!outcome.ok) {
    throw spawnFailureError(context, outcome);
  }
  return {
    sessionId: outcome.sessionId,
    title: outcome.title,
    message: `Created session thread "${outcome.title}" (${outcome.sessionId}). It is running its first turn now and appears in the session list. You will receive a background notification in this conversation when its first turn settles; do not poll or wait for it.`,
  };
};

const sessionCreatePermission: ToolPermissionSpec = {
  permission: "session.create",
  reason: "CreateSession starts a new top-level session thread that runs agent turns in this workspace",
  riskLevel: "low",
  sideEffectScope: "workspace",
  needsApproval: false,
  patternSources: ["toolName"],
  alwaysAllowPatternSources: ["toolName"],
  denyPriority: "beforeAsk",
};

const sessionCreateResultBudget = {
  maxInlineBytes: SESSION_CREATE_MODEL_BYTES,
  maxModelBytes: SESSION_CREATE_MODEL_BYTES,
  strategy: "truncate",
} as const;

const sessionCreateTimeout = {
  defaultMs: SESSION_CREATE_TOOL_TIMEOUT_MS,
  maxMs: SESSION_CREATE_TOOL_TIMEOUT_MS,
  allowCallOverride: false,
};

export const createSessionToolEntry: ToolEntry = {
  capability: "Create a new top-level session thread that runs an initial task",
  metadata: {
    // 与 cron/off-peak 同档：低频派生工具走 ToolSearch 延迟加载，不占常驻面。
    shouldDefer: true,
    name: SPAWN_SESSION_TOOL_NAME,
    description:
      "Create a new independent session thread in the current workspace and start it running an initial task immediately. The new thread appears in the session list like a normal chat, inherits this session's model and permission mode, and keeps its own context. When its first turn settles you receive a background notification in this conversation. Use it to delegate a self-contained piece of work to a fresh context instead of overloading this one. The prompt must be complete and self-contained: the new thread cannot see this conversation. Never call this from inside a spawned thread.",
    modelInstructions: [
      "Use this only when a self-contained sub-task deserves its own context, or when the user explicitly asks to open a new session/thread for some work.",
      "Write `prompt` as a complete task brief: goal, relevant background from this conversation, constraints and expected deliverable. The new thread starts with no context.",
      "Keep `title` short (sidebar label). Omit it to derive the title from the first message.",
      "The new thread runs in the current workspace only; do not try to target another project or workspace.",
      "After a successful creation, reply with a brief confirmation and continue your own work; the completion notification arrives on its own. Never poll the new session.",
      "Do not use this as a substitute for the Agent tool: subagents stay inside this conversation, a session thread is user-visible and continues independently.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: SESSION_CREATE_TOOL_TIMEOUT_MS,
    maxOutputBytes: SESSION_CREATE_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: createSessionHandler as ToolHandler,
  inputSchema: CreateSessionInputJsonSchema,
  outputSchema: CreateSessionOutputJsonSchema,
  runtimeInputSchema: CreateSessionInputSchema,
  runtimeOutputSchema: CreateSessionOutputSchema,
  permission: sessionCreatePermission,
  resultBudget: sessionCreateResultBudget,
  timeout: sessionCreateTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CreateSession was cancelled before the session thread was created",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
