import { memo, useCallback, useMemo } from "react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { SideChatPaneTab } from "@/lib/workspaceSidePane.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

// 独立侧边会话（docs/ui/side-pane-tabs.md「独立侧边会话」）：与主聊天无父子关系的
// workspace 级草稿台。首条消息发送前 childSessionId 缺席，SessionPane 以 sessionId=null
// 走既有 draft 预热；首发提升后 onSessionCreated 回填 tab，后续轮次复用该会话。
// 不传 rootSessionId / selectionSideChat：无父会话、无选中引用、无完成通知。
export const SideChatPane = memo(function SideChatPane({
  tab,
  focused,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onSessionCreated,
}: {
  tab: SideChatPaneTab;
  focused: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onSessionCreated: (tabId: string, sessionId: string) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  const handleSessionCreated = useCallback(
    (sessionId: string) => onSessionCreated(tab.id, sessionId),
    [onSessionCreated, tab.id],
  );
  return (
    <V4PaneConversationProvider scope={scope}>
      <SessionPane
        paneId={tab.id}
        sessionId={tab.childSessionId ?? null}
        openTrigger="pane"
        focused={focused}
        telemetryVisible={focused}
        workspacePath={tab.workspacePath}
        workspaceIdentity={tab.workspaceIdentity}
        remoteSessionId={tab.remoteSessionId}
        onSessionCreated={handleSessionCreated}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
      />
    </V4PaneConversationProvider>
  );
});
