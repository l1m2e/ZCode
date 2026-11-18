import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { SourceControlPanel } from "@/GitPane/SourceControlPanel.js";
import { PlatformProvider } from "@/hooks/usePlatform.tsx";
import { ServiceProvider } from "@/hooks/useServices.tsx";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { GitPaneRepositoryState } from "@/hooks/useGitRepository.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const locale = params.get("locale") === "en-US" ? "en-US" : "zh-CN";
localStorage.setItem("zcode-locale-preference", locale);
document.documentElement.className = "theme-zai-dark dark";

const WORKSPACE = "/fixture/trickle-web";

function change(
  workspaceRelativePath: string,
  overrides: Partial<GitPaneRepositoryState["datasets"]["unstaged"]["sections"][0]["changes"][0]>,
) {
  return {
    path: `${WORKSPACE}/${workspaceRelativePath}`,
    repoRelativePath: workspaceRelativePath,
    workspaceRelativePath,
    kind: "modified" as const,
    section: "unstaged" as const,
    added: 3,
    removed: 1,
    isStaged: false,
    isUntracked: false,
    isConflicted: false,
    x: ".",
    y: "M",
    diff: null,
    ...overrides,
  };
}

const unstagedChanges = [
  change("src/api/servers/mastra.ts", { added: 12, removed: 4 }),
  change("src/composables/useSSEEvents.ts", { added: 7, removed: 2 }),
  change("src/pages/Agent/useChat.ts", { added: 5, removed: 1 }),
  change("test/pages/Agent/Chat/chat-attachments.test.ts", { added: 9, removed: 3 }),
  change("test/pages/Agent/Chat/trace.test.ts", { added: 4, removed: 0 }),
  change("test/pages/Chat/fixtures.ts", { added: 2, removed: 0 }),
  change("src/pages/Agent/useChat-controller.test.ts", { added: 6, removed: 2 }),
  change("src/pages/Agent/ConversationSummaryMarkdown.vue", {
    added: 18,
    removed: 0,
    isUntracked: true,
    section: "untracked",
  }),
];

const stagedChanges = [
  change("src/pages/Agent/types.ts", {
    added: 2,
    removed: 1,
    isStaged: true,
    section: "staged",
    x: "M",
    y: ".",
  }),
  change("test/pages/Agent/session-reducer.test.ts", {
    added: 5,
    removed: 1,
    isStaged: true,
    section: "staged",
    x: "M",
    y: ".",
  }),
];

const gitState: GitPaneRepositoryState = {
  workspaceKey: WORKSPACE,
  summary: {
    workspacePath: WORKSPACE,
    repoRoot: WORKSPACE,
    workspaceInRepoPath: "",
    autoRefreshWatchPaths: [],
    branchName: "feature_0.77",
    trackingBranchName: null,
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: true,
    isGitAvailable: true,
    isRepository: true,
  },
  identity: {
    userName: "fixture",
    userEmail: "fixture@example.invalid",
    nameSource: null,
    emailSource: null,
    scopeLabel: null,
  },
  placeholder: { enabled: false },
  loading: false,
  error: null,
  revision: 1,
  sourceOptions: [
    { id: "unstaged", count: unstagedChanges.length, readonly: false, disabled: false },
    { id: "staged", count: stagedChanges.length, readonly: false, disabled: false },
    { id: "branch", count: 0, readonly: true, disabled: false },
    { id: "last-turn", count: 0, readonly: true, disabled: false },
  ],
  datasets: {
    unstaged: {
      id: "unstaged",
      readonly: false,
      sections: [
        { id: "unstaged", changes: unstagedChanges.filter((item) => item.section === "unstaged") },
        {
          id: "untracked",
          changes: unstagedChanges.filter((item) => item.section === "untracked"),
        },
      ],
    },
    staged: { id: "staged", readonly: false, sections: [{ id: "staged", changes: stagedChanges }] },
    branch: { id: "branch", readonly: true, sections: [] },
    "last-turn": { id: "last-turn", readonly: true, sections: [] },
  },
};

const calls: string[] = [];
(window as unknown as { fixtureCalls: string[] }).fixtureCalls = calls;

// 空状态分支需要“只剩测试文件”的数据；用查询参数切换，避免复制整套状态。
const onlyTestFiles = params.get("onlyTest") === "1";
if (onlyTestFiles) {
  const testsOnly = unstagedChanges.filter(
    (item) =>
      item.workspaceRelativePath.includes("/test/") ||
      item.workspaceRelativePath.endsWith(".test.ts"),
  );
  gitState.datasets.unstaged.sections = [
    { id: "unstaged", changes: testsOnly.filter((item) => item.section === "unstaged") },
    { id: "untracked", changes: testsOnly.filter((item) => item.section === "untracked") },
  ];
  gitState.datasets.staged.sections = [
    {
      id: "staged",
      changes: stagedChanges.filter((item) => item.workspaceRelativePath.endsWith(".test.ts")),
    },
  ];
}

const platform = { canOpenLocalFiles: false } as IPlatformService;
const services = {
  gitService: {
    getDiff: async ({ path }: { path: string }) => ({
      path,
      availability: "patch",
      patch: null,
      beforeContent: "const before = 1;\n",
      afterContent: "const before = 2;\n",
      summary: null,
    }),
    stagePaths: async ({ paths }: { paths: string[] }) => {
      calls.push(`stage:${paths.join(",")}`);
    },
    unstagePaths: async ({ paths }: { paths: string[] }) => {
      calls.push(`unstage:${paths.join(",")}`);
    },
    discardPaths: async ({ paths }: { paths: string[] }) => {
      calls.push(`discard:${paths.join(",")}`);
    },
    commit: async ({ paths }: { paths: string[] }) => {
      calls.push(`commit:${paths.join(",")}`);
      return { commitHash: "fixture" };
    },
    push: async () => {
      calls.push("push");
      return {};
    },
    generateCommitMessage: async () => ({ message: "feat: fixture" }),
  },
} as unknown as IServiceAccessor;

const broadcastService = {
  send: () => {},
  onMessage: () => ({ dispose: () => {} }),
} as unknown as Parameters<typeof StoreProvider>[0]["broadcastService"];

function Fixture() {
  return (
    <PlatformProvider platform={platform}>
      <ServiceProvider services={services}>
        <StoreProvider broadcastService={broadcastService}>
          <ZCodeIntlProvider initialLocale={locale === "en-US" ? "en-US" : "zh-CN"}>
            <TabStoreProvider>
              <div className="h-[820px] w-[900px] bg-background">
                <SourceControlPanel
                  workspacePath={WORKSPACE}
                  gitState={gitState}
                  onRefresh={() => calls.push("refresh")}
                  isDesktop={false}
                />
              </div>
            </TabStoreProvider>
          </ZCodeIntlProvider>
        </StoreProvider>
      </ServiceProvider>
    </PlatformProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
