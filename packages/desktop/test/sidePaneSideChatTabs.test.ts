import { describe, expect, it } from "vitest";
import {
  activateSourceControlSidePane,
  activateGitSidePane,
  closeSidePaneTab,
  restoreSidePaneTab,
  normalizeWorkspaceSidePaneState,
  getVisibleSidePaneTabs,
  isSidePaneTabVisibleInScope,
  openSideChatPane,
  setSideChatPaneSession,
  type WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";

const request = {
  workspacePath: "/work/repo",
  workspaceIdentity: "ident-1",
};

describe("独立侧边会话 tab（side-chat）", () => {
  it("每次打开都新建 tab，ordinal 递增并激活", () => {
    const first = openSideChatPane(null, { ...request, workspaceKey: "ident-1" });
    expect(first.tabs).toHaveLength(1);
    expect(first.tabs[0]).toMatchObject({
      type: "side-chat",
      workspaceKey: "ident-1",
      workspacePath: "/work/repo",
      workspaceIdentity: "ident-1",
      ordinal: 1,
    });
    // 未发消息前无 childSessionId（draft 预热自管）。
    expect((first.tabs[0] as { childSessionId?: string }).childSessionId).toBeUndefined();

    const second = openSideChatPane(first, { ...request, workspaceKey: "ident-1" });
    expect(second.tabs).toHaveLength(2);
    expect(second.tabs.map((tab) => tab.ordinal).sort()).toEqual([1, 2]);
    expect(second.activeTabId).toBe(second.tabs[1].id);
    // tab id 含随机段，两次打开不合并。
    expect(second.tabs[0].id).not.toBe(second.tabs[1].id);
  });

  it("回填 childSessionId：同值幂等，tab 已关闭时空操作", () => {
    const state = openSideChatPane(null, { ...request, workspaceKey: "ident-1" });
    const tabId = state.tabs[0].id;
    const promoted = setSideChatPaneSession(state, tabId, "sess-side");
    const promotedTab = promoted?.tabs[0] as { childSessionId?: string };
    expect(promotedTab.childSessionId).toBe("sess-side");

    const again = setSideChatPaneSession(promoted, tabId, "sess-side");
    expect(again).toBe(promoted);

    const closed = setSideChatPaneSession(state, "tab-gone", "sess-x");
    expect(closed).toBe(state);
    expect(setSideChatPaneSession(null, tabId, "sess-x")).toBeNull();
  });

  it("可见性为 workspace 级：不随主区 owner 会话切换隐藏", () => {
    const state: WorkspaceSidePaneState = openSideChatPane(null, {
      ...request,
      workspaceKey: "ident-1",
    });
    const tab = state.tabs[0];
    expect(isSidePaneTabVisibleInScope(tab, { workspaceKey: "ident-1", ownerTaskId: null })).toBe(
      true,
    );
    expect(
      isSidePaneTabVisibleInScope(tab, { workspaceKey: "ident-1", ownerTaskId: "task-a" }),
    ).toBe(true);
    expect(isSidePaneTabVisibleInScope(tab, { workspaceKey: "other", ownerTaskId: "task-a" })).toBe(
      false,
    );
    expect(
      getVisibleSidePaneTabs(state.tabs, { workspaceKey: "ident-1", ownerTaskId: "task-b" }),
    ).toHaveLength(1);
  });
});

describe("SCM 标签生命周期", () => {
  it("重复打开复用，审查保留SCM，JSON恢复及关闭重开保持类型", () => {
    const first = activateSourceControlSidePane(null);
    const scoped = {
      ...first,
      tabs: first.tabs.map((tab) => ({ ...tab, workspaceKey: "remote-identity" })),
    };
    const twice = activateSourceControlSidePane(scoped);
    expect(twice.tabs).toHaveLength(1);
    const review = activateGitSidePane(twice);
    expect(review.tabs.map((tab) => tab.type)).toEqual(["source-control", "git"]);
    const decoded = normalizeWorkspaceSidePaneState(JSON.parse(JSON.stringify(review)));
    expect(decoded?.tabs[0]).toMatchObject({
      type: "source-control",
      workspaceKey: "remote-identity",
    });
    const scm = decoded!.tabs[0]!;
    expect(
      isSidePaneTabVisibleInScope(scm, { workspaceKey: "remote-identity", ownerTaskId: "task-2" }),
    ).toBe(true);
    expect(
      isSidePaneTabVisibleInScope(scm, { workspaceKey: "local-path", ownerTaskId: "task-2" }),
    ).toBe(false);
    const closed = closeSidePaneTab(decoded, scm.id);
    expect(closed?.tabs.some((tab) => tab.type === "source-control")).toBe(false);
    const restored = restoreSidePaneTab(closed, scm);
    expect(restored.activeTabId).toBe("source-control");
    expect(restored.tabs.filter((tab) => tab.type === "source-control")).toHaveLength(1);
  });
});
