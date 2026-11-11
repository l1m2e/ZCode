import { GitBranchIcon } from "lucide-react";
import { TID_SESSION_CREATE_CARD, TID_SESSION_CREATE_OPEN } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

// CreateSession 的静态轮尾卡（cron-create / offpeak-create 兄弟实现，样式契约一致）。
// 卡片是创建时快照：子会话的运行状态由侧栏与通知承载，历史回看不产生过期活数据。

export interface SessionCreateSummary {
  sessionId?: string;
  title?: string;
}

function normalizeToolName(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/gu, "") : "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSessionCreateToolCall(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): boolean {
  return [toolCall.toolName, toolCall.kind, toolCall.title].some(
    (value) => normalizeToolName(value) === "createsession",
  );
}

function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeOutputCandidate(value: unknown): unknown {
  return typeof value === "string" ? parseJsonString(value) : value;
}

export function readSessionCreateOutputSummary(value: unknown): SessionCreateSummary | null {
  const normalized = normalizeOutputCandidate(value);
  if (!isPlainRecord(normalized)) return null;
  const sessionId =
    typeof normalized.sessionId === "string" && normalized.sessionId.trim()
      ? normalized.sessionId.trim()
      : undefined;
  // 卡片必须能定位会话；缺 id 视为无效输出，回退普通工具行。
  if (!sessionId) return null;
  const title =
    typeof normalized.title === "string" && normalized.title.trim()
      ? normalized.title.trim()
      : undefined;
  return { sessionId, ...(title ? { title } : {}) };
}

export function readSessionCreateSummary(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): SessionCreateSummary | null {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawResult = isPlainRecord(raw?.result) ? raw.result : null;
  const candidates = [
    toolCall.output,
    raw?.rawOutput,
    raw?.output,
    rawResult?.content,
    rawResult?.display,
    raw?.result,
    toolCall.content,
  ];
  for (const candidate of candidates) {
    const summary = readSessionCreateOutputSummary(candidate);
    if (summary) return summary;
  }
  return null;
}

export function SessionCreateThreadCard({
  session,
  onOpenSession,
}: {
  session: SessionCreateSummary;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const title = session.title ?? intl.formatMessage({ id: "sessionCreate.card.title" });
  const canOpen = Boolean(onOpenSession && session.sessionId);

  return (
    <div
      data-testid={TID_SESSION_CREATE_CARD}
      className="my-1 w-full rounded-xl border border-border/70 bg-card/70 px-3 py-3 shadow-sm backdrop-blur-sm"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
          <GitBranchIcon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-base font-medium text-foreground">{title}</div>
          <div className="mt-0.5 truncate text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "sessionCreate.card.running" })}
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={TID_SESSION_CREATE_OPEN}
          className="h-auto rounded-lg border-border/70 bg-transparent px-3 py-1.5 text-ui-base text-foreground hover:bg-hover hover:text-foreground"
          disabled={!canOpen}
          onClick={() => session.sessionId && onOpenSession?.(session.sessionId)}
        >
          <span>{intl.formatMessage({ id: "sessionCreate.card.open" })}</span>
        </Button>
      </div>
    </div>
  );
}
