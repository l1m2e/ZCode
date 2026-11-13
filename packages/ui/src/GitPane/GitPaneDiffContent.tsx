import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type RefObject,
  type UIEventHandler,
} from "react";
import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import type { GitDiffResult } from "@zcode/shared";
import { TID_GIT_REVIEW_COMMENT_DRAFT } from "@zcode/shared/test-ids";
import { nanoid } from "nanoid";
import { ArrowLeftIcon, ExternalLinkIcon, FileTextIcon } from "lucide-react";
import { DiffViewer, type DiffViewerSelectedLineRange } from "@/components/ui/diff-viewer.js";
import {
  CommentDraft,
  normalizeCodeCommentRange,
  type CodeCommentLabels,
} from "@/components/ui/code-comment.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import { dispatchCodeCommentAddToChat, type CodeCommentPayload } from "@/lib/codeCommentContext.js";
import {
  extractLinesFromContent,
  extractLinesFromPatch,
  parseCommentablePatch,
  getDiffFallbackMessageId,
  getGitPaneDiffPreviewPlan,
} from "@/GitPane/helpers.js";
import type { GitPaneFileChange } from "@/hooks/useGitRepository.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { GitDiffDisplayStyle } from "@/lib/gitReviewSettings.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { ResolvedTheme } from "@/useTheme.js";
import { HighlightedLightweightDiffPreview } from "@/components/ui/highlighted-lightweight-diff-preview.js";
import { inferCodeLanguage } from "@/lib/codeViewer.js";
import { GitPaneDiffOverview } from "./GitPaneDiffOverview.js";
import { useGitDiffOverview } from "./useGitDiffOverview.js";

interface SelectionCommentDraft {
  id: string;
  range: { startLine: number; endLine: number };
  side: "L" | "R";
  selectedText: string;
}

function resolveDraftFromSelection(
  range: SelectedLineRange,
  diffState: GitDiffResult,
  patch: FileDiffMetadata | null,
): SelectionCommentDraft | null {
  const side = range.side ?? "additions";
  // 跨版本端点没有可靠的一一行号映射；近似换算会把未选中的代码作为引用发送。
  if ((range.endSide ?? side) !== side) return null;
  const normalized = normalizeCodeCommentRange({ startLine: range.start, endLine: range.end });
  const content = side === "deletions" ? diffState.beforeContent : diffState.afterContent;
  // patch 视图只引用实际展示的连续行，即便其他来源有全文也不能跨省略区间引用。
  const selectedText = patch
    ? extractLinesFromPatch(patch, side, normalized.startLine, normalized.endLine)
    : extractLinesFromContent(content, normalized.startLine, normalized.endLine);
  if (selectedText === null) return null;
  return {
    id: nanoid(),
    range: normalized,
    side: side === "deletions" ? "L" : "R",
    selectedText,
  };
}

export function GitPaneDiffContent({
  change,
  diffState,
  isDiffLoading,
  codePreviewSettings,
  resolvedTheme,
  diffStyle,
  workspacePath,
  workspaceIdentity,
  sourcePath,
  narrowLayout = false,
  onBackToList,
  onOpenFilePreview,
  showHeader = true,
  renderHeavyContent = true,
  preferFullContent = false,
  scrollContainerRef,
  onScroll,
}: {
  change: Pick<GitPaneFileChange, "path" | "workspaceRelativePath"> &
    Partial<Pick<GitPaneFileChange, "added" | "removed">>;
  diffState: GitDiffResult | null;
  isDiffLoading: boolean;
  codePreviewSettings: CodePreviewSettings;
  resolvedTheme: ResolvedTheme;
  diffStyle: GitDiffDisplayStyle;
  workspacePath?: string;
  workspaceIdentity?: string;
  sourcePath?: string;
  narrowLayout?: boolean;
  onBackToList?: () => void;
  onOpenFilePreview?: () => void;
  showHeader?: boolean;
  renderHeavyContent?: boolean;
  preferFullContent?: boolean;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  onScroll?: UIEventHandler<HTMLDivElement>;
}) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState<SelectionCommentDraft | null>(null);
  const [draftCommentValue, setDraftCommentValue] = useState("");
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const diffPreviewPlan = useMemo(
    () => getGitPaneDiffPreviewPlan(diffState, preferFullContent),
    [diffState, preferFullContent],
  );
  const commentablePatch = useMemo(
    () =>
      diffPreviewPlan.kind === "patch" && diffState?.patch
        ? parseCommentablePatch(diffState.patch)
        : null,
    [diffPreviewPlan.kind, diffState?.patch],
  );
  // 审查曾强制 wrap，导致全局开关无效；富 diff 与降级预览统一读取同一偏好。
  const diffOverflow = codePreviewSettings.wrapLongLines ? "wrap" : "scroll";
  const beforeContent = diffState?.beforeContent;
  const afterContent = diffState?.afterContent;
  const patchContent = diffState?.patch;
  const multiFileDiffFiles = useMemo(() => {
    if (beforeContent == null || afterContent == null) return null;
    // 前后各百字与长度相同不代表内容相同；内容版本变化时生成新 key，防止复用旧高亮。
    const version = nanoid();
    return {
      oldFile: {
        name: change.workspaceRelativePath,
        contents: beforeContent,
        cacheKey: `old:${version}`,
      },
      newFile: {
        name: change.workspaceRelativePath,
        contents: afterContent,
        cacheKey: `new:${version}`,
      },
    };
  }, [afterContent, beforeContent, change.workspaceRelativePath]);
  const canCommentOnDiff =
    ((diffPreviewPlan.kind === "rich" && multiFileDiffFiles !== null) ||
      commentablePatch !== null) &&
    Boolean(workspacePath && sourcePath);
  const overviewVersion = useMemo(
    () => ({ diffState, diffStyle, path: change.path, workspacePath, workspaceIdentity }),
    [change.path, diffState, diffStyle, workspaceIdentity, workspacePath],
  );
  const overview = useGitDiffOverview({
    enabled: renderHeavyContent && !isDiffLoading && diffState?.availability === "patch",
    contentVersion: overviewVersion,
    plainTextLines: diffPreviewPlan.kind === "plain-text" ? diffPreviewPlan.lines : undefined,
  });

  const overviewScrollRef = overview.scrollRef;
  const attachScrollContainer = useCallback(
    (element: HTMLDivElement | null) => {
      overviewScrollRef.current = element;
      if (scrollContainerRef) scrollContainerRef.current = element;
    },
    [overviewScrollRef, scrollContainerRef],
  );

  const clearDraft = useCallback(() => {
    setDraft(null);
    setDraftCommentValue("");
    setSelectionError(null);
  }, []);
  useEffect(() => {
    // 切换文件、身份或内容版本后，旧选区不得继续附在新版本上。
    clearDraft();
  }, [
    afterContent,
    beforeContent,
    patchContent,
    change.path,
    sourcePath,
    clearDraft,
    workspaceIdentity,
    workspacePath,
  ]);

  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      if (!range || !diffState || !canCommentOnDiff) return;
      const nextDraft = resolveDraftFromSelection(range, diffState, commentablePatch);
      if (!nextDraft) {
        const side = range.side ?? "additions";
        setSelectionError(
          (range.endSide ?? side) !== side
            ? "git.review.selectOneVersion"
            : "git.review.selectAvailableLines",
        );
        return;
      }
      setDraft(nextDraft);
      setDraftCommentValue("");
      setSelectionError(null);
    },
    [canCommentOnDiff, commentablePatch, diffState],
  );
  const handleSubmitDraft = useCallback(() => {
    if (!draft || !workspacePath || !sourcePath) return;
    const payload: CodeCommentPayload = {
      id: draft.id,
      workspacePath,
      workspaceIdentity,
      sourcePath,
      sourceTitle:
        change.workspaceRelativePath.split(/[\\/]/).pop() ?? change.workspaceRelativePath,
      startLine: draft.range.startLine,
      endLine: draft.range.endLine,
      selectedText: draft.selectedText,
      comment: draftCommentValue.trim(),
      side: draft.side,
      contextLabel: intl.formatMessage({ id: "codeViewer.comment.contextLabel" }),
      commentLabel: intl.formatMessage({ id: "codeViewer.comment.commentLabel" }),
    };
    // 只有当前 composer 确认接收才销毁草稿，否则会静默丢失用户写的评论。
    if (!dispatchCodeCommentAddToChat(payload)) {
      setSelectionError("git.review.noComposer");
      return;
    }
    clearDraft();
  }, [
    change,
    clearDraft,
    draft,
    draftCommentValue,
    intl,
    sourcePath,
    workspaceIdentity,
    workspacePath,
  ]);

  const labels = useMemo<CodeCommentLabels>(
    () => ({
      addComment: intl.formatMessage({ id: "codeViewer.comment.add" }),
      addCommentTooltip: intl.formatMessage({ id: "codeViewer.comment.addTooltip" }),
      commentPlaceholder: intl.formatMessage({ id: "codeViewer.comment.placeholder" }),
      submitComment: intl.formatMessage({ id: "codeViewer.comment.submit" }),
      cancelComment: intl.formatMessage({ id: "common.cancel" }),
      deleteComment: intl.formatMessage({ id: "codeViewer.comment.delete" }),
      commentLine: intl.formatMessage({ id: "codeViewer.comment.line" }),
      commentRange: intl.formatMessage({ id: "codeViewer.comment.range" }),
    }),
    [intl],
  );
  const annotationSide = draft?.side === "L" ? "deletions" : "additions";
  const lineAnnotations = useMemo<DiffLineAnnotation[]>(
    () => (draft ? [{ side: annotationSide, lineNumber: draft.range.endLine }] : []),
    [annotationSide, draft],
  );
  const selectedLines = useMemo<DiffViewerSelectedLineRange | null>(
    () =>
      draft
        ? { start: draft.range.startLine, end: draft.range.endLine, side: annotationSide }
        : null,
    [annotationSide, draft],
  );
  const renderAnnotation = useCallback(
    () =>
      draft ? (
        <div data-testid={TID_GIT_REVIEW_COMMENT_DRAFT}>
          <CommentDraft
            range={draft.range}
            labels={labels}
            value={draftCommentValue}
            onValueChange={setDraftCommentValue}
            onSubmit={handleSubmitDraft}
            onCancel={clearDraft}
          />
        </div>
      ) : null,
    [clearDraft, draft, draftCommentValue, handleSubmitDraft, labels],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      {showHeader ? (
        <div
          data-git-review-diff-header={change.path}
          className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-2"
        >
          {narrowLayout ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={intl.formatMessage({ id: "git.review.backToList" })}
              title={intl.formatMessage({ id: "git.review.backToList" })}
              onClick={onBackToList}
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            <FileDisplayInline
              path={change.workspaceRelativePath}
              options={{
                showFilePath: true,
                className: "inline-flex min-w-0 max-w-full items-center gap-2",
                fileNameClassName: "truncate text-ui-base text-foreground",
                filePathClassName: "truncate text-ui-base text-foreground-subtlest",
              }}
            />
          </div>
          <div className="shrink-0 whitespace-nowrap text-ui-base">
            <span className="text-diff-added">+{change.added}</span>
            <span className="ml-2 text-diff-removed">-{change.removed}</span>
          </div>
          {onOpenFilePreview ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title={intl.formatMessage({ id: "git.review.openPreview" })}
              aria-label={intl.formatMessage({ id: "git.review.openPreview" })}
              onClick={onOpenFilePreview}
            >
              <ExternalLinkIcon className="size-4" />
            </Button>
          ) : null}
        </div>
      ) : null}
      {selectionError ? (
        <div
          role="status"
          data-git-review-selection-error
          className="shrink-0 px-3 py-2 text-ui-base text-foreground-subtle"
        >
          {intl.formatMessage({ id: selectionError })}
        </div>
      ) : null}
      {/* 正文统一由这一层滚动，避免内层 DiffViewer 滚动后概览仍读取外层的旧位置。 */}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          ref={attachScrollContainer}
          onScroll={renderHeavyContent ? onScroll : undefined}
          data-git-review-diff-scroll
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-y-auto",
            diffPreviewPlan.kind === "plain-text" && !codePreviewSettings.wrapLongLines
              ? "overflow-x-auto"
              : "overflow-x-hidden",
          )}
        >
          <div ref={overview.contentRef} className="min-w-0">
            {!renderHeavyContent ? null : isDiffLoading ? (
              <div className="flex items-center justify-center py-6 text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "common.loading" })}
              </div>
            ) : diffState?.availability === "patch" && diffPreviewPlan.kind === "plain-text" ? (
              <HighlightedLightweightDiffPreview
                language={inferCodeLanguage(change.workspaceRelativePath)}
                path={change.workspaceRelativePath}
                theme={
                  resolvedTheme === "dark"
                    ? codePreviewSettings.darkTheme
                    : codePreviewSettings.lightTheme
                }
                codePreviewSettings={codePreviewSettings}
                className={cn(
                  "overflow-visible",
                  codePreviewSettings.wrapLongLines &&
                    "[&_code]:min-w-0 [&_code]:[overflow-wrap:anywhere]",
                )}
                data-git-review-plain-text-diff-preview
                lines={diffPreviewPlan.lines}
              />
            ) : diffState?.availability === "patch" &&
              diffPreviewPlan.kind === "patch" &&
              diffState.patch ? (
              <DiffViewer
                patch={diffState.patch}
                diffStyle={diffStyle}
                enableLineSelection={canCommentOnDiff}
                enableGutterUtility={canCommentOnDiff}
                onLineSelectionEnd={handleLineSelectionEnd}
                onGutterUtilityClick={canCommentOnDiff ? handleLineSelectionEnd : undefined}
                selectedLines={selectedLines}
                lineAnnotations={lineAnnotations}
                renderAnnotation={renderAnnotation}
                overflow={diffOverflow}
                splitReverse={diffStyle === "split"}
                diffClassName="block"
                className="h-auto overflow-visible"
                options={overview.diffOptions}
                fontSizePx={codePreviewSettings.fontSizePx}
                lightTheme={codePreviewSettings.lightTheme}
                darkTheme={codePreviewSettings.darkTheme}
                themeType={resolvedTheme}
              />
            ) : diffState?.availability === "patch" && multiFileDiffFiles ? (
              <DiffViewer
                oldFile={multiFileDiffFiles.oldFile}
                newFile={multiFileDiffFiles.newFile}
                diffStyle={diffStyle}
                expandUnchanged
                overflow={diffOverflow}
                splitReverse={diffStyle === "split"}
                enableLineSelection={canCommentOnDiff}
                enableGutterUtility={canCommentOnDiff}
                onLineSelectionEnd={handleLineSelectionEnd}
                onGutterUtilityClick={canCommentOnDiff ? handleLineSelectionEnd : undefined}
                selectedLines={selectedLines}
                lineAnnotations={lineAnnotations}
                renderAnnotation={renderAnnotation}
                diffClassName="block"
                className="h-auto overflow-visible"
                options={overview.diffOptions}
                fontSizePx={codePreviewSettings.fontSizePx}
                lightTheme={codePreviewSettings.lightTheme}
                darkTheme={codePreviewSettings.darkTheme}
                themeType={resolvedTheme}
              />
            ) : (
              <div className="px-4 py-3 text-ui-base text-foreground-subtle">
                {intl.formatMessage({
                  id: getDiffFallbackMessageId(diffState?.availability ?? "unavailable"),
                })}
              </div>
            )}
          </div>
        </div>
        <GitPaneDiffOverview geometry={overview.geometry} onScrollTo={overview.scrollTo} />
      </div>
    </div>
  );
}

export function GitPaneDiffEmptyState({ onBackToList }: { onBackToList: () => void }) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <FileTextIcon className="size-8 text-foreground-subtlest" />
      <p className="mt-3 text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "git.review.emptySelectionTitle" })}
      </p>
      <p className="mt-1 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "git.review.emptySelectionDescription" })}
      </p>
      <Button type="button" variant="ghost" className="mt-3" onClick={onBackToList}>
        {intl.formatMessage({ id: "git.review.backToList" })}
      </Button>
    </div>
  );
}
