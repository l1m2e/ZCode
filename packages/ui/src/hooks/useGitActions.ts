import { useCallback, useState, useSyncExternalStore } from "react";
import type { GitChangeSourceId } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";

// 同一目标的所有 UI 入口共享 admission，避免 stage/commit 与逐文件操作交错。
const pendingTargets = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const notify = () => {
  for (const listener of listeners) listener();
};

export function useGitActions(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  onRefresh?: () => void;
}) {
  const { workspacePath, workspaceIdentity, onRefresh } = options;
  const { gitService } = useServices();
  const key = JSON.stringify([workspaceIdentity?.trim() || workspacePath, workspacePath]);
  const pending = useSyncExternalStore(
    subscribe,
    () => pendingTargets.has(key),
    () => false,
  );
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useCallback(
    async (_sourceId?: GitChangeSourceId) => {
      setRefreshVersion((value) => value + 1);
      onRefresh?.();
    },
    [onRefresh],
  );
  const run = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      if (pendingTargets.has(key))
        throw new Error("A Git operation is already running for this workspace.");
      pendingTargets.add(key);
      notify();
      try {
        return await operation();
      } finally {
        pendingTargets.delete(key);
        notify();
        await refresh();
      }
    },
    [key, refresh],
  );
  const stagePaths = useCallback(
    (paths: string[]) => run(() => gitService.stagePaths({ workspacePath, paths })),
    [gitService, run, workspacePath],
  );
  const unstagePaths = useCallback(
    (paths: string[]) => run(() => gitService.unstagePaths({ workspacePath, paths })),
    [gitService, run, workspacePath],
  );
  const discardPaths = useCallback(
    (paths: string[], staged = false) =>
      run(() => gitService.discardPaths({ workspacePath, paths, staged })),
    [gitService, run, workspacePath],
  );
  const commit = useCallback(
    (message: string, paths: string[]) =>
      run(() => gitService.commit({ workspacePath, message, paths, stagedOnly: true })),
    [gitService, run, workspacePath],
  );
  const push = useCallback(
    () => run(() => gitService.push({ workspacePath })),
    [gitService, run, workspacePath],
  );
  return {
    pending,
    run,
    refreshVersion,
    refresh,
    stagePaths,
    unstagePaths,
    discardPaths,
    commit,
    push,
  };
}
