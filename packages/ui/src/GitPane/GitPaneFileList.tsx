import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CopyIcon, FolderOpenIcon, ListTreeIcon, Search, X } from "lucide-react";
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
function getChangeFileGitStatus(change: GitPaneFileChange): WorkspaceFileGitStatus {
  return change.isUntracked ? "untracked" : change.kind;
}

export interface GitPaneFileListProps {
  changes: readonly GitPaneFileChange[];
  selectedPath: string | null;
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

  const rowVirtualizer = useVirtualizer({
    count: filteredChanges.length,
    getItemKey: (index) => {
      const change = filteredChanges[index];
      return change ? change.path : String(index);
    },
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GIT_REVIEW_FILE_ROW_HEIGHT_PX,
    overscan: GIT_REVIEW_FILE_ROW_OVERSCAN,
  });

  useEffect(() => {
    if (!revealRequest) {
      return;
    }

    const index = filteredChanges.findIndex((change) => change.path === revealRequest.path);
    if (index >= 0) {
      rowVirtualizer.scrollToIndex(index, { align: "center" });
    }
    // 依赖 revealRequest.requestId 保证同一目标再次请求时仍会滚动。
  }, [revealRequest, filteredChanges, rowVirtualizer]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-2 pb-2 pt-1">
        <div className="relative min-w-0">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtlest" />
          <Input
            type="text"
            size="default"
            data-testid={TID_GIT_REVIEW_FILE_FILTER}
            value={filterQuery}
            className="h-7 bg-transparent pl-7 pr-7 focus-visible:bg-input-focused"
            placeholder={intl.formatMessage({ id: "git.review.filterPlaceholder" })}
            aria-label={intl.formatMessage({ id: "git.review.filterPlaceholder" })}
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
              const change = filteredChanges[virtualRow.index];
              if (!change) {
                return null;
              }

              const isSelected = selectedPath === change.path;
              const fileGitStatus = getChangeFileGitStatus(change);
              return (
                <div
                  key={virtualRow.key}
                  ref={rowVirtualizer.measureElement}
                  className="absolute left-0 w-full"
                  data-index={virtualRow.index}
                  data-git-review-file-row={change.path}
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
                          "grid h-full w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 text-left transition-colors hover:bg-surface-hover",
                          isSelected && "bg-surface-hover",
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
                              getWorkspaceFileGitStatusTextClassName(fileGitStatus) ??
                                "text-foreground",
                            ),
                          }}
                        />
                        <span className="whitespace-nowrap text-right text-ui-xs tabular-nums">
                          <span className="text-diff-added">+{change.added}</span>
                          <span className="ml-1 text-diff-removed">-{change.removed}</span>
                        </span>
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
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <p className="text-ui-base font-medium text-foreground">
              {normalizedFilterQuery
                ? intl.formatMessage({ id: "git.review.noFilteredFileTitle" })
                : intl.formatMessage({ id: "git.empty.title" })}
            </p>
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {normalizedFilterQuery
                ? intl.formatMessage({ id: "git.review.noFilteredFileDescription" })
                : intl.formatMessage({ id: "git.empty.description" })}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
