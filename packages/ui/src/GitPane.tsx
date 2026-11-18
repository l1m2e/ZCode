import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePanelRef } from "react-resizable-panels";
import type { GitChangeSourceId, GitDiffResult } from "@zcode/shared";
import {
  TID_GIT_PANE,
  TID_GIT_REVIEW_DIFF_STYLE_TOGGLE,
  TID_GIT_REVIEW_LIST_TOGGLE,
} from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
} from "@/components/ui/resizable.js";
import {
  Columns2Icon,
  FilePenLineIcon,
  FileTextIcon,
  PanelLeftIcon,
  RectangleHorizontalIcon,
  RefreshCw,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { type GitPaneFileChange, type GitPaneRepositoryState } from "@/hooks/useGitRepository.js";
import { useServices } from "@/hooks/useServices.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { joinFilePath, isAbsoluteFilePath, getPathLeaf } from "@/lib/path.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import {
  getDiffCacheKey,
  getErrorMessage,
  getGitPaneDiffFindContent,
  getSourceMessageId,
} from "@/GitPane/helpers.js";
import { useGitEmptyStateCopy } from "@/GitPane/useGitEmptyStateCopy.js";
import { GitPaneFileList } from "@/GitPane/GitPaneFileList.js";
import { GitPaneDiffContent, GitPaneDiffEmptyState } from "@/GitPane/GitPaneDiffContent.js";
import { getFileChangeFindState } from "@/GitPane/fileChangeFindSearch.js";
import { useVisibleGitPaneChanges } from "@/GitPane/useVisibleGitPaneChanges.js";
import { logger } from "@/logger.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";

interface GitDiffLoadState {
  revision: number;
  loading: boolean;
  diff: GitDiffResult | null;
}

const GIT_PANE_NARROW_LAYOUT_MIN_WIDTH_PX = 560;
const GIT_REVIEW_SPLIT_PANEL_IDS = ["file-list", "diff"];
const GIT_REVIEW_LIST_PANEL_IDS = ["file-list"];
const GIT_REVIEW_DIFF_PANEL_IDS = ["diff"];

export function GitPane({
  workspacePath,
  gitState,
  isDesktop,
  selectedSourceId,
  sourceControl,
  selectionRequest,
  fileChangeFindActiveIndex,
  fileChangeFindNavigationRequestId,
  fileChangeFindQuery,
  onFileChangeFindMatchCountChange,
  onSelectSource,
  onClose: _onClose,
  onRefresh,
  onRevealFileInTree,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onOpenCodeViewer,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  gitState: GitPaneRepositoryState;
  isDesktop?: boolean;
  selectedSourceId: GitChangeSourceId;
  sourceControl?: {
    header: ReactNode;
    renderGroupHeader: (section: string, changes: readonly GitPaneFileChange[]) => ReactNode;
    renderActions: (change: GitPaneFileChange) => ReactNode;
    collapsedSections: ReadonlySet<string>;
    onToggleSection: (section: string) => void;
    /** SCM 列表投影谓词与专用空状态；只影响列表和分组计数，不改变 Git 快照。 */
    changeFilter?: (change: GitPaneFileChange) => boolean;
    emptyState?: ReactNode;
  };
  selectionRequest?: {
    sourceId: GitChangeSourceId;
    path: string;
    requestId: number;
  } | null;
  fileChangeFindActiveIndex: number;
  fileChangeFindNavigationRequestId: number;
  fileChangeFindQuery: string;
  onFileChangeFindMatchCountChange: (count: number) => void;
  onSelectSource: (sourceId: GitChangeSourceId) => void;
  onClose: () => void;
  onRefresh: () => void;
  onRevealFileInTree?: (path: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}) {
  const { gitService } = useServices();
  const { intl } = useZCodeIntl();
  const theme = useZCodeStore((state) => state.theme);
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  const gitReviewSettings = useZCodeStore((state) => state.gitReviewSettings);
  const setGitReviewSettings = useZCodeStore((state) => state.setGitReviewSettings);
  const workspaceOpenTarget = useWorkspaceOpenInEditorTarget({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  });
  const fileActions = useFileContextActions({
    canOpenLocalFileManager: Boolean(isDesktop),
    isRemoteWorkspace:
      Boolean(workspaceRemoteSessionId || workspaceIdentity?.trim()) ||
      workspaceOpenTarget.isRemoteWorkspace,
    remoteTarget: workspaceOpenTarget.remoteTarget,
    workspaceIdentity,
  });
  const resolvedTheme = resolveTheme(theme);
  // 选择意图仍由保活的 GitPane 唯一持有；暂空数据不能抹掉会话切回时要恢复的路径。
  const [selection, setSelection] = useState<{
    workspaceKey: string;
    sourceId: GitChangeSourceId;
    path: string;
  } | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const scopedDiffKey = useCallback(
    (source: GitChangeSourceId, path: string) =>
      JSON.stringify([workspaceKey, workspacePath, getDiffCacheKey(source, path)]),
    [workspaceKey, workspacePath],
  );
  const [diffStateByKey, setDiffStateByKey] = useState<Record<string, GitDiffLoadState>>({});
  const diffGenerationRef = useRef(0);
  const pendingDiffKeysRef = useRef(new Set<string>());
  // 窄面板（手机 Web / 拖窄的侧栏）退化为“列表 ↔ 内容”二选一。
  const rootRef = useRef<HTMLElement | null>(null);
  const [isNarrowPane, setIsNarrowPane] = useState(false);
  const [narrowView, setNarrowView] = useState<"list" | "content">("list");
  const [fileRevealRequest, setFileRevealRequest] = useState<{
    path: string;
    requestId: number;
  } | null>(null);

  const defaultSourceOption = gitState.sourceOptions[0]!;
  const currentSourceOption =
    gitState.sourceOptions.find((option) => option.id === selectedSourceId) ?? defaultSourceOption;
  const currentDataset = gitState.datasets[currentSourceOption.id] ?? gitState.datasets.unstaged;
  const currentChanges = useMemo(
    () =>
      sourceControl
        ? [...gitState.datasets.staged.sections, ...gitState.datasets.unstaged.sections].flatMap(
            (section) =>
              section.changes.map((change) =>
                change.section === "untracked"
                  ? { ...change, section: "unstaged" as const }
                  : change,
              ),
          )
        : currentDataset.sections.flatMap((section) => section.changes),
    [
      currentDataset,
      sourceControl,
      gitState.datasets.staged.sections,
      gitState.datasets.unstaged.sections,
    ],
  );
  // SCM 展示过滤（隐藏测试文件）只裁剪列表投影；快照与写操作范围仍由调用方按可见路径计算。
  const visibleChanges = useVisibleGitPaneChanges(currentChanges, sourceControl?.changeFilter);
  const hasChanges = currentChanges.length > 0;
  const normalizedFileChangeFindQuery = fileChangeFindQuery.trim();
  // 旧实现把暂空/失效路径清成 null，却从不补选，数据恢复后右侧一直提示选择文件。
  // 在当前身份和来源内投影有效选择；回退不写导航状态，手机返回列表不会被刷新打断。
  const selectedChange =
    (selection?.workspaceKey === workspaceKey &&
    (sourceControl || selection.sourceId === currentDataset.id)
      ? (visibleChanges.find(
          (change) =>
            change.path === selection.path &&
            (!sourceControl || (change.isStaged ? "staged" : "unstaged") === selection.sourceId),
        ) ??
        (sourceControl ? visibleChanges.find((change) => change.path === selection.path) : null))
      : null) ??
    visibleChanges[0] ??
    null;
  const selectedPath = selectedChange?.path ?? null;
  const selectedDiffSource = sourceControl
    ? selectedChange?.isStaged
      ? "staged"
      : "unstaged"
    : currentDataset.id;
  const setSelectedPath = useCallback(
    (path: string) => setSelection({ workspaceKey, sourceId: currentDataset.id, path }),
    [workspaceKey, currentDataset.id],
  );

  const emptyStateCopy = useGitEmptyStateCopy(currentSourceOption.id, gitState);

  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }

    // 判定依据是面板实际宽度而非窗口宽度：侧栏拖窄、手机 overlay 都会进入窄布局。
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setIsNarrowPane(width > 0 && width < GIT_PANE_NARROW_LAYOUT_MIN_WIDTH_PX);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    // revision 变化只让缓存过期；清空会卸载正文并把滚动位置夹到零。
    // 目标变化仍清理缓存，key 的目标隔离同时阻止 effect 前的一帧串用旧正文。
    setDiffStateByKey({});
  }, [workspaceKey, workspacePath]);

  useEffect(() => {
    diffGenerationRef.current += 1;
    const pendingKeys = pendingDiffKeysRef.current;
    pendingKeys.clear();
    return () => {
      diffGenerationRef.current += 1;
      pendingKeys.clear();
    };
  }, [gitState.revision, workspaceKey, workspacePath]);

  useEffect(() => {
    setSelection(null);
    setFilterQuery("");
    setFileRevealRequest(null);
    setNarrowView("list");
  }, [workspaceKey, currentDataset.id]);

  const consumedSelectionRequest = useRef<number | null>(null);
  useEffect(() => {
    // 外部请求只消费一次；切来源后返回不能让旧请求抢走内部选择。
    if (
      !selectionRequest ||
      selectionRequest.sourceId !== selectedSourceId ||
      consumedSelectionRequest.current === selectionRequest.requestId
    )
      return;
    consumedSelectionRequest.current = selectionRequest.requestId;
    setSelection({
      workspaceKey,
      sourceId: selectionRequest.sourceId,
      path: selectionRequest.path,
    });
    setFilterQuery("");
    setNarrowView("content");
  }, [selectionRequest, selectedSourceId, workspaceKey]);

  const loadDiffForChange = useCallback(
    (change: GitPaneFileChange, sourceId: GitChangeSourceId) => {
      if (sourceId === "last-turn" || change.diff) {
        return;
      }

      const cacheKey = scopedDiffKey(sourceId, change.path);
      if (
        pendingDiffKeysRef.current.has(cacheKey) ||
        diffStateByKey[cacheKey]?.revision === gitState.revision
      ) {
        return;
      }

      pendingDiffKeysRef.current.add(cacheKey);
      setDiffStateByKey((current) => ({
        ...current,
        [cacheKey]: {
          revision: gitState.revision,
          loading: true,
          diff: current[cacheKey]?.diff ?? null,
        },
      }));

      const generation = diffGenerationRef.current;
      void gitService
        .getDiff({
          workspacePath,
          path: change.path,
          sourceId,
        })
        .then((diff) => {
          if (diffGenerationRef.current !== generation) {
            return;
          }

          // 大文件 diff 卡顿问题需要先确认“卡在拉取还是卡在渲染”。
          // 这里记录每次选中拿到的 diff 规模，便于从日志快速定位是否命中 fallback 条件。
          // 文件变更查找会批量预加载 diff；这类逐文件规模日志只适合开发排查。
          // 走 debug 可避免生产桌面日志被搜索行为刷大，同时保留定位大 diff 卡顿的线索。
          logger.debug("[GitPane] diff 已加载", {
            workspacePath,
            sourceId,
            path: change.path,
            availability: diff.availability,
            beforeChars: diff.beforeContent?.length ?? 0,
            afterChars: diff.afterContent?.length ?? 0,
          });

          setDiffStateByKey((current) => ({
            ...current,
            [cacheKey]: {
              revision: gitState.revision,
              loading: false,
              diff,
            },
          }));
        })
        .catch((error: unknown) => {
          if (diffGenerationRef.current !== generation) {
            return;
          }

          const message = getErrorMessage(error);
          logger.warn("[GitPane] 读取文件 diff 失败", {
            workspacePath,
            sourceId,
            path: change.path,
            error: message,
          });
          setDiffStateByKey((current) => ({
            ...current,
            [cacheKey]: {
              revision: gitState.revision,
              loading: false,
              diff: {
                path: change.path,
                availability: "unavailable",
                patch: null,
                beforeContent: null,
                afterContent: null,
                summary: message,
              },
            },
          }));
        })
        .finally(() => {
          // 旧请求结束时不能删除新 generation 同路径请求的 pending 标记。
          if (diffGenerationRef.current === generation) pendingDiffKeysRef.current.delete(cacheKey);
        });
    },
    [diffStateByKey, gitService, workspacePath, scopedDiffKey, gitState.revision],
  );

  useEffect(() => {
    if (selectedChange) loadDiffForChange(selectedChange, selectedDiffSource);
  }, [selectedChange, selectedDiffSource, loadDiffForChange]);

  const fileChangeFindTargets = useMemo(
    () =>
      visibleChanges.map((change) => {
        const diffState =
          change.diff ??
          diffStateByKey[scopedDiffKey(currentDataset.id, change.path)]?.diff ??
          null;
        return {
          path: change.path,
          content: getGitPaneDiffFindContent(diffState),
        };
      }),
    [visibleChanges, currentDataset.id, diffStateByKey, scopedDiffKey],
  );
  const fileChangeFindState = useMemo(
    () =>
      getFileChangeFindState(fileChangeFindTargets, fileChangeFindQuery, fileChangeFindActiveIndex),
    [fileChangeFindActiveIndex, fileChangeFindQuery, fileChangeFindTargets],
  );
  const activeFileChangeFindMatch = fileChangeFindState.activeMatch;

  useEffect(() => {
    onFileChangeFindMatchCountChange(fileChangeFindState.total);
  }, [fileChangeFindState.total, onFileChangeFindMatchCountChange]);

  useEffect(() => {
    if (!normalizedFileChangeFindQuery) {
      return;
    }

    // 文件变更查找需要命中未选中的文件里的内容。
    // diff 默认在选中时懒加载，所以查找时先把当前来源的 diff 补齐，再用同一套 patch 数据计算全局命中。
    for (const change of visibleChanges) {
      loadDiffForChange(change, currentDataset.id);
    }
  }, [visibleChanges, currentDataset.id, loadDiffForChange, normalizedFileChangeFindQuery]);

  useEffect(() => {
    if (!activeFileChangeFindMatch) {
      return;
    }

    const activeChange = visibleChanges.find(
      (change) => change.path === activeFileChangeFindMatch.path,
    );
    if (!activeChange) {
      return;
    }

    // 同文件的新导航请求也要 reveal；清除路径过滤，确保目标行可见。
    setSelectedPath(activeFileChangeFindMatch.path);
    setFilterQuery("");
    setFileRevealRequest({
      path: activeFileChangeFindMatch.path,
      requestId: fileChangeFindNavigationRequestId,
    });
    setNarrowView("content");
    loadDiffForChange(activeChange, currentDataset.id);
  }, [
    activeFileChangeFindMatch,
    visibleChanges,
    currentDataset.id,
    fileChangeFindNavigationRequestId,
    loadDiffForChange,
    setSelectedPath,
  ]);

  const handleSelectSource = (nextSourceId: string) => {
    logger.info(`[GitPane] 切换来源 workspace=${workspacePath} source=${nextSourceId}`);
    onSelectSource(nextSourceId as GitChangeSourceId);
    setSelection(null);
    setNarrowView("list");
  };

  const handleSelectChange = (change: GitPaneFileChange) => {
    logger.info(
      `[GitPane] 选中变更文件 workspace=${workspacePath} source=${currentSourceOption.id} path=${change.path}`,
    );
    setSelection({
      workspaceKey,
      sourceId: sourceControl ? (change.isStaged ? "staged" : "unstaged") : currentDataset.id,
      path: change.path,
    });
    if (isNarrowPane) {
      setNarrowView("content");
    }
  };

  // 单/双栏/编辑器视图三态循环；顺序与按钮 title 消息一一对应。
  const GIT_REVIEW_DIFF_STYLE_CYCLE = {
    split: "unified",
    unified: "editor",
    editor: "split",
  } as const;
  const handleToggleDiffStyle = () => {
    const nextDiffStyle = GIT_REVIEW_DIFF_STYLE_CYCLE[gitReviewSettings.diffStyle];
    logger.info(`[GitPane] 切换 diff 展示模式 diffStyle=${nextDiffStyle}`);
    setGitReviewSettings({ diffStyle: nextDiffStyle });
  };

  const handleToggleFileList = () => {
    const nextVisible = !gitReviewSettings.fileListVisible;
    logger.info(`[GitPane] 切换文件列表栏 visible=${nextVisible}`);
    setGitReviewSettings({ fileListVisible: nextVisible });
  };

  const resolveChangePath = useCallback(
    (change: GitPaneFileChange) =>
      isAbsoluteFilePath(change.path) ? change.path : joinFilePath(workspacePath, change.path),
    [workspacePath],
  );

  const handleCopyAbsolutePath = useCallback(
    (change: GitPaneFileChange) => {
      void fileActions.copyAbsolutePath({ path: resolveChangePath(change) });
    },
    [fileActions, resolveChangePath],
  );
  const handleCopyRelativePath = useCallback(
    (change: GitPaneFileChange) => {
      void fileActions.copyRelativePath({
        path: resolveChangePath(change),
        relativePath: getWorkspaceFileRelativePath(workspacePath, resolveChangePath(change)),
      });
    },
    [fileActions, resolveChangePath, workspacePath],
  );

  const handleRevealChangeInFileManager = useCallback(
    (change: GitPaneFileChange) => {
      void fileActions.revealInFileManager({
        path: resolveChangePath(change),
        deleted: change.kind === "deleted",
        kind: "file",
      });
    },
    [fileActions, resolveChangePath],
  );

  const handleRevealChangeInFileTree = useCallback(
    (change: GitPaneFileChange) => {
      onRevealFileInTree?.(resolveChangePath(change));
    },
    [onRevealFileInTree, resolveChangePath],
  );

  const handleOpenFilePreview = useCallback(
    (change: GitPaneFileChange) => {
      if (!onOpenCodeViewer) {
        return;
      }

      const path = resolveChangePath(change);
      // 与 createDiffSourceFilePreviewSource 一致：file source 必须携带 workspace scope，
      // 远程 workspace / 手机远控才能按正确边界读取文件。
      onOpenCodeViewer({
        type: "file",
        title: getPathLeaf(path),
        path,
        ...(workspacePath ? { workspacePath } : {}),
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
      });
    },
    [
      onOpenCodeViewer,
      resolveChangePath,
      workspaceIdentity,
      workspacePath,
      workspaceRemoteSessionId,
    ],
  );

  const contextMenuLabels = useMemo(
    () => ({
      copyAbsolutePath: intl.formatMessage({
        id: "fileActions.copyAbsolutePath",
      }),
      copyRelativePath: intl.formatMessage({
        id: "fileActions.copyRelativePath",
      }),
      revealInFileManager: intl.formatMessage({
        id: "git.changeContext.revealInFileManager",
      }),
      revealInFileTree: intl.formatMessage({
        id: "git.changeContext.revealInFileTree",
      }),
    }),
    [intl],
  );

  const scmListPanelRef = usePanelRef();
  const scmListInitialized = useRef(false);

  const showListColumn =
    (hasChanges || Boolean(sourceControl)) &&
    (isNarrowPane
      ? narrowView === "list"
      : Boolean(sourceControl) || gitReviewSettings.fileListVisible);
  const showContentColumn =
    (hasChanges || Boolean(sourceControl)) && (!isNarrowPane || narrowView === "content");
  const showSplitLayout = showListColumn && showContentColumn;
  const initializeScmList = (pixels: number) => {
    // 首次双栏实测后初始化，避免 effect 早于注册而被默认比例覆盖。
    if (!showSplitLayout) scmListInitialized.current = false;
    else if (!scmListInitialized.current && pixels > 0) {
      scmListInitialized.current = true;
      scmListPanelRef.current?.resize("320px");
    }
  };
  // 按可见栏组合隔离布局记录，单栏占满宽度不能覆盖用户调好的双栏比例。
  const reviewPanelIds = showSplitLayout
    ? GIT_REVIEW_SPLIT_PANEL_IDS
    : showListColumn
      ? GIT_REVIEW_LIST_PANEL_IDS
      : GIT_REVIEW_DIFF_PANEL_IDS;
  const selectedDiffCacheKey = selectedChange
    ? scopedDiffKey(selectedDiffSource, selectedChange.path)
    : null;
  const cachedSelectedDiffState = selectedDiffCacheKey
    ? diffStateByKey[selectedDiffCacheKey]
    : undefined;
  const selectedDiffState = selectedChange?.diff ?? cachedSelectedDiffState?.diff ?? null;
  // 同 source/path 的后台重取保留正文；没有可展示内容时才显示初始 loading。
  const isSelectedDiffLoading = Boolean(selectedChange && !selectedDiffState);

  const diffStyleAction = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      data-testid={TID_GIT_REVIEW_DIFF_STYLE_TOGGLE}
      aria-label={intl.formatMessage({
        id:
          gitReviewSettings.diffStyle === "split"
            ? "git.review.diffStyleUnified"
            : gitReviewSettings.diffStyle === "unified"
              ? "git.review.diffStyleEditor"
              : "git.review.diffStyleSplit",
      })}
      onClick={handleToggleDiffStyle}
    >
      {gitReviewSettings.diffStyle === "split" ? (
        <Columns2Icon className="size-4" />
      ) : gitReviewSettings.diffStyle === "editor" ? (
        <FilePenLineIcon className="size-4" />
      ) : (
        <RectangleHorizontalIcon className="size-4" />
      )}
    </Button>
  );

  return (
    <section
      ref={rootRef}
      data-testid={TID_GIT_PANE}
      data-git-selected-source={selectedDiffSource}
      data-git-selected-path={selectedPath}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      {!sourceControl && (
        <div className="flex items-center justify-between gap-3 p-3">
          <Select value={currentSourceOption.id} onValueChange={handleSelectSource}>
            <SelectTrigger className="max-w-full" size="lg">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              {gitState.sourceOptions.map((option) => (
                <SelectItem key={option.id} value={option.id} disabled={option.disabled}>
                  {intl.formatMessage({ id: getSourceMessageId(option.id) })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-1">
            {diffStyleAction}
            {/* 窄面板下列表/内容切换由内容头部的返回按钮承担，这里只保留宽面板的列表显隐开关。 */}
            {!isNarrowPane ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid={TID_GIT_REVIEW_LIST_TOGGLE}
                title={intl.formatMessage({
                  id: gitReviewSettings.fileListVisible
                    ? "git.review.listToggleHide"
                    : "git.review.listToggleShow",
                })}
                aria-label={intl.formatMessage({
                  id: gitReviewSettings.fileListVisible
                    ? "git.review.listToggleHide"
                    : "git.review.listToggleShow",
                })}
                onClick={handleToggleFileList}
              >
                <PanelLeftIcon
                  className={cn("size-4", gitReviewSettings.fileListVisible && "text-foreground")}
                />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={gitState.loading}
              onClick={onRefresh}
              title={intl.formatMessage({ id: "git.action.refresh" })}
              aria-label={intl.formatMessage({ id: "git.action.refresh" })}
            >
              <RefreshCw className={cn("size-4", gitState.loading && "animate-spin")} />
            </Button>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {!hasChanges && !sourceControl ? (
          <div className="flex h-full flex-1 flex-col items-center justify-center px-6 text-center">
            <FileTextIcon className="size-8 text-foreground-subtlest" />
            <p className="mt-3 text-ui-base font-medium text-foreground">{emptyStateCopy.title}</p>
            <p className="mt-1 text-ui-base text-foreground-subtle">{emptyStateCopy.description}</p>
          </div>
        ) : (
          <ResizablePanelGroup
            layoutId={sourceControl ? "source-control-layout" : "git-review-layout"}
            orientation="horizontal"
            panelIds={reviewPanelIds}
            disabled={!showSplitLayout}
            className="min-h-0 min-w-0 flex-1"
          >
            {showListColumn ? (
              <ResizablePanel
                id="file-list"
                panelRef={sourceControl ? scmListPanelRef : undefined}
                onResize={sourceControl ? (size) => initializeScmList(size.inPixels) : undefined}
                defaultSize={sourceControl ? "320px" : "240px"}
                // SCM 是固定窄栏；默认相对缩放会在全屏时把提交区放大挤占 diff。
                groupResizeBehavior={
                  sourceControl ? "preserve-pixel-size" : "preserve-relative-size"
                }
                minSize={showSplitLayout ? (sourceControl ? "280px" : "180px") : "0px"}
                maxSize={showSplitLayout ? "60%" : "100%"}
                className="flex h-full min-h-0 min-w-0 flex-col"
              >
                {/* 提交区必须属于列表栏；放在分栏外会把整个 diff 下压。 */}
                {sourceControl && (
                  <div className="max-h-[60%] shrink-0 overflow-y-auto">{sourceControl.header}</div>
                )}
                <GitPaneFileList
                  changes={visibleChanges}
                  selectedSection={sourceControl ? selectedChange?.section : undefined}
                  renderGroupHeader={sourceControl?.renderGroupHeader}
                  renderActions={sourceControl?.renderActions}
                  collapsedSections={sourceControl?.collapsedSections}
                  onToggleSection={sourceControl?.onToggleSection}
                  emptyState={sourceControl?.emptyState}
                  onOpenFile={onOpenCodeViewer ? handleOpenFilePreview : undefined}
                  filterQuery={filterQuery}
                  onFilterQueryChange={setFilterQuery}
                  selectedPath={selectedPath}
                  revealRequest={fileRevealRequest}
                  onSelect={handleSelectChange}
                  contextMenuLabels={contextMenuLabels}
                  canRevealInFileManager={(change) =>
                    fileActions.canRevealInFileManager({
                      path: resolveChangePath(change),
                      deleted: change.kind === "deleted",
                    })
                  }
                  onCopyAbsolutePath={handleCopyAbsolutePath}
                  onCopyRelativePath={handleCopyRelativePath}
                  onRevealInFileManager={handleRevealChangeInFileManager}
                  onRevealInFileTree={onRevealFileInTree ? handleRevealChangeInFileTree : undefined}
                />
              </ResizablePanel>
            ) : null}
            {showSplitLayout ? (
              <ResizableHandle
                aria-label={intl.formatMessage({
                  id: "git.review.resizeFileList",
                })}
                className={cn(
                  WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
                  "before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border before:content-[''] after:inset-y-0 after:rounded-none after:left-1/2 after:-translate-x-1/2",
                )}
              />
            ) : null}
            {showContentColumn ? (
              <ResizablePanel
                id="diff"
                minSize={showSplitLayout ? "280px" : "0px"}
                className="h-full min-h-0 min-w-0"
              >
                {selectedChange ? (
                  <GitPaneDiffContent
                    headerActions={sourceControl ? diffStyleAction : undefined}
                    change={selectedChange}
                    diffState={selectedDiffState}
                    isDiffLoading={isSelectedDiffLoading}
                    codePreviewSettings={codePreviewSettings}
                    resolvedTheme={resolvedTheme}
                    diffStyle={gitReviewSettings.diffStyle}
                    workspacePath={workspacePath}
                    workspaceIdentity={workspaceIdentity}
                    sourcePath={resolveChangePath(selectedChange)}
                    narrowLayout={isNarrowPane}
                    onBackToList={() => setNarrowView("list")}
                    onOpenFilePreview={
                      onOpenCodeViewer ? () => handleOpenFilePreview(selectedChange) : undefined
                    }
                  />
                ) : (
                  <GitPaneDiffEmptyState
                    onBackToList={() => {
                      setNarrowView("list");
                      setGitReviewSettings({ fileListVisible: true });
                    }}
                  />
                )}
              </ResizablePanel>
            ) : null}
          </ResizablePanelGroup>
        )}
      </div>
    </section>
  );
}
