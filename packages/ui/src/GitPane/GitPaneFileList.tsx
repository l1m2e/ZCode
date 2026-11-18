import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronRight,
  FileSymlink,
  CopyIcon,
  FolderOpenIcon,
  ListTreeIcon,
  Search,
  X,
} from "lucide-react";
import { TID_GIT_REVIEW_FILE_FILTER, TID_GIT_REVIEW_FILE_LIST } from "@zcode/shared/test-ids";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import type { GitPaneFileChange } from "@/hooks/useGitRepository.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkspaceFileGitStatus } from "@/workspace-file-tree/model.js";
import { getWorkspaceFileGitStatusTextClassName } from "@/workspace-file-tree/statusStyles.js";

const GIT_REVIEW_FILE_ROW_HEIGHT_PX = 32;
const GIT_REVIEW_FILE_ROW_OVERSCAN = 12;

/** 未跟踪状态优先于 added，文件名配色与文件树保持一致。 */
function getChangeFileGitStatus(
  change: GitPaneFileChange,
  sourceControl = false,
): WorkspaceFileGitStatus {
  if (change.isUntracked) return "untracked";
  // AM 等双侧状态的 kind 优先 index；SCM 必须按当前来源选择 x/y，避免未暂存误标 A。
  const code = sourceControl ? (change.isStaged ? change.x : change.y) : undefined;
  return code === "M"
    ? "modified"
    : code === "A"
      ? "added"
      : code === "D"
        ? "deleted"
        : code === "R"
          ? "renamed"
          : change.kind;
}

export interface GitPaneFileListProps {
  changes: readonly GitPaneFileChange[];
  selectedPath: string | null;
  selectedSection?: string;
  renderGroupHeader?: (section: string, changes: readonly GitPaneFileChange[]) => ReactNode;
  renderActions?: (change: GitPaneFileChange) => ReactNode;
  collapsedSections?: ReadonlySet<string>;
  onToggleSection?: (section: string) => void;
  /**
   * 调用方已过滤掉全部条目但仍有原始改动时展示专用空状态，
   * 避免把“被展示过滤隐藏”误报成“没有改动”。
   */
  emptyState?: ReactNode;
  onOpenFile?: (change: GitPaneFileChange) => void;
  filterQuery: string;
  onFilterQueryChange: (query: string) => void;
  /** 外部（文件变更查找）请求把某个路径滚动到可视区；requestId 变化触发一次。 */
  revealRequest: { path: string; requestId: number } | null;
  onSelect: (change: GitPaneFileChange) => void;
  contextMenuLabels: {
    copyAbsolutePath: string;
    copyRelativePath: string;
    revealInFileManager: string;
    revealInFileTree: string;
  };
  canRevealInFileManager: (change: GitPaneFileChange) => boolean;
  onCopyAbsolutePath: (change: GitPaneFileChange) => void;
  onCopyRelativePath: (change: GitPaneFileChange) => void;
  onRevealInFileManager: (change: GitPaneFileChange) => void;
  onRevealInFileTree?: (change: GitPaneFileChange) => void;
}

export function GitPaneFileList({
  changes,
  selectedPath,
  selectedSection,
  renderGroupHeader,
  renderActions,
  collapsedSections,
  onToggleSection,
  emptyState,
  onOpenFile,
  filterQuery,
  onFilterQueryChange,
  revealRequest,
  onSelect,
  contextMenuLabels,
  canRevealInFileManager,
  onCopyAbsolutePath,
  onCopyRelativePath,
  onRevealInFileManager,
  onRevealInFileTree,
}: GitPaneFileListProps) {
  const { intl } = useZCodeIntl();
  const normalizedFilterQuery = filterQuery.trim().toLocaleLowerCase();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const filteredChanges = useMemo(() => {
    if (!normalizedFilterQuery) {
      return changes;
    }

    return changes.filter((change) =>
      change.workspaceRelativePath.toLocaleLowerCase().includes(normalizedFilterQuery),
    );
  }, [changes, normalizedFilterQuery]);

  const rows = useMemo(() => {
    const result: Array<
      { change: GitPaneFileChange } | { section: string; changes: GitPaneFileChange[] }
    > = [];
    for (const change of filteredChanges) {
      if (
        renderGroupHeader &&
        !result.some((row) => "section" in row && row.section === change.section)
      ) {
        result.push({
          section: change.section,
          changes: filteredChanges.filter((file) => file.section === change.section),
        });
      }
      if (!collapsedSections?.has(change.section)) result.push({ change });
    }
    return result;
  }, [filteredChanges, renderGroupHeader, collapsedSections]);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getItemKey: (index) => {
      const row = rows[index];
      return row
        ? "change" in row
          ? `${row.change.section}:${row.change.path}`
          : row.section
        : String(index);
    },
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GIT_REVIEW_FILE_ROW_HEIGHT_PX,
    overscan: GIT_REVIEW_FILE_ROW_OVERSCAN,
  });

  useEffect(() => {
    if (!revealRequest) {
      return;
    }

    const index = rows.findIndex(
      (row) => "change" in row && row.change.path === revealRequest.path,
    );
    if (index >= 0) {
      rowVirtualizer.scrollToIndex(index, { align: "center" });
    }
    // 依赖 revealRequest.requestId 保证同一目标再次请求时仍会滚动。
  }, [revealRequest, rows, rowVirtualizer]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 pb-2 pt-1">
        <div className="relative min-w-0">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtlest" />
          <Input
            type="text"
            size="default"
            data-testid={TID_GIT_REVIEW_FILE_FILTER}
            value={filterQuery}
            className="h-7 bg-transparent pl-7 pr-7 focus-visible:bg-input-focused"
            placeholder={intl.formatMessage({
              id: "git.review.filterPlaceholder",
            })}
            aria-label={intl.formatMessage({
              id: "git.review.filterPlaceholder",
            })}
            onChange={(event) => onFilterQueryChange(event.currentTarget.value)}
          />
          {filterQuery.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="absolute right-1 top-1/2 -translate-y-1/2 text-foreground-subtlest hover:bg-surface-hover hover:text-foreground"
              aria-label={intl.formatMessage({ id: "git.tree.clearSearch" })}
              title={intl.formatMessage({ id: "git.tree.clearSearch" })}
              onClick={() => onFilterQueryChange("")}
            >
              <X className="size-3" />
            </Button>
          ) : null}
        </div>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto"
        data-testid={TID_GIT_REVIEW_FILE_LIST}
      >
        {filteredChanges.length > 0 ? (
          <div className="relative w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) {
                return null;
              }

              if ("section" in row)
                return (
                  <div
                    key={virtualRow.key}
                    className="absolute left-0 w-full"
                    style={{
                      top: virtualRow.start,
                      height: GIT_REVIEW_FILE_ROW_HEIGHT_PX,
                    }}
                  >
                    <div className="relative">
                      <button
                        type="button"
                        className="absolute inset-y-0 left-0 z-10 w-6"
                        aria-expanded={!collapsedSections?.has(row.section)}
                        aria-label={row.section}
                        onClick={() => onToggleSection?.(row.section)}
                      >
                        <ChevronRight
                          className={cn(
                            "size-3.5",
                            !collapsedSections?.has(row.section) && "rotate-90",
                          )}
                        />
                      </button>
                      <div className="pl-5">{renderGroupHeader?.(row.section, row.changes)}</div>
                    </div>
                  </div>
                );
              const change = row.change;
              const isSelected =
                selectedPath === change.path &&
                (!selectedSection || selectedSection === change.section);
              const fileGitStatus = getChangeFileGitStatus(change, Boolean(renderActions));
              return (
                <div
                  key={virtualRow.key}
                  ref={rowVirtualizer.measureElement}
                  // 选中背景必须由整行绘制，操作和状态列才会与文件名连续。
                  className={cn(
                    "group absolute left-0 flex w-full items-center hover:bg-surface-hover",
                    isSelected && "bg-surface-hover",
                  )}
                  data-index={virtualRow.index}
                  data-git-review-file-row={change.path}
                  data-git-review-file-section={change.section}
                  style={{
                    top: `${virtualRow.start}px`,
                    height: `${GIT_REVIEW_FILE_ROW_HEIGHT_PX}px`,
                  }}
                >
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          "grid h-full min-w-0 flex-1 items-center gap-2 px-3 text-left transition-colors",
                          renderActions
                            ? "grid-cols-[minmax(0,max-content)_minmax(0,1fr)]"
                            : "grid-cols-[minmax(0,1fr)_auto]",
                        )}
                        title={change.workspaceRelativePath}
                        aria-pressed={isSelected}
                        onClick={() => onSelect(change)}
                      >
                        {/* 文件名在剩余宽度内省略，不能溢出覆盖独立计数列。 */}
                        <FileDisplayInline
                          path={change.workspaceRelativePath}
                          options={{
                            showFilePath: false,
                            className: "flex min-w-0 items-center gap-2 overflow-hidden",
                            fileNameClassName: cn(
                              "min-w-0 truncate text-ui-base",
                              renderActions
                                ? "text-foreground"
                                : (getWorkspaceFileGitStatusTextClassName(fileGitStatus) ??
                                    "text-foreground"),
                            ),
                          }}
                        />
                        {renderActions ? (
                          <span
                            data-scm-directory
                            className="min-w-0 truncate text-ui-sm text-foreground-subtle"
                          >
                            {change.workspaceRelativePath.includes("/")
                              ? change.workspaceRelativePath.slice(
                                  0,
                                  change.workspaceRelativePath.lastIndexOf("/"),
                                )
                              : ""}
                          </span>
                        ) : (
                          <span className="whitespace-nowrap text-right text-ui-xs tabular-nums">
                            <span className="text-diff-added">+{change.added}</span>
                            <span className="ml-1 text-diff-removed">-{change.removed}</span>
                          </span>
                        )}
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-56">
                      <ContextMenuItem
                        disabled={!canRevealInFileManager(change)}
                        onSelect={() => onRevealInFileManager(change)}
                      >
                        <FolderOpenIcon className="size-4" />
                        {contextMenuLabels.revealInFileManager}
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => onCopyAbsolutePath(change)}>
                        <CopyIcon className="size-4" />
                        {contextMenuLabels.copyAbsolutePath}
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => onCopyRelativePath(change)}>
                        <CopyIcon className="size-4" />
                        {contextMenuLabels.copyRelativePath}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        disabled={!onRevealInFileTree}
                        onSelect={() => onRevealInFileTree?.(change)}
                      >
                        <ListTreeIcon className="size-4" />
                        {contextMenuLabels.revealInFileTree}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  {renderActions && (
                    <>
                      <div
                        data-scm-actions
                        // 半透明行背景不能继承后再次叠加；正常布局预留图标宽度，透明区域露出整行背景。
                        className="pointer-events-none flex shrink-0 items-center opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          data-scm-action="open"
                          disabled={!onOpenFile || change.kind === "deleted"}
                          aria-label={intl.formatMessage({
                            id: "scm.openFile",
                          })}
                          title={intl.formatMessage({ id: "scm.openFile" })}
                          onClick={() => onOpenFile?.(change)}
                        >
                          <FileSymlink className="size-3.5" />
                        </Button>
                        {renderActions(change)}
                      </div>
                      <span
                        data-scm-status
                        className={cn(
                          "w-6 shrink-0 text-center text-ui-caption",
                          getWorkspaceFileGitStatusTextClassName(fileGitStatus),
                        )}
                      >
                        {change.section === "conflicted"
                          ? "U"
                          : change.isUntracked
                            ? "U"
                            : fileGitStatus === "added"
                              ? "A"
                              : fileGitStatus === "deleted"
                                ? "D"
                                : fileGitStatus === "renamed"
                                  ? "R"
                                  : "M"}
                      </span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ) : normalizedFilterQuery ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <p className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "git.review.noFilteredFileTitle" })}
            </p>
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "git.review.noFilteredFileDescription" })}
            </p>
          </div>
        ) : emptyState ? (
          emptyState
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <p className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "git.empty.title" })}
            </p>
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "git.empty.description" })}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
