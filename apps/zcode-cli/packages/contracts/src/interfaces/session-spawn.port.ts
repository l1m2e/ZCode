// ============================================================
// SessionSpawn Port - in-process top-level session thread creation
// ============================================================
// CreateSession 工具的宿主能力边界：bootstrap 在 CLI 进程内构造 v4 createSession
// 信封并经既有 V4CommandExecutor 执行（CommandInbox 幂等与账本不旁路）。
// 返回判别联合而非抛错：守卫拒绝（递归 / 并发上限）与执行失败必须分类保真到
// handler，供模型收到稳定、可行动的错误提示（同 OffPeakPort 先例）。

export type SessionSpawnErrorCategory =
  | "recursion"
  | "concurrency_limit"
  | "create_rejected"
  | "rename_failed"
  | "unknown";

export type SessionSpawnOutcome =
  | { ok: true; sessionId: string; title: string }
  | {
      ok: false;
      errorCategory: SessionSpawnErrorCategory;
      message: string;
    };

export interface SessionSpawnRequest {
  /** 初始任务文本；作为子会话首条用户输入立即启动首轮。 */
  prompt: string;
  /** 可选侧栏标题；缺省走 first_input / 自动生成链路。 */
  title?: string;
  /** 父会话 ID；落 session 表 parent_id，也是完成通知的投递目标。 */
  parentSessionId: string;
  /** 父会话本轮工具调用 ID；createSession 信封的 commandId（幂等键）。 */
  sourceToolCallId: string;
}

export interface SessionSpawnPort {
  create(request: SessionSpawnRequest): Promise<SessionSpawnOutcome>;
}
