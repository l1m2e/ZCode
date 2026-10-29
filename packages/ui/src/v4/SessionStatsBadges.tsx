import { memo, useMemo, type ReactNode } from "react";
import { DatabaseIcon, GaugeIcon } from "lucide-react";
import type { SessionUsageState } from "@zcode/shared/zcode-protocol-v4";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";
import { useSessionStats } from "@/v4/sessionStatsStore.js";

/**
 * dsh 风格的会话统计与 Token 用量状态芯片（composer 工具条，官方 context 圆环旁）。
 *
 * - 芯片 1：`N 轮 M 步 · X tok/s`，悬浮展开「会话统计」面板（模型用时 / 工具调用用时 /
 *   首 token 平均 / 输出速度），数据来自 sessionStatsStore 的事实归账；
 * - 芯片 2：`X tok · 缓存命中 N%`，悬浮展开「Token 用量」面板（缓存命中 / 未缓存输入 /
 *   缓存读取 / 输出），数据来自协议 v4 snapshot 的 usage.cumulative（inputTokens 已含
 *   cache read/write，与官方 hitRate 口径一致）。
 *
 * 文案沿用上一代 t/s 徽章的做法直接内置中文，不进 i18n 词典，避免改动官方 locale 文件。
 */

/** 时长展示：60 秒内取整秒，其后 `M 分 S 秒`（与 dsh 中文面板一致，不进位到小时）。 */
function formatStatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1_000));
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  return `${Math.floor(totalSeconds / 60)} 分 ${totalSeconds % 60} 秒`;
}

/** 吞吐展示：≥10 tok/s 取整，其余保留一位小数。 */
function formatTokensPerSecond(tps: number): string {
  return String(tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10);
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-8 text-ui-sm">
      <span className="text-tooltip-foreground/70">{label}</span>
      <span className="tabular-nums text-tooltip-foreground">{value}</span>
    </div>
  );
}

const Chip = ({
  children,
  panel,
  testId,
}: {
  children: ReactNode;
  panel: ReactNode;
  testId: string;
}) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span
        className="inline-flex shrink-0 cursor-default items-center gap-1.5 rounded-md px-1 text-ui-xs leading-none text-foreground-subtle tabular-nums"
        data-testid={testId}
      >
        {children}
      </span>
    </TooltipTrigger>
    <TooltipContent
      side="top"
      align="start"
      sideOffset={6}
      className="w-72 flex-col items-stretch gap-2 rounded-xl px-4 py-3"
    >
      {panel}
    </TooltipContent>
  </Tooltip>
);

function SessionStatsChip({ sessionId }: { sessionId: string }) {
  const stats = useSessionStats(sessionId);
  if (stats.steps === 0 && stats.turns === 0) {
    return null;
  }
  const labelParts = [`${stats.turns} 轮 ${stats.steps} 步`];
  if (stats.tokensPerSecond !== null) {
    labelParts.push(`${formatTokensPerSecond(stats.tokensPerSecond)} tok/s`);
  }
  return (
    <Chip testId="chat-toolbar-session-stats" panel={
      <>
        <div className="flex items-center gap-2 text-ui-sm font-medium text-tooltip-foreground">
          <GaugeIcon className="size-4 shrink-0" aria-hidden="true" />
          <span>会话统计</span>
        </div>
        <div className="space-y-1.5 border-t border-tooltip-foreground/15 pt-2">
          {stats.llmMs > 0 ? (
            <StatRow label="模型用时" value={formatStatDuration(stats.llmMs)} />
          ) : null}
          {stats.toolMs > 0 ? (
            <StatRow label="工具调用用时" value={formatStatDuration(stats.toolMs)} />
          ) : null}
          {stats.ttftMs !== null ? (
            <StatRow label="首 token 平均（TTFT）" value={formatStatDuration(stats.ttftMs)} />
          ) : null}
          {stats.tokensPerSecond !== null ? (
            <StatRow
              label="输出速度（TPS）"
              value={`${formatTokensPerSecond(stats.tokensPerSecond)} tok/s`}
            />
          ) : null}
        </div>
      </>
    }>
      <GaugeIcon className="size-3 shrink-0 opacity-80" aria-hidden="true" />
      <span>{labelParts.join(" · ")}</span>
    </Chip>
  );
}

/** usage.cumulative 的展示投影；token 全零时芯片整体隐藏。 */
function resolveTokenUsageSummary(usage: SessionUsageState | null): {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheHitPercent: number | null;
} | null {
  const cumulative = usage?.cumulative;
  if (!cumulative) {
    return null;
  }
  const totalTokens = cumulative.inputTokens + cumulative.outputTokens;
  if (totalTokens <= 0) {
    return null;
  }
  return {
    totalTokens,
    inputTokens: cumulative.inputTokens,
    outputTokens: cumulative.outputTokens,
    // inputTokens 为 provider 归一后的总量（含 cache read/write）；负差值按 0 展示。
    uncachedInputTokens: Math.max(
      0,
      cumulative.inputTokens - cumulative.cacheReadTokens - cumulative.cacheWriteTokens,
    ),
    cacheReadTokens: cumulative.cacheReadTokens,
    cacheHitPercent:
      cumulative.inputTokens > 0
        ? Math.round((cumulative.cacheReadTokens / cumulative.inputTokens) * 100)
        : null,
  };
}

function TokenUsageChip({
  usage,
  locale,
}: {
  usage: SessionUsageState | null;
  locale: string;
}) {
  const summary = useMemo(() => resolveTokenUsageSummary(usage), [usage]);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  if (!summary) {
    return null;
  }
  const compactTotal = `${formatCompactTokenNumber("en-US", summary.totalTokens)} tok`;
  return (
    <Chip testId="chat-toolbar-token-usage" panel={
      <>
        <div className="flex items-center gap-2 text-ui-sm font-medium text-tooltip-foreground">
          <DatabaseIcon className="size-4 shrink-0" aria-hidden="true" />
          <span>Token 用量</span>
          <span className="ml-auto pl-4 font-mono tabular-nums">
            {numberFormatter.format(summary.totalTokens)} tok
          </span>
        </div>
        <div className="space-y-1.5 border-t border-tooltip-foreground/15 pt-2">
          {summary.cacheHitPercent !== null ? (
            <StatRow label="缓存命中" value={`${summary.cacheHitPercent}%`} />
          ) : null}
          <StatRow
            label="未缓存输入"
            value={`${numberFormatter.format(summary.uncachedInputTokens)} tok`}
          />
          <StatRow
            label="缓存读取"
            value={`${numberFormatter.format(summary.cacheReadTokens)} tok`}
          />
          <StatRow
            label="输出"
            value={`${numberFormatter.format(summary.outputTokens)} tok`}
          />
        </div>
      </>
    }>
      <DatabaseIcon className="size-3 shrink-0 opacity-80" aria-hidden="true" />
      <span>
        {summary.cacheHitPercent !== null
          ? `${compactTotal} · 缓存命中 ${summary.cacheHitPercent}%`
          : compactTotal}
      </span>
    </Chip>
  );
}

/** 官方 context 圆环旁的两枚 dsh 风格统计芯片；无数据时各自隐藏。 */
export const SessionStatsBadges = memo(function SessionStatsBadges({
  sessionId,
  usage,
}: {
  sessionId: string | null;
  usage: SessionUsageState | null;
}) {
  const { locale } = useZCodeIntl();
  return (
    <>
      {sessionId ? <SessionStatsChip sessionId={sessionId} /> : null}
      <TokenUsageChip usage={usage} locale={locale} />
    </>
  );
});
