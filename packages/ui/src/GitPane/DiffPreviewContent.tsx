import { useMemo, type RefObject, type UIEventHandler } from "react";
import type { GitDiffResult } from "@zcode/shared";
import type { PatchCodeViewerSource, MultiFileDiffCodeViewerSource } from "@/lib/codeViewer.js";
import { buildUnifiedDiff, createDiffSourceFilePreviewSource } from "@/lib/codeViewer.js";
import { isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { GitDiffDisplayStyle } from "@/lib/gitReviewSettings.js";
import { useHistoricalDiffContent } from "@/hooks/useZCodeAgentService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { GitPaneDiffContent } from "./GitPaneDiffContent.js";

/** 历史版本只由 source 或 checkpoint 查询提供，不能读取当前磁盘补全旧编辑。 */
export function DiffPreviewContent({
  source,
  workspacePath,
  codePreviewSettings,
  resolvedTheme,
  diffStyle,
  renderHeavyContent,
  scrollContainerRef,
  onScroll,
}: {
  source: PatchCodeViewerSource | MultiFileDiffCodeViewerSource;
  workspacePath?: string;
  codePreviewSettings: CodePreviewSettings;
  resolvedTheme: "light" | "dark";
  diffStyle: GitDiffDisplayStyle;
  renderHeavyContent: boolean;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  onScroll?: UIEventHandler<HTMLDivElement>;
}) {
  const { intl } = useZCodeIntl();
  const { state: historicalContent, retry } = useHistoricalDiffContent(
    source.type === "patch" ? source : null,
  );
  const sourceWorkspacePath = source.workspacePath ?? workspacePath;
  const fileSource = useMemo(() => createDiffSourceFilePreviewSource(source), [source]);
  const path = fileSource?.path;
  const sourcePath =
    path && sourceWorkspacePath && !isAbsoluteFilePath(path)
      ? joinFilePath(sourceWorkspacePath, path)
      : path;
  const change = useMemo(
    () => ({
      path: path ?? source.title,
      workspaceRelativePath: path ?? source.title,
    }),
    [path, source.title],
  );
  const beforeContent =
    source.type === "multi-file-diff"
      ? source.beforeContent
      : historicalContent.status === "available"
        ? historicalContent.beforeContent
        : null;
  const afterContent =
    source.type === "multi-file-diff"
      ? source.afterContent
      : historicalContent.status === "available"
        ? historicalContent.afterContent
        : null;
  const diffState = useMemo<GitDiffResult>(
    () => ({
      path: source.path ?? source.title,
      availability: "patch",
      patch:
        source.type === "patch"
          ? source.patch
          : buildUnifiedDiff(
              source.beforeContent,
              source.afterContent,
              source.path ?? source.title,
              { contextLines: 3 },
            ),
      beforeContent,
      afterContent,
    }),
    [source, beforeContent, afterContent],
  );
  const historyStatus =
    source.type === "patch" && historicalContent.status !== "available"
      ? historicalContent.status
      : null;
  // 同 path/patch 的不同历史 row 仍是不同评论生命周期；隐藏重内容不参与 key。
  const contentKey = JSON.stringify([
    source.workspaceIdentity?.trim() || sourceWorkspacePath,
    source.workspaceRemoteSessionId,
    source.path,
    source.type === "patch" ? source.conversation : null,
  ]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {historyStatus && renderHeavyContent ? (
        <div
          role="status"
          data-historical-diff-status={historyStatus}
          className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-ui-sm text-foreground-subtle"
        >
          <span className="min-w-0 flex-1">
            {intl.formatMessage({ id: `codeViewer.history.${historyStatus}` })}
          </span>
          {historyStatus === "error" ? (
            <Button type="button" variant="ghost" size="sm" onClick={retry}>
              {intl.formatMessage({ id: "codeViewer.history.retry" })}
            </Button>
          ) : null}
        </div>
      ) : null}
      <GitPaneDiffContent
        key={contentKey}
        change={change}
        diffState={diffState}
        isDiffLoading={historyStatus === "loading" || historyStatus === "waiting"}
        preferFullContent={true}
        codePreviewSettings={codePreviewSettings}
        resolvedTheme={resolvedTheme}
        diffStyle={diffStyle}
        workspacePath={sourceWorkspacePath}
        workspaceIdentity={source.workspaceIdentity}
        sourcePath={sourcePath}
        showHeader={false}
        renderHeavyContent={renderHeavyContent}
        scrollContainerRef={scrollContainerRef}
        onScroll={onScroll}
      />
    </div>
  );
}
