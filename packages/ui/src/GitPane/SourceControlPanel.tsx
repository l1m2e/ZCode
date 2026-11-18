import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { GitPane } from "@/GitPane.js";
import {
  Plus,
  Minus,
  Undo2,
  Sparkles,
  RefreshCw,
  ChevronDown,
  GitBranch,
  Check,
  FlaskConical,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { TID_SCM_HIDE_TEST_FILES_TOGGLE } from "@zcode/shared/test-ids";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useGitActions } from "@/hooks/useGitActions.js";
import { useServices } from "@/hooks/useServices.js";
import type { GitPaneRepositoryState, GitPaneFileChange } from "@/hooks/useGitRepository.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import { isTestFilePath } from "@/GitPane/testFileFilter.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

type Confirmation = {
  paths: string[];
  staged: boolean;
  kind: "discard" | "commit";
  push?: boolean;
};

/** 仓库快照由 App 提供；这里仅持有当前目标的编辑草稿和确认意图。 */
export function SourceControlPanel({
  workspacePath,
  workspaceIdentity,
  gitState,
  onRefresh,
  isDesktop,
  workspaceRemoteSessionId,
  onOpenCodeViewer,
  repositorySelector,
}: {
  repositorySelector?: ReactNode;
  workspacePath: string;
  workspaceIdentity?: string;
  gitState: GitPaneRepositoryState;
  onRefresh(): void;
  isDesktop?: boolean;
  workspaceRemoteSessionId?: string;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const { gitService } = useServices();
  const actions = useGitActions({
    workspacePath,
    workspaceIdentity,
    onRefresh,
  });
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(new Set());
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const input = messageRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(160, Math.max(36, input.scrollHeight))}px`;
  }, [message]);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [pushFailed, setPushFailed] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const version = useRef(0);
  useEffect(
    () => () => {
      version.current += 1;
    },
    [],
  );
  const t = (id: string) => intl.formatMessage({ id });
  const hideTestFiles = useZCodeStore((state) => state.gitReviewSettings.hideTestFiles);
  const setGitReviewSettings = useZCodeStore((state) => state.setGitReviewSettings);
  const targetReady =
    gitState.workspaceKey === (workspaceIdentity?.trim() || workspacePath) &&
    gitState.summary.workspacePath === workspacePath;
  // 隐藏测试文件是列表与写操作范围的共同投影：批量暂存/丢弃和提交都不能
  // 覆盖用户看不到的条目，否则隐藏功能会悄悄把测试文件带进 index。
  // 冲突例外：冲突是阻塞提交的状态，隐藏后用户既看不到原因也无法处理，
  // 因此冲突条目始终可见。
  const isVisibleChange = useCallback(
    (file: GitPaneFileChange) =>
      file.section === "conflicted" ||
      !hideTestFiles ||
      !isTestFilePath(file.workspaceRelativePath),
    [hideTestFiles],
  );
  const staged = useMemo(
    () =>
      targetReady
        ? gitState.datasets.staged.sections
            .flatMap((section) => section.changes)
            .filter(isVisibleChange)
        : [],
    [gitState.datasets.staged.sections, isVisibleChange, targetReady],
  );
  const unstaged = useMemo(
    () =>
      targetReady
        ? gitState.datasets.unstaged.sections
            .flatMap((section) => section.changes)
            .filter(isVisibleChange)
        : [],
    [gitState.datasets.unstaged.sections, isVisibleChange, targetReady],
  );
  const hiddenTestFileCount = useMemo(
    () =>
      targetReady
        ? gitState.datasets.staged.sections
            .concat(gitState.datasets.unstaged.sections)
            .flatMap((section) => section.changes)
            .filter((file) => !isVisibleChange(file)).length
        : 0,
    [
      gitState.datasets.staged.sections,
      gitState.datasets.unstaged.sections,
      isVisibleChange,
      targetReady,
    ],
  );
  const conflicts = unstaged.filter((file) => file.section === "conflicted");
  const changes = unstaged.filter((file) => file.section !== "conflicted");
  // 刷新期间仍展示旧投影，禁止以旧分组范围继续写操作。
  const busy = actions.pending || gitState.loading;
  const available =
    gitState.summary.isRepository &&
    gitState.summary.workspacePath === workspacePath &&
    !gitState.loading &&
    !gitState.error;
  const canCommit =
    available &&
    !busy &&
    Boolean(message.trim()) &&
    !conflicts.length &&
    Boolean(staged.length || changes.length);
  const canPush = available && !busy && (pushFailed || gitState.summary.ahead > 0);
  const splitDisabled = !canCommit && !canPush;
  const paths = (files: readonly GitPaneFileChange[]) =>
    Array.from(new Set(files.map((file) => file.path)));
  const perform = async (operation: () => Promise<unknown>) => {
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(getErrorMessage(cause));
    }
  };
  const generate = async () => {
    const requestVersion = ++version.current;
    setGenerating(true);
    setError(null);
    try {
      const result = await gitService.generateCommitMessage({
        workspacePath,
        workspaceIdentity,
        locale,
        includeUnstaged: staged.length === 0,
      });
      // 生成期间仍允许编辑；迟到的模型结果不能覆盖用户的新草稿。
      if (version.current === requestVersion) setMessage(result.message);
    } catch (cause) {
      if (version.current === requestVersion) setError(getErrorMessage(cause));
    } finally {
      setGenerating(false);
    }
  };
  const submit = async (push: boolean, confirmedPaths?: string[]) => {
    if (!available || busy || conflicts.length || !message.trim()) return;
    if (!staged.length && !confirmedPaths) {
      setConfirmation({
        kind: "commit",
        paths: paths(changes),
        staged: false,
        push,
      });
      return;
    }
    const selectedPaths = confirmedPaths ?? paths(staged);
    if (!selectedPaths.length) return;
    let committed = false;
    await perform(() =>
      actions.run(async () => {
        // 确认期间快照可能刷新；只暂存确认框中冻结的路径，不能扩大授权范围。
        if (confirmedPaths) await gitService.stagePaths({ workspacePath, paths: selectedPaths });
        await gitService.commit({
          workspacePath,
          paths: selectedPaths,
          message: message.trim(),
          stagedOnly: true,
        });
        committed = true;
        version.current += 1;
        setMessage("");
        setPushFailed(false);
        if (push) {
          try {
            await gitService.push({ workspacePath });
          } catch (cause) {
            setPushFailed(committed);
            throw new Error(
              intl.formatMessage(
                {
                  id: "git.actionMenu.commitDialog.error.pushAfterCommitFailed",
                },
                { error: getErrorMessage(cause) },
              ),
            );
          }
        }
      }),
    );
  };
  const group = (
    id: string,
    label: string,
    files: readonly GitPaneFileChange[],
    isStaged: boolean,
  ) => (
    <section
      data-testid={`source-control-group-${id}`}
      className="group/section flex h-8 items-center gap-1 px-2"
    >
      <span className="min-w-0 flex-1 truncate text-ui-caption font-medium">{label}</span>
      <span className="rounded-md bg-tag px-1.5 text-ui-xs tabular-nums">{files.length}</span>
      {/* 分组动作是固定入口，不能用 hover 隐藏导致用户找不到批量操作。 */}
      <div className="flex" onClick={(event) => event.stopPropagation()}>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy || !files.length}
          data-testid={`source-control-${isStaged ? "unstage" : "stage"}-all`}
          aria-label={t(isStaged ? "scm.unstageAll" : "scm.stageAll")}
          title={t(isStaged ? "scm.unstageAll" : "scm.stageAll")}
          onClick={() =>
            void perform(() =>
              isStaged ? actions.unstagePaths(paths(files)) : actions.stagePaths(paths(files)),
            )
          }
        >
          {isStaged ? <Minus className="size-4" /> : <Plus className="size-4" />}
        </Button>
        {!isStaged && (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy || !files.length}
            aria-label={t("scm.discardAll")}
            title={t("scm.discardAll")}
            onClick={() =>
              setConfirmation({
                kind: "discard",
                paths: paths(files),
                staged: false,
              })
            }
          >
            <Undo2 className="size-3.5" />
          </Button>
        )}
      </div>
    </section>
  );
  const renderActions = (file: GitPaneFileChange) => {
    const isStaged = Boolean(file.isStaged);
    return (
      <div className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()}>
        {!isStaged && (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            data-scm-action="discard"
            aria-label={t("scm.discard")}
            title={t("scm.discard")}
            onClick={() =>
              setConfirmation({
                kind: "discard",
                paths: [file.path],
                staged: false,
              })
            }
          >
            <Undo2 className="size-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          data-scm-action={isStaged ? "unstage" : "stage"}
          disabled={busy}
          aria-label={t(isStaged ? "scm.unstage" : "scm.stage")}
          title={t(isStaged ? "scm.unstage" : "scm.stage")}
          onClick={() =>
            void perform(() =>
              isStaged ? actions.unstagePaths([file.path]) : actions.stagePaths([file.path]),
            )
          }
        >
          {isStaged ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
        </Button>
      </div>
    );
  };
  const header = (
    <>
      <div className="flex items-center justify-between px-3 py-2">
        <h2 className="font-medium">{t("scm.title")}</h2>
        <Button variant="ghost" size="icon-sm" onClick={onRefresh} aria-label={t("scm.refresh")}>
          <RefreshCw className="size-4" />
        </Button>
      </div>
      <div className="space-y-2 px-3 pb-3">
        {/* 普通文本混用 inline-flex 会按基线错位；统一 flex 居中并让长名称各自截断。 */}
        <div className="flex min-w-0 items-center gap-2 text-ui-caption text-foreground-subtle">
          {repositorySelector ?? (
            <span className="min-w-0 truncate" title={workspacePath}>
              {workspacePath.split(/[\\/]/).filter(Boolean).at(-1)}
            </span>
          )}
          <span className="flex min-w-0 items-center gap-1">
            <GitBranch className="size-3 shrink-0" />
            <span className="min-w-0 truncate" title={gitState.summary.branchName ?? undefined}>
              {gitState.summary.branchName}
            </span>
          </span>
          {/* 隐藏测试文件开关贴着仓库/分支行右缘，和标题栏刷新动作分开。 */}
          <Button
            variant={hideTestFiles ? "secondary" : "ghost"}
            size="icon-sm"
            className="ml-auto shrink-0"
            data-testid={TID_SCM_HIDE_TEST_FILES_TOGGLE}
            aria-pressed={hideTestFiles}
            aria-label={t(hideTestFiles ? "scm.showTestFiles" : "scm.hideTestFiles")}
            title={t(hideTestFiles ? "scm.showTestFiles" : "scm.hideTestFiles")}
            onClick={() => setGitReviewSettings({ hideTestFiles: !hideTestFiles })}
          >
            <FlaskConical className="size-4" />
          </Button>
        </div>
        <div className="relative">
          <Textarea
            ref={messageRef}
            rows={1}
            data-testid="source-control-message"
            value={message}
            aria-label={t("git.actionMenu.commitDialog.messageLabel")}
            placeholder={t("git.actionMenu.commitDialog.messagePlaceholder")}
            className="min-h-9 max-h-40 resize-none pr-8 text-ui-base max-md:text-mobile-input-safe"
            disabled={busy}
            onChange={(event) => {
              version.current += 1;
              setMessage(event.target.value);
            }}
            onKeyDown={(event) => {
              if (matchesPrimaryShortcut(event, "Enter")) {
                event.preventDefault();
                void submit(false);
              }
            }}
          />
          <Button
            className="absolute right-1 top-1"
            size="icon-sm"
            variant="ghost"
            disabled={!available || busy || generating || (!staged.length && !changes.length)}
            onClick={() => void generate()}
            aria-label={t("git.actionMenu.commitDialog.generate")}
            title={t("git.actionMenu.commitDialog.generate")}
          >
            <Sparkles className={`size-4 ${generating ? "animate-pulse" : ""}`} />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          {/* 原先只有主按钮 disabled 淡化，导致两半底色不同；组统一淡化，子按钮不重复叠加。 */}
          <div
            data-testid="source-control-submit"
            data-disabled={splitDisabled}
            className="flex min-w-0 flex-1 rounded-md bg-primary text-primary-foreground data-[disabled=true]:opacity-50"
          >
            <Button
              className="flex-1 rounded-r-none bg-transparent disabled:opacity-100"
              disabled={!canCommit}
              onClick={() => void submit(false)}
            >
              <span
                className={`inline-flex items-center gap-1 ${!canCommit && !splitDisabled ? "opacity-50" : ""}`}
              >
                <Check className="size-4" />
                {t("git.actionMenu.commitDialog.action.commit")}
              </span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  className="rounded-l-none border-l border-primary-foreground/30 bg-transparent disabled:opacity-100"
                  disabled={splitDisabled}
                  aria-label={t("scm.commitActions")}
                >
                  <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={!canCommit} onSelect={() => void submit(true)}>
                  {t("git.actionMenu.commitDialog.action.commitAndPush")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canPush}
                  onSelect={() =>
                    void perform(async () => {
                      await actions.push();
                      setPushFailed(false);
                    })
                  }
                >
                  {t("git.actionMenu.push")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {conflicts.length > 0 && (
          <p role="alert" className="text-ui-caption text-destructive">
            {t("scm.conflictWarning")}
          </p>
        )}
        {(error || gitState.error) && (
          <p role="alert" className="break-words text-ui-caption text-destructive">
            {error || gitState.error}
          </p>
        )}
        {!gitState.summary.isRepository && (
          <p className="text-ui-caption text-foreground-subtle">
            {t("git.empty.notRepositoryTitle")}
          </p>
        )}
      </div>

      <Dialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(confirmation?.kind === "discard" ? "scm.discard" : "scm.stageAndCommit")}
            </DialogTitle>
            <DialogDescription>
              {t(
                confirmation?.kind === "discard"
                  ? confirmation.staged
                    ? "scm.confirmDiscardStaged"
                    : "scm.confirmDiscard"
                  : "scm.confirmStage",
              )}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-ui-caption">
            {confirmation?.paths.join("\n")}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                const intent = confirmation;
                setConfirmation(null);
                if (!intent) return;
                if (intent.kind === "discard")
                  void perform(() => actions.discardPaths(intent.paths, intent.staged));
                else void submit(Boolean(intent.push), intent.paths);
              }}
            >
              {t("scm.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
  return (
    <div
      data-testid="source-control-panel"
      data-workspace-path={workspacePath}
      data-workspace-identity={workspaceIdentity}
      className="h-full min-h-0 text-ui-base"
    >
      <GitPane
        onOpenCodeViewer={onOpenCodeViewer}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        workspaceRemoteSessionId={workspaceRemoteSessionId}
        isDesktop={isDesktop}
        gitState={gitState}
        selectedSourceId="unstaged"
        onSelectSource={() => {}}
        onClose={() => {}}
        onRefresh={onRefresh}
        fileChangeFindActiveIndex={0}
        fileChangeFindNavigationRequestId={0}
        fileChangeFindQuery=""
        onFileChangeFindMatchCountChange={() => {}}
        sourceControl={{
          header,
          collapsedSections,
          // 只裁剪列表投影；分组计数来自同一过滤结果，批量动作范围与显示一致。
          changeFilter: isVisibleChange,
          emptyState:
            hideTestFiles && hiddenTestFileCount > 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-4 text-center">
                <FlaskConical className="size-6 text-foreground-subtlest" />
                <p className="mt-2 text-ui-base font-medium text-foreground">
                  {t("scm.testFilesHiddenTitle")}
                </p>
                <p className="mt-1 text-ui-base text-foreground-subtle">
                  {t("scm.testFilesHiddenDescription")}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => setGitReviewSettings({ hideTestFiles: false })}
                >
                  {t("scm.showTestFiles")}
                </Button>
              </div>
            ) : undefined,
          onToggleSection: (section) =>
            setCollapsedSections((previous) => {
              const next = new Set(previous);
              if (next.has(section)) next.delete(section);
              else next.add(section);
              return next;
            }),
          renderActions,
          renderGroupHeader: (section, files) =>
            group(
              section === "staged" ? "staged" : section === "conflicted" ? "conflicts" : "unstaged",
              t(
                section === "staged"
                  ? "scm.staged"
                  : section === "conflicted"
                    ? "scm.conflicts"
                    : "scm.changes",
              ),
              files,
              section === "staged",
            ),
        }}
      />
    </div>
  );
}
