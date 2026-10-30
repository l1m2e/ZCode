// ============================================================
// Bash Tool - Shell Execution Tool
// ============================================================
// Reference: shell tool input / output shape

import { z } from "zod";
import { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";
import { ToolExecutionTelemetrySchema } from "./performance.js";

const MAX_BASH_TIMEOUT_MS = 600_000;
const TRUE_BOOLEAN_STRINGS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_BOOLEAN_STRINGS = new Set(["false", "0", "no", "n", "off"]);
// 修复原因：子代理（Explore/general-purpose）的终端摘要时中时英——模型会跟随任务提示词的
// 语言写 description，仅靠字段提示词里"用中文"一句不够。因此显式声明与对话语言无关，
// 并在工具级描述（bash-prompt.ts）里重复同一约束，双信号保证遵循。
const BASH_DESCRIPTION_FIELD_PROMPT = [
  "用简短的简体中文描述这条命令做什么（主动语态，一般 5-15 个字）。",
  "无论对话、任务提示或系统提示用什么语言，description 一律写简体中文，不要输出英文。",
  '不要出现"复杂""风险"之类的评价词，只描述命令本身做什么。',
  "",
  "用平实的语言说明命令做什么：不要照抄命令原文、参数或文件路径——用户读到的是描述，往往看不到命令本身。",
  "",
  "简单命令保持精简：",
  '- ls → "列出当前目录的文件"',
  '- git status → "查看工作区状态"',
  '- npm install → "安装项目依赖"',
  "",
  "管道、冷门参数等不易一眼看懂的命令，补充说明它的目的：",
  '- find . -name "*.tmp" -exec rm {} \\; → "递归查找并删除所有 .tmp 文件"',
  '- git reset --hard origin/main → "丢弃全部本地改动并重置到远程 main"',
  "- curl -s url | jq '.data[]' → \"请求 URL 并提取 JSON 数组元素\"",
].join("\n");

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

export const BashInputSchema = z
  .object({
    command: z.string().describe("The command to execute"),
    /**
     * Optional timeout in milliseconds (max 600000 for a foreground command)
     */
    timeout: semanticNumber(z.number())
      .optional()
      .describe(
        `Optional timeout in milliseconds (max ${MAX_BASH_TIMEOUT_MS} for a foreground command)`,
      ),
    /**
     * 用简短的简体中文描述这条命令做什么（主动语态，一般 5-15 个字）。
     * 无论对话、任务提示或系统提示用什么语言，description 一律写简体中文，不要输出英文。
     * 不要出现"复杂""风险"之类的评价词，只描述命令本身做什么。
     *
     * 简单命令保持精简：
     * - ls → "列出当前目录的文件"
     * - git status → "查看工作区状态"
     * - npm install → "安装项目依赖"
     *
     * 管道、冷门参数等不易一眼看懂的命令，补充说明它的目的：
     * - find . -name "*.tmp" -exec rm {} \; → "递归查找并删除所有 .tmp 文件"
     * - git reset --hard origin/main → "丢弃全部本地改动并重置到远程 main"
     * - curl -s url | jq '.data[]' → "请求 URL 并提取 JSON 数组元素"
     */
    description: z.string().optional().describe(BASH_DESCRIPTION_FIELD_PROMPT),
    /**
     * Set to true to run this command in the background. Use Read to read the output later.
     */
    run_in_background: semanticBoolean()
      .optional()
      .describe("Set to true to run this command in the background."),
    /**
     * Set this to true to dangerously override sandbox mode and run commands without sandboxing.
     */
    dangerouslyDisableSandbox: semanticBoolean()
      .optional()
      .describe(
        "Set this to true to dangerously override sandbox mode and run commands without sandboxing.",
      ),
  })
  .strict();

export type BashInput = z.infer<typeof BashInputSchema>;

export const BashInputJsonSchema = toToolJsonSchema(BashInputSchema);

function semanticNumber(schema: z.ZodNumber): z.ZodEffects<z.ZodNumber, number, unknown> {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (trimmed.length === 0) return value;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : value;
  }, schema);
}

function semanticBoolean(): z.ZodEffects<z.ZodBoolean, boolean, unknown> {
  return z.preprocess((value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
      return value;
    }
    if (typeof value !== "string") return value;

    const normalized = value.trim().toLowerCase();
    if (TRUE_BOOLEAN_STRINGS.has(normalized)) return true;
    if (FALSE_BOOLEAN_STRINGS.has(normalized)) return false;
    return value;
  }, z.boolean());
}

// -----------------------------------------------
// Output Types
// -----------------------------------------------

export interface BashOutput {
  /**
   * The standard output of the command
   */
  stdout: string;
  /**
   * The standard error output of the command
   */
  stderr: string;
  /**
   * Structured execution status
   */
  status?: "completed" | "failed" | "timed_out" | "cancelled" | "spawn_error" | "backgrounded";
  /**
   * Process exit code. Non-zero exits are represented here instead of thrown.
   */
  exitCode?: number;
  /**
   * Process exit signal, when available
   */
  signal?: string;
  /**
   * Whether timeout policy stopped the command
   */
  timedOut?: boolean;
  /**
   * Whether cancellation stopped the command
   */
  cancelled?: boolean;
  /**
   * Whether stdout was truncated for inline return
   */
  stdoutTruncated?: boolean;
  /**
   * Whether stderr was truncated for inline return
   */
  stderrTruncated?: boolean;
  /**
   * Total stdout bytes observed
   */
  stdoutBytes?: number;
  /**
   * Total stderr bytes observed
   */
  stderrBytes?: number;
  /**
   * Path to raw output file for large MCP tool outputs
   */
  rawOutputPath?: string;
  /**
   * Whether the command was interrupted
   */
  interrupted: boolean;
  /**
   * Flag to indicate if stdout contains image data
   */
  isImage?: boolean;
  /**
   * ID of the background task if command is running in background
   */
  backgroundTaskId?: string;
  /**
   * True if the user manually backgrounded the command with Ctrl+B
   */
  backgroundedByUser?: boolean;
  /**
   * True if assistant-mode auto-backgrounded a long-running blocking command
   */
  assistantAutoBackgrounded?: boolean;
  /**
   * 前台命令超过超时时间后被转到后台时，记录当时的超时毫秒数
   */
  timedOutAfterMs?: number;
  /**
   * Flag to indicate if sandbox mode was overridden
   */
  dangerouslyDisableSandbox?: boolean;
  /**
   * Semantic interpretation for non-error exit codes with special meaning
   */
  returnCodeInterpretation?: string;
  /**
   * Whether the command is expected to produce no output on success
   */
  noOutputExpected?: boolean;
  /**
   * Structured content blocks
   */
  structuredContent?: unknown[];
  /**
   * Path to the persisted full output in tool-results dir (set when output is too large for inline)
   */
  persistedOutputPath?: string;
  /**
   * Path to the persisted stdout stream, when stdout was written to an execution artifact.
   */
  stdoutPersistedOutputPath?: string;
  /**
   * Path to the persisted stderr stream, when stderr was written to an execution artifact.
   */
  stderrPersistedOutputPath?: string;
  /**
   * Total size of the output in bytes (set when output is too large for inline)
   */
  persistedOutputSize?: number;
  /**
   * Persisted stdout artifact bytes, when stdout was written to an execution artifact.
   */
  stdoutPersistedOutputSize?: number;
  /**
   * Persisted stderr artifact bytes, when stderr was written to an execution artifact.
   */
  stderrPersistedOutputSize?: number;
  /**
   * Model-facing note listing readFileState entries whose mtime bumped during this command
   */
  staleReadFileStateHint?: string;
  /**
   * gh 命令触发 GitHub API rate limit 时，追加给模型的 system-reminder。
   */
  ghRateLimitHint?: string;
}

export const BashOutputSchema = z
  .object({
    stdout: z.string(),
    stderr: z.string(),
    status: z
      .enum(["completed", "failed", "timed_out", "cancelled", "spawn_error", "backgrounded"])
      .optional(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    timedOut: z.boolean().optional(),
    cancelled: z.boolean().optional(),
    stdoutTruncated: z.boolean().optional(),
    stderrTruncated: z.boolean().optional(),
    stdoutBytes: z.number().int().nonnegative().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
    rawOutputPath: z.string().optional(),
    interrupted: z.boolean(),
    isImage: z.boolean().optional(),
    backgroundTaskId: z.string().optional(),
    backgroundedByUser: z.boolean().optional(),
    assistantAutoBackgrounded: z.boolean().optional(),
    // 输入 timeout 允许小数，这里原样记录；修复原因：带 .int() 时小数 timeout 超时转后台会被判为工具失败。
    timedOutAfterMs: z.number().positive().optional(),
    dangerouslyDisableSandbox: z.boolean().optional(),
    returnCodeInterpretation: z.string().optional(),
    noOutputExpected: z.boolean().optional(),
    structuredContent: z.array(z.unknown()).optional(),
    persistedOutputPath: z.string().optional(),
    stdoutPersistedOutputPath: z.string().optional(),
    stderrPersistedOutputPath: z.string().optional(),
    persistedOutputSize: z.number().int().nonnegative().optional(),
    stdoutPersistedOutputSize: z.number().int().nonnegative().optional(),
    stderrPersistedOutputSize: z.number().int().nonnegative().optional(),
    staleReadFileStateHint: z.string().optional(),
    ghRateLimitHint: z.string().optional(),
    perf: ToolExecutionTelemetrySchema.optional(),
  })
  .strict();

export const BashOutputJsonSchema = toToolJsonSchema(BashOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

export interface BashToolCall {
  id: ToolCallId;
  name: "Bash";
  input: BashInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface BashToolResult {
  toolCallId: ToolCallId;
  output: BashOutput;
  traceId: TraceId;
  durationMs: number;
}

// -----------------------------------------------
// Background Task
// -----------------------------------------------

export interface BackgroundTask {
  id: string;
  command: string;
  description?: string;
  startedAt: Date;
  status: "running" | "completed" | "failed" | "cancelled";
  exitCode?: number;
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
  completedAt?: Date;
}

// -----------------------------------------------
// Bash Errors
// -----------------------------------------------

export const BashErrorCode = {
  COMMAND_NOT_PARSABLE: "bash_command_not_parsable",
  COMMAND_TOO_COMPLEX: "bash_command_too_complex",
  COMMAND_INJECTION_RISK: "bash_command_injection_risk",
  READONLY_CHECK_FAILED: "bash_readonly_check_failed",
  UNC_PATH_BLOCKED: "bash_unc_path_blocked",
  HIGH_RISK_COMBINATION: "bash_high_risk_combination",
  SANDBOX_VIOLATION: "bash_sandbox_violation",
  TIMEOUT: "bash_timeout",
  USER_INTERRUPTED: "bash_user_interrupted",
  PROCESS_START_FAILED: "bash_process_start_failed",
  NON_ZERO_EXIT: "bash_non_zero_exit",
  OUTPUT_TOO_LARGE: "bash_output_too_large",
  PERMISSION_DENIED: "bash_permission_denied",
} as const;

export type BashErrorCode = (typeof BashErrorCode)[keyof typeof BashErrorCode];

// -----------------------------------------------
// Shell Permission Types
// -----------------------------------------------

export type ShellPermissionRule = {
  type: "allow" | "deny";
  pattern: string;
  description?: string;
};

export interface ShellPermissionPolicy {
  rules: ShellPermissionRule[];
  allowReadonly: boolean;
  sandboxEnabled: boolean;
  dangerousDisableSandboxAllowed: boolean;
}
