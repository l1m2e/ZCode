import { useCallback, useEffect, useState, type ComponentProps } from "react";
import { buildRemoteHostWorkspaceIdentity, remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useGitRepository } from "@/hooks/useGitRepository.js";
import { useGitAutoRefresh } from "@/hooks/useGitAutoRefresh.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Check, ChevronDown } from "lucide-react";
import { SourceControlPanel } from "./SourceControlPanel.js";

type PanelProps = ComponentProps<typeof SourceControlPanel>;
type Props = Omit<PanelProps, "repositorySelector"> & {
  projectWorkspacePath: string;
  activeTaskId: string | null;
  draftProjectId?: string | null;
};

/** 项目服务拥有 roots；这里只保存 SCM 的目录选择，不更改任务或全局导航。 */
export function ProjectSourceControlPanel(props: Props) {
  const {
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    projectWorkspacePath,
    activeTaskId,
    draftProjectId,
  } = props;
  const { intl } = useZCodeIntl();
  const resolution = useWorkspaceServicesResolution(
    projectWorkspacePath,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  const [roots, setRoots] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState(workspacePath);
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      if (!resolution.rpcReady) return;
      try {
        const service = resolution.services.projectService;
        if (!service) throw new Error("project.service-unavailable");
        const projectId = activeTaskId
          ? (
              await service.resolveSessionDirectories({
                workspacePath: projectWorkspacePath,
                workspaceIdentity,
                taskId: activeTaskId,
              })
            ).projectId
          : draftProjectId;
        const projects = projectId ? await service.readProjects({ includeDeleted: true }) : [];
        const project = projects.find((item) => item.id === projectId);
        // 只接收当前 attachment 的项目；远端 identity 必须保持同 Host，不能按同路径借用本机。
        const hostId = workspaceIdentity
          ? remoteHostIdFromWorkspaceIdentity(workspaceIdentity)
          : null;
        const paths =
          project && (!hostId || project.hostId === hostId)
            ? project.roots.map((root) => root.rootPath)
            : [];
        if (!disposed && request === generation) {
          setRoots(paths);
          setSelectedPath((current) =>
            current === workspacePath || paths.includes(current) ? current : workspacePath,
          );
        }
      } catch (error) {
        if (!disposed && request === generation) {
          setRoots([]);
          setSelectedPath(workspacePath);
          logger.warn("[SCM] 读取当前项目目录失败", error);
        }
      }
    };
    void refresh();
    const subscription = resolution.services.broadcastService.onMessage((event) => {
      if (event.channel === "state:projects") void refresh();
    });
    return () => {
      disposed = true;
      subscription.dispose();
    };
  }, [
    activeTaskId,
    draftProjectId,
    projectWorkspacePath,
    resolution.rpcReady,
    resolution.services,
    workspaceIdentity,
    workspacePath,
  ]);
  const options = Array.from(new Set([workspacePath, ...roots]));
  const hostId = workspaceIdentity ? remoteHostIdFromWorkspaceIdentity(workspaceIdentity) : null;
  const selectedIdentity =
    selectedPath === workspacePath
      ? workspaceIdentity
      : hostId
        ? buildRemoteHostWorkspaceIdentity(hostId, selectedPath)
        : workspaceIdentity;
  const target = useWorkspaceServicesResolution(
    selectedPath,
    resolution.remoteSessionId,
    selectedIdentity,
  );
  const repositorySelector = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 max-w-full justify-start px-1 text-ui-caption"
          data-testid="source-control-repository-trigger"
          title={selectedPath}
          aria-label={intl.formatMessage({ id: "scm.selectRepository" })}
        >
          <span className="min-w-0 truncate">
            {selectedPath.split(/[\\/]/).filter(Boolean).at(-1)}
          </span>
          <ChevronDown className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-sm">
        {options.map((path) => (
          <DropdownMenuItem
            key={path}
            data-testid="source-control-repository-option"
            data-workspace-path={path}
            onSelect={() => {
              if (path === selectedPath) return;
              // 返回默认目录时刷新 App owner，避免另一 root 属于同仓库而 index 已改变。
              if (path === workspacePath) props.onRefresh();
              setSelectedPath(path);
            }}
          >
            <Check className={`size-3.5 shrink-0 ${path === selectedPath ? "" : "invisible"}`} />
            <span className="min-w-0 break-all text-ui-caption">{path}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const panelProps = {
    ...props,
    workspacePath: selectedPath,
    workspaceIdentity: selectedIdentity,
    workspaceRemoteSessionId: target.remoteSessionId ?? undefined,
    repositorySelector,
  };
  return (
    <ServiceProvider services={target.services}>
      {selectedPath === workspacePath ? (
        <SourceControlPanel
          key={JSON.stringify([selectedIdentity, selectedPath])}
          {...panelProps}
        />
      ) : (
        <SelectedRepository
          key={JSON.stringify([selectedIdentity, selectedPath])}
          {...panelProps}
          rpcReady={target.rpcReady}
        />
      )}
    </ServiceProvider>
  );
}

/** 非默认目录独占现有快照 hook；默认目录仍复用 App owner，避免重复 Git 数据缓存。 */
function SelectedRepository({ rpcReady, ...props }: PanelProps & { rpcReady: boolean }) {
  const [refreshToken, setRefreshToken] = useState(0);
  const onRefresh = useCallback(() => setRefreshToken((value) => value + 1), []);
  const gitState = useGitRepository({
    workspacePath: props.workspacePath,
    workspaceIdentity: props.workspaceIdentity,
    remoteSessionId: props.workspaceRemoteSessionId,
    activeTaskId: null,
    refreshToken,
  });
  useGitAutoRefresh({
    workspacePath: props.workspacePath,
    workspaceIdentity: props.workspaceIdentity,
    remoteSessionId: props.workspaceRemoteSessionId,
    gitSummary: gitState.summary,
    gitSummaryWorkspaceKey: gitState.workspaceKey,
    enabled: rpcReady,
    onRefreshGit: onRefresh,
  });
  return <SourceControlPanel {...props} gitState={gitState} onRefresh={onRefresh} />;
}
