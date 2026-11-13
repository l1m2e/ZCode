import type { IZCodeAgentService } from "@zcode/services";
import {
  conversationTopic,
  type V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServices } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import type { PatchCodeViewerSource } from "@/lib/codeViewer.js";
import { normalizeHistoricalDiffReference } from "@/lib/codeViewerSource.js";
import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";
import { shouldResyncForStaleAuthority } from "@/v4/staleAuthorityRecovery.js";

export function useZCodeAgentService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeAgentService {
  const contextServices = useServices();
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  return (workspacePath ? resolution.services : contextServices).zcodeAgentService;
}

type HistoricalDiffContent = NonNullable<
  V4ConversationFileChangesResult["items"][number]["content"]
>;
type HistoricalDiffState =
  | HistoricalDiffContent
  | {
      status: "missing-reference" | "waiting" | "loading" | "error";
    };

/** 复用来源 workspace/session 的 owner；这里只保存当前预览的临时全文投影。 */
export function useHistoricalDiffContent(source: PatchCodeViewerSource | null) {
  const workspacePath = source?.workspacePath;
  const workspaceIdentity = source?.workspaceIdentity;
  const preferredRemoteSessionId = source?.workspaceRemoteSessionId;
  const historicalContentPath = source?.conversation?.contentPath;
  const sourceSessionId = source?.conversation?.sessionId;
  const rowId = source?.conversation?.target?.rowId;
  const entityId = source?.conversation?.target?.entityId;
  const path = source?.path;
  const patch = source?.patch;
  const request = useMemo(() => {
    if (
      !workspacePath ||
      !path ||
      patch === undefined ||
      sourceSessionId === undefined ||
      rowId === undefined ||
      entityId === undefined
    )
      return null;
    const reference = normalizeHistoricalDiffReference({
      type: "patch",
      title: path,
      path,
      patch,
      workspacePath,
      conversation: {
        sessionId: sourceSessionId,
        target: { rowId, entityId },
        contentPath: historicalContentPath,
      },
    });
    return reference
      ? {
          ...reference,
          contentPath: reference.contentPath ?? path,
          workspacePath,
          workspaceIdentity,
          preferredRemoteSessionId,
        }
      : null;
  }, [
    workspacePath,
    workspaceIdentity,
    preferredRemoteSessionId,
    sourceSessionId,
    rowId,
    entityId,
    path,
    patch,
    historicalContentPath,
  ]);
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const { rpcReady, remoteSessionId } = resolution;
  const agentService = resolution.services.zcodeAgentService;
  const { createLocalMediaPreviewUrl } = usePlatform();
  const [retryVersion, setRetryVersion] = useState(0);
  const retry = useCallback(() => setRetryVersion((version) => version + 1), []);
  const [loaded, setLoaded] = useState<{
    request: typeof request;
    agentService: IZCodeAgentService;
    remoteSessionId: string | null;
    retryVersion: number;
    state: HistoricalDiffState;
  } | null>(null);

  useEffect(() => {
    if (!request || !rpcReady) return;
    let disposed = false;
    let settled = false;
    let inFlight = false;
    let generation = 0;
    let staleRetries = 0;
    const connection = acquireWorkspaceConnection(
      {
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        ...(remoteSessionId ? { remoteSessionId } : {}),
      },
      agentService,
      remoteSessionId ? undefined : createLocalMediaPreviewUrl,
    );
    connection.activateRemoteService();
    const lease = connection.layer.acquire(request.sessionId);
    let rejectedSnapshot: ReturnType<typeof lease.store.getState>["snapshot"] = null;
    const publish = (state: HistoricalDiffState) => {
      if (!disposed) setLoaded({ request, agentService, remoteSessionId, retryVersion, state });
    };
    const fail = () => {
      settled = true;
      publish({ status: "error" });
    };
    const read = () => {
      if (disposed || settled) return;
      const { status, projectionReady, snapshot } = lease.store.getState();
      if (status === "error" || status === "closed") {
        fail();
        return;
      }
      if (status !== "live" || !projectionReady || !snapshot) {
        // 连接换代后旧请求即使完成也不再可用；重新 live 时从同一个 store 取新水位。
        if (inFlight) generation++;
        inFlight = false;
        publish({ status: "waiting" });
        return;
      }
      if (inFlight || (rejectedSnapshot !== null && snapshot === rejectedSnapshot)) return;
      rejectedSnapshot = null;
      inFlight = true;
      const token = ++generation;
      publish({ status: "loading" });
      void connection.transport
        .fileChanges({
          sessionId: request.sessionId,
          target: request.target,
          contentPath: request.contentPath,
          baseRevision: snapshot.revision,
          baseLogEpoch: snapshot.logEpoch,
        })
        .then(
          (result) => {
            if (disposed || settled || token !== generation) return;
            inFlight = false;
            const current = lease.store.getState();
            if (current.snapshot?.logEpoch !== snapshot.logEpoch) {
              if (staleRetries++ < 2) read();
              else fail();
              return;
            }
            if (current.status !== "live" || !current.projectionReady) {
              read();
              return;
            }
            const content = result.items.find((item) => item.path === request.contentPath)?.content;
            settled = true;
            publish(content ?? { status: "unavailable" });
          },
          (error: unknown) => {
            if (disposed || settled || token !== generation) return;
            inFlight = false;
            if (shouldResyncForStaleAuthority(error)) {
              // staleTarget 本身不保证水位会变；不能永久等新帧。epoch/revision 竞态才有限重取。
              const reason =
                error instanceof Error
                  ? error.message
                  : typeof error === "string"
                    ? error
                    : (error as { reasonCode?: string } | null)?.reasonCode;
              if (reason !== "proto.staleTarget" && staleRetries++ < 2) {
                publish({ status: "loading" });
                const current = lease.store.getState().snapshot;
                if (
                  current?.logEpoch !== snapshot.logEpoch ||
                  current?.revision !== snapshot.revision
                ) {
                  read();
                } else {
                  rejectedSnapshot = snapshot;
                  lease.store.recoverFromStaleAuthority();
                }
                return;
              }
              lease.store.recoverFromStaleAuthority();
            }
            fail();
          },
        );
    };
    const unsubscribe = lease.store.subscribe(read);
    // same-sub recovery 可能返回对齐的空帧，store 不会因此换 snapshot 引用。
    // 观察现有恢复帧作为重取信号，避免无新业务事件时永远停在 loading。
    const unsubscribeRecovery = connection.transport.onFrame((frame, context) => {
      if (disposed || settled || !rejectedSnapshot || context?.deliveryKind !== "recovery") return;
      const current = lease.store.getState();
      if (
        frame.topic !== conversationTopic(request.sessionId) ||
        frame.subscriptionId !== current.subscriptionId ||
        frame.toSeq !== current.snapshot?.seq
      )
        return;
      rejectedSnapshot = null;
      read();
    });
    // 手动重试也复用 store 的已有连接恢复入口，不创建额外 runtime。
    if (retryVersion > 0 && lease.store.getState().status === "error") void lease.store.retry();
    read();
    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeRecovery();
      lease.release();
      connection.release();
    };
  }, [request, rpcReady, agentService, remoteSessionId, createLocalMediaPreviewUrl, retryVersion]);

  const state: HistoricalDiffState = !request
    ? { status: "missing-reference" }
    : !rpcReady
      ? { status: "waiting" }
      : loaded?.request === request &&
          loaded.agentService === agentService &&
          loaded.remoteSessionId === remoteSessionId &&
          loaded.retryVersion === retryVersion
        ? loaded.state
        : { status: "loading" };
  return { state, retry };
}
