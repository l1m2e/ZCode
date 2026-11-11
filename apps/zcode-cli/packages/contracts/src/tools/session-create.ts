// ============================================================
// CreateSession - agent-spawned top-level session thread
// ============================================================
// 模型在当前会话中发起一个顶层会话线程（侧栏可见、落盘、可继续对话）。
// 子会话 taskType = spawned_thread，继承父会话模型选型与权限模式；
// 首轮结算后父会话收到恰好一次后台通知（见 21-session-create.md）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

const nonEmptyString = z.string().trim().min(1);

export const CREATE_SESSION_TOOL_NAME = "CreateSession";

export const CreateSessionInputSchema = z
  .object({
    prompt: nonEmptyString.describe(
      "The initial task for the new session thread. It becomes the first user message and starts running immediately. Write it as a complete, self-contained instruction: the new session has no context from this conversation.",
    ),
    title: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .optional()
      .describe(
        "Short session title shown in the sidebar, for example '核对 Mastra 实现方式'. Omit to derive the title from the first message.",
      ),
  })
  .strict();
export type CreateSessionToolInput = z.infer<typeof CreateSessionInputSchema>;
export const CreateSessionInputJsonSchema = toToolJsonSchema(CreateSessionInputSchema);

export const CreateSessionOutputSchema = z
  .object({
    sessionId: nonEmptyString,
    title: nonEmptyString,
    message: nonEmptyString,
  })
  .strict();
export type CreateSessionToolOutput = z.infer<typeof CreateSessionOutputSchema>;
export const CreateSessionOutputJsonSchema = toToolJsonSchema(CreateSessionOutputSchema);
