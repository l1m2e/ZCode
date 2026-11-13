import { execFile } from "node:child_process";
import { open, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  TID_CHAT_SUMMARY_PANEL,
  TID_GIT_PANE,
  TID_GIT_REVIEW_COMMENT_DRAFT,
  TID_GIT_REVIEW_DIFF_STYLE_TOGGLE,
  TID_GIT_REVIEW_FILE_LIST,
  TID_GIT_REVIEW_LIST_TOGGLE,
  TID_TASK_ITEM,
  TID_V4_COMPOSER,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import type { ChainablePromiseElement } from "webdriverio";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  setCurrentElectronRendererContentSize,
  waitForTestIdByDom,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { countUpstreamRequests } from "#e2e/helpers/conversation-session-network";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { PROVIDER_READINESS_HISTORY_SESSION_ID } from "#e2e/helpers/provider-readiness-history-fixture";
import {
  getV4ComposerText,
  getV4PaneSnapshot,
  selectV4TaskById,
  setV4ComposerText,
} from "#e2e/helpers/v4-conversation";

const CASE_TIMEOUT_MS = 120_000;
const FILE_NAME = "status-panel-review.txt";
const FIXTURE_RELATIVE_PATH = `.zcode-e2e/conversation-session-git-review-entry/${FILE_NAME}`;
const COMPOSER_DRAFT = "E2E_REVIEW_UNSENT_COMPOSER_DRAFT";
const COMMENT_TEXT = "E2E_REVIEW_OLD_VERSION_COMMENT";
const execFileAsync = promisify(execFile);
const CHANGES_LABELS = ["Changes", "更改"];
const EXPAND_LABELS = ["Expand status", "展开状态"];
const UNSTAGED_LABELS = ["Unstaged", "未暂存"];

describe("SP13：status panel Git Changes 打开变更审阅", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Changes 打开真实 rich diff，行内评论进入草稿且布局偏好冷重启保持", async function () {
    this.timeout(240_000);
    try {
      await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
      // 审查现在遵循全局换行偏好；折行场景显式开启设置，不再依赖组件强制覆盖。
      await browser.execute(() => {
        const key = "zcode-code-preview-settings";
        const settings = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
        localStorage.setItem(key, JSON.stringify({ ...settings, wrapLongLines: true }));
      });
      await reloadElectronSessionPreservingBrowserProfile(browser);
      await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
      await waitForTestIdByDom(testId(TID_TASK_ITEM, PROVIDER_READINESS_HISTORY_SESSION_ID), {
        timeout: 30_000,
        timeoutMsg: "SP13 预置的只读历史 session 没有出现在任务列表",
      });
      await selectV4TaskById(PROVIDER_READINESS_HISTORY_SESSION_ID);
      await waitForExpandedStatusPanel();

      expect(await isGitPaneMounted()).toBe(false);
      await clickStatusPanelChanges();
      const review = await waitForGitReview();
      expect(UNSTAGED_LABELS).toContain(review.sourceLabel);
      expect(review.rowCount).toBe(1);
      await ensureWideReviewPane();
      await clickGitReviewFileRow(FILE_NAME);
      const detail = await waitForGitReviewDiffContent();
      expect(detail.headerText).toContain(FILE_NAME);
      expect(["单栏对比", "Inline diff"]).toContain(detail.diffStyleToggleLabel);

      const split = await waitForRenderedDiff("split");
      assertFullDiff(split, "split");
      expect(split.list).not.toBeNull();
      expect(split.list!.right).toBeLessThanOrEqual(split.viewer!.left + 2);
      expect(split.additions!.right).toBeLessThanOrEqual(split.deletions!.left + 2);
      expect(split.additions!.top).toBeCloseTo(split.deletions!.top, 0);
      expect(split.additionLines.find((line) => line.number === 5)?.text).toContain(
        "E2E_REVIEW_NEW_FIRST",
      );
      expect(split.deletionLines.find((line) => line.number === 5)?.text).toContain(
        "E2E_REVIEW_OLD_FIRST",
      );
      await assertDiffOverviewNavigation();

      await setV4ComposerText(COMPOSER_DRAFT);
      const beforeComments = await getV4PaneSnapshot();
      const beforeRequests = await countUpstreamRequests({ includeTitle: true });
      await observeCodeCommentEvents();

      // 原生行号点击必须在当前行后创建 annotation；Esc 不向 composer 注入附件。
      await selectDiffLines("additions", 5);
      await assertInlineDraft("additions", 5, 5);
      await browser.keys("Escape");
      await waitForDraftClosed();
      expect(await readObservedComments()).toHaveLength(0);
      expect(await readCommentChipLabels()).toEqual([]);

      // 行号拖动覆盖真实连续行，空附言也必须成为当前 composer 的上下文附件。
      await selectDiffLines("additions", 5, 6);
      await assertInlineDraft("additions", 5, 6);
      await submitCommentDraft();
      const newComment = await waitForCommentAttachment(1);
      expect(newComment).toMatchObject({
        side: "R",
        startLine: 5,
        endLine: 6,
        selectedText: "E2E_REVIEW_NEW_FIRST = 101\nE2E_REVIEW_NEW_SECOND = 102",
        comment: "",
        sourceTitle: FILE_NAME,
        sourcePath: join(DEFAULT_WORKSPACE, FIXTURE_RELATIVE_PATH),
        workspacePath: DEFAULT_WORKSPACE,
      });

      // gutter + 覆盖旧版本；相同行号绝不能误取新版文本或标成 R。
      await selectDiffLines("deletions", 5, 5, true);
      await assertInlineDraft("deletions", 5, 5);
      await $(`[data-testid="${TID_GIT_REVIEW_COMMENT_DRAFT}"] textarea`).setValue(COMMENT_TEXT);
      await submitCommentDraft();
      expect(await waitForCommentAttachment(2)).toMatchObject({
        side: "L",
        startLine: 5,
        endLine: 5,
        selectedText: "E2E_REVIEW_OLD_FIRST = 1",
        comment: COMMENT_TEXT,
      });
      expect(await getV4ComposerText()).toBe(COMPOSER_DRAFT);
      const afterComments = await getV4PaneSnapshot();
      expect(afterComments.sessionId).toBe(beforeComments.sessionId);
      expect(afterComments.canStop).toBe(false);
      expect(afterComments.rowCount).toBe(beforeComments.rowCount);
      expect(afterComments.timelineText).toBe(beforeComments.timelineText);
      expect(await countUpstreamRequests({ includeTitle: true })).toBe(beforeRequests);

      await $(`[data-testid="${TID_GIT_REVIEW_DIFF_STYLE_TOGGLE}"]`).click();
      assertFullDiff(await waitForRenderedDiff("unified"), "unified");
      // unified 的两种版本混选必须拒绝，不把旧行号近似映射成新版上下文。
      await selectDiffLines("deletions", 5, 6, false, "additions");
      await waitForMixedSelectionError();
      expect(await readObservedComments()).toHaveLength(2);
      expect(await isCommentDraftMounted()).toBe(false);

      // 插入行导致上下文旧行 7 / 新行 8，unified context 必须仍按新版真实行号取文。
      await selectDiffLines("additions", 8);
      await assertInlineDraft("additions", 8, 8);
      await submitCommentDraft();
      expect(await waitForCommentAttachment(3)).toMatchObject({
        side: "R",
        startLine: 8,
        endLine: 8,
        selectedText: "unchanged context 7",
        comment: "",
      });
      expect(await getV4ComposerText()).toBe(COMPOSER_DRAFT);
      expect(await countUpstreamRequests({ includeTitle: true })).toBe(beforeRequests);

      const listed = await readRenderedDiff();
      await $(`[data-testid="${TID_GIT_REVIEW_LIST_TOGGLE}"]`).click();
      await browser.waitUntil(async () => (await readRenderedDiff()).list === null, {
        timeout: 10_000,
        timeoutMsg: "隐藏列表后文件列表仍占据布局空间",
      });
      const hidden = await readRenderedDiff();
      expect(hidden.viewer!.width).toBeGreaterThan(listed.viewer!.width + 200);
      await expectPersistedReviewSettings("unified", false);

      await reloadElectronSessionPreservingBrowserProfile(browser);
      await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
      await selectV4TaskById(PROVIDER_READINESS_HISTORY_SESSION_ID);
      if (!(await isGitPaneMounted())) {
        await waitForExpandedStatusPanel();
        await clickStatusPanelChanges();
      }
      await ensureWideReviewPane();
      expect((await readRenderedDiff()).list).toBeNull();
      await expectPersistedReviewSettings("unified", false);
      expect(
        await $(`[data-testid="${TID_GIT_REVIEW_DIFF_STYLE_TOGGLE}"]`).getAttribute("aria-label"),
      ).toMatch(/Split diff|双栏对比/u);

      await $(`[data-testid="${TID_GIT_REVIEW_LIST_TOGGLE}"]`).click();
      await browser.waitUntil(async () => (await readRenderedDiff()).list !== null, {
        timeout: 10_000,
        timeoutMsg: "重新显示列表没有恢复文件行",
      });
      await clickGitReviewFileRow(FILE_NAME);
      assertFullDiff(await waitForRenderedDiff("unified"), "unified");
      await $(`[data-testid="${TID_GIT_REVIEW_DIFF_STYLE_TOGGLE}"]`).click();
      assertFullDiff(await waitForRenderedDiff("split"), "split");
      await expectPersistedReviewSettings("split", true);
      expect(await countUpstreamRequests({ includeTitle: true })).toBe(beforeRequests);
    } finally {
      // tracked fixture 只属于这条审阅验收；恢复未跟踪状态，后续资源回归仍应是 +4 -0。
      await execFileAsync(process.env.ZCODE_GIT_BINARY?.trim() || "git", [
        "-C",
        DEFAULT_WORKSPACE,
        "rm",
        "--cached",
        "-f",
        "--",
        FIXTURE_RELATIVE_PATH,
      ]);
    }
  });

  it("Git 自动刷新跳过超限行数统计且 Host 内存有界", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await selectV4TaskById(PROVIDER_READINESS_HISTORY_SESSION_ID);
    await waitForExpandedStatusPanel();
    // 通过真实文件 watcher 刷新；无需打开 Git pane，也不创建会话或调用模型。
    const caseRoot = join(DEFAULT_WORKSPACE, ".zcode-e2e/conversation-session-git-review-entry");
    const largeText = "large-untracked.txt";
    await browser.electron.execute((electron) => {
      const state = globalThis as typeof globalThis & {
        gitMemoryProbe?: { baseline: number; peak: number; timer: ReturnType<typeof setInterval> };
      };
      const readHostKb = () =>
        electron.app
          .getAppMetrics()
          .filter((metric) => metric.name?.startsWith("zcode-host"))
          .reduce((total, metric) => total + metric.memory.workingSetSize, 0);
      const baseline = readHostKb();
      if (!baseline) throw new Error("没有找到待采样的真实 Host 进程");
      const probe = {
        baseline,
        peak: baseline,
        timer: setInterval(() => {
          probe.peak = Math.max(probe.peak, readHostKb());
        }, 25),
      };
      state.gitMemoryProbe = probe;
    });
    try {
      await writeFile(join(caseRoot, largeText), "line\n".repeat(300_000));
      for (let index = 0; index < 8; index++) {
        const file = await open(join(caseRoot, `large-${index}.bin`), "w");
        try {
          await file.truncate(32 * 1024 * 1024);
        } finally {
          await file.close();
        }
      }
      await writeFile(join(caseRoot, FILE_NAME), "one\ntwo\nthree\nfour\n");
      // Linux 只监听 Git 元数据；触发同一自动刷新入口，避免依赖递归文件监听。
      const changedAt = new Date();
      await utimes(join(DEFAULT_WORKSPACE, ".git", "HEAD"), changedAt, changedAt);
      await browser.waitUntil(
        async () => {
          const changes = await findButtonByLabels(
            $(`[data-testid="${TID_CHAT_SUMMARY_PANEL}"]`),
            CHANGES_LABELS,
          );
          return Boolean(changes && /\+4\s+-0/u.test(await changes.getText()));
        },
        // 产品的 watcher 防抖为 60 秒；等到新快照后才判断内存。
        {
          timeout: 90_000,
          interval: 500,
          timeoutMsg: "自动刷新应更新小文件为 +4，大文本不应计入行数",
        },
      );
    } finally {
      const memory = await browser.electron.execute(() => {
        const state = globalThis as typeof globalThis & {
          gitMemoryProbe?: {
            baseline: number;
            peak: number;
            timer: ReturnType<typeof setInterval>;
          };
        };
        const probe = state.gitMemoryProbe;
        if (!probe) throw new Error("Host 内存探针不存在");
        clearInterval(probe.timer);
        delete state.gitMemoryProbe;
        return {
          baselineKb: probe.baseline,
          peakKb: probe.peak,
          deltaKb: probe.peak - probe.baseline,
        };
      });
      console.log("[git-untracked-memory]", JSON.stringify(memory));
      // 256 MiB 文件应在读取前跳过；为真实 Electron 噪声留出 96 MiB 余量。
      expect(memory.deltaKb).toBeLessThan(96 * 1024);
    }
  });
});

async function waitForExpandedStatusPanel() {
  await waitForTestIdByDom(TID_CHAT_SUMMARY_PANEL, {
    timeout: 30_000,
    timeoutMsg: "SP13 未显示包含 Git Tools 的 status panel",
  });

  const panel = $(`[data-testid="${TID_CHAT_SUMMARY_PANEL}"]`);
  // auto 布局的 data-state 也是 expanded，但窄容器只显示“展开状态”摘要。
  // 必须确认真实审阅按钮可见，不能把摘要里的“更改”文字当作审阅入口。
  if (!(await findButtonByLabels(panel, CHANGES_LABELS))) {
    const expandButton = await findButtonByLabels(panel, EXPAND_LABELS);
    if (!expandButton) {
      throw new Error("SP13 status panel 处于收起态，但没有可点击的展开入口");
    }
    await expandButton.click();
  }

  await browser.waitUntil(
    async () =>
      (await panel.getAttribute("data-state")) === "expanded" &&
      Boolean(await findButtonByLabels(panel, CHANGES_LABELS)),
    {
      timeout: 30_000,
      timeoutMsg: "SP13 status panel 展开后没有可点击的 Changes / 更改入口",
    },
  );
}

async function clickStatusPanelChanges() {
  const panel = $(`[data-testid="${TID_CHAT_SUMMARY_PANEL}"]`);
  const changesButton = await findButtonByLabels(panel, CHANGES_LABELS);
  if (!changesButton) {
    throw new Error("SP13 没有找到 Changes / 更改按钮");
  }
  expect(await changesButton.isEnabled()).toBe(true);
  // 失败时保留真实输入和只读导航证据，区分按钮未命中、只读目录及面板状态未提交。
  await browser.execute(() => {
    const trace: string[] = [];
    (window as Window & { __gitReviewClickTrace?: string[] }).__gitReviewClickTrace = trace;
    document.addEventListener(
      "click",
      (event) => {
        if (trace.length < 8)
          trace.push((event.target as Element)?.closest("button")?.outerHTML ?? "non-button");
      },
      { capture: true },
    );
  });
  await changesButton.click();
}

async function findButtonByLabels(root: ChainablePromiseElement, labels: readonly string[]) {
  const buttons = await root.$$("button");
  for (const button of buttons) {
    if (!(await button.isDisplayed())) continue;
    const text = (await button.getText()).trim();
    const firstLine = text.split(/\r?\n/u, 1)[0] ?? "";
    const ariaLabel = (await button.getAttribute("aria-label"))?.trim() ?? "";
    if (labels.includes(ariaLabel || firstLine)) {
      return button;
    }
  }
  return null;
}

function isGitPaneMounted() {
  return browser.execute(
    (gitPaneTestId) => Boolean(document.querySelector(`[data-testid="${gitPaneTestId}"]`)),
    TID_GIT_PANE,
  );
}

interface GitReviewSnapshot {
  rowCount: number;
  sourceLabel: string;
  text: string;
}

async function waitForGitReview() {
  let latest: GitReviewSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await readGitReviewSnapshot();
        return (
          UNSTAGED_LABELS.includes(latest.sourceLabel) &&
          latest.text.includes(FILE_NAME) &&
          latest.rowCount > 0
        );
      },
      {
        timeout: 30_000,
        timeoutMsg: "SP13 Git review 没有显示 unstaged 目标文件",
      },
    );
  } catch (error) {
    latest = await readGitReviewSnapshot().catch(() => latest);
    const navigation = await browser.execute(() => {
      const bridge = window as Window & {
        __gitReviewClickTrace?: string[];
        __zcodeTabStoreE2E?: {
          getState(): { tabs: unknown[]; activeWorkspacePath: string | null };
        };
      };
      return {
        clickTrace: bridge.__gitReviewClickTrace,
        navigation: bridge.__zcodeTabStoreE2E?.getState().tabs,
        activePath: bridge.__zcodeTabStoreE2E?.getState().activeWorkspacePath,
        interfaceMode: localStorage.getItem("zcode-interface-mode"),
        sidePaneTabs: [...document.querySelectorAll("[data-side-pane-tab-id]")].map((el) => ({
          id: el.getAttribute("data-side-pane-tab-id"),
          state: el.getAttribute("data-state"),
          text: el.textContent,
        })),
      };
    });
    throw new Error(`SP13 Git review 断言失败: ${JSON.stringify({ ...latest, navigation })}`, {
      cause: error,
    });
  }
  return readGitReviewSnapshot();
}

function readGitReviewSnapshot(): Promise<GitReviewSnapshot> {
  return browser.execute((gitPaneTestId) => {
    const pane = document.querySelector<HTMLElement>(`[data-testid="${gitPaneTestId}"]`);
    const sourceTrigger = pane?.querySelector<HTMLElement>('[data-slot="select-trigger"]');
    return {
      rowCount: pane?.querySelectorAll("[data-git-review-file-row]").length ?? 0,
      sourceLabel: sourceTrigger?.textContent?.trim() ?? "",
      text: pane?.innerText ?? "",
    };
  }, TID_GIT_PANE);
}

async function clickGitReviewFileRow(fileName: string) {
  await browser.waitUntil(
    async () => {
      const row = await findGitReviewFileRow(fileName);
      return Boolean(row);
    },
    {
      timeout: 15_000,
      timeoutMsg: "SP13 Git review 左列表没有出现目标文件行",
    },
  );
  const row = await findGitReviewFileRow(fileName);
  if (!row) {
    throw new Error("SP13 Git review 文件行在点击前消失");
  }
  await row.click();
}

async function findGitReviewFileRow(fileName: string) {
  const rows = await $(`[data-testid="${TID_GIT_PANE}"]`).$$("[data-git-review-file-row]");
  for (const row of rows) {
    const path = (await row.getAttribute("data-git-review-file-row")) ?? "";
    if (path.split(/[\\/]/u).pop() === fileName) {
      return row;
    }
  }
  return null;
}

interface GitReviewDetailSnapshot {
  headerText: string;
  diffStyleToggleLabel: string;
}

async function waitForGitReviewDiffContent(): Promise<GitReviewDetailSnapshot> {
  let latest: GitReviewDetailSnapshot = { headerText: "", diffStyleToggleLabel: "" };
  try {
    await browser.waitUntil(
      async () => {
        latest = await readGitReviewDetailSnapshot();
        return latest.headerText.length > 0 && latest.diffStyleToggleLabel.length > 0;
      },
      {
        timeout: 15_000,
        timeoutMsg: "SP13 Git review 选中文件后没有出现 diff 内容区",
      },
    );
  } catch (error) {
    throw new Error(`SP13 Git review diff 内容断言失败: ${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
  return latest;
}

async function readGitReviewDetailSnapshot(): Promise<GitReviewDetailSnapshot> {
  return browser.execute(
    (gitPaneTestId, diffStyleToggleTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${gitPaneTestId}"]`);
      const diffStyleToggle = pane?.querySelector<HTMLElement>(
        `[data-testid="${diffStyleToggleTestId}"]`,
      );
      // diff 内容区专属头部：文件名 + 增删统计；未选中文件时不存在。
      const header = pane?.querySelector<HTMLElement>("[data-git-review-diff-header]");
      return {
        headerText: header?.textContent?.trim() ?? "",
        diffStyleToggleLabel: diffStyleToggle?.getAttribute("aria-label")?.trim() ?? "",
      };
    },
    TID_GIT_PANE,
    TID_GIT_REVIEW_DIFF_STYLE_TOGGLE,
  );
}

type DiffSide = "additions" | "deletions";
type DiffStyle = "split" | "unified";

function readRenderedDiff() {
  return browser.execute(
    (paneId, listId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneId}"]`);
      const viewer = pane?.querySelector<HTMLElement>("[data-diff-viewer]");
      const shadow = viewer?.querySelector("diffs-container")?.shadowRoot;
      const rect = (element: Element | null | undefined) => {
        if (!element) return null;
        const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
        return width > 0 && height > 0 ? { left, right, top, bottom, width, height } : null;
      };
      // wrap 模式的 code 是 display:contents，自身无布局盒；真实列由 gutter/content 组成。
      const columnRect = (selector: string) => {
        const code = shadow?.querySelector(selector);
        const gutter = rect(code?.querySelector("[data-gutter]"));
        const content = rect(code?.querySelector("[data-content]"));
        if (!gutter || !content) return null;
        const left = Math.min(gutter.left, content.left);
        const right = Math.max(gutter.right, content.right);
        const top = Math.min(gutter.top, content.top);
        const bottom = Math.max(gutter.bottom, content.bottom);
        return { left, right, top, bottom, width: right - left, height: bottom - top };
      };
      const readLines = (selector: string) =>
        Array.from(shadow?.querySelectorAll<HTMLElement>(`${selector} [data-line]`) ?? []).map(
          (line) => ({
            number: Number(line.getAttribute("data-line")),
            type: line.getAttribute("data-line-type"),
            text: line.textContent?.replace(/\n$/u, "") ?? "",
            height: line.getBoundingClientRect().height,
          }),
        );
      const overflow = [
        ...(pane?.querySelectorAll<HTMLElement>("*") ?? []),
        ...(shadow?.querySelectorAll<HTMLElement>("*") ?? []),
        ...(pane ? [pane] : []),
      ]
        .filter((node) => {
          if (node.clientWidth <= 0 || node.getBoundingClientRect().height <= 0) return false;
          const scrolls = /auto|scroll/u.test(getComputedStyle(node).overflowX);
          return (
            (scrolls || node.matches("pre, code, [data-content]")) &&
            node.scrollWidth > node.clientWidth + 2
          );
        })
        .map((node) => ({
          tag: node.tagName,
          width: node.clientWidth,
          scrollWidth: node.scrollWidth,
        }));
      return {
        pane: rect(pane),
        viewer: rect(viewer),
        list: rect(pane?.querySelector(`[data-testid="${listId}"]`)),
        additions: columnRect("code[data-additions]"),
        deletions: columnRect("code[data-deletions]"),
        unified: columnRect("code[data-unified]"),
        additionLines: readLines("code[data-additions]"),
        deletionLines: readLines("code[data-deletions]"),
        unifiedLines: readLines("code[data-unified]"),
        expandButtons: shadow?.querySelectorAll("[data-expand-button]").length ?? 0,
        trees: pane?.querySelectorAll('[role="tree"], [role="treeitem"]').length ?? 0,
        overflow,
      };
    },
    TID_GIT_PANE,
    TID_GIT_REVIEW_FILE_LIST,
  );
}

async function waitForRenderedDiff(style: DiffStyle) {
  await browser.waitUntil(
    async () => {
      const snapshot = await readRenderedDiff();
      return style === "split"
        ? snapshot.additionLines.length === 25 && snapshot.deletionLines.length === 24
        : snapshot.unifiedLines.length === 27;
    },
    { timeout: 20_000, timeoutMsg: `${style} rich diff 没有渲染完整的 fixture 行` },
  );
  return readRenderedDiff();
}

function assertFullDiff(snapshot: Awaited<ReturnType<typeof readRenderedDiff>>, style: DiffStyle) {
  const sequence = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
  expect(snapshot.trees).toBe(0);
  expect(snapshot.expandButtons).toBe(0);
  expect(snapshot.overflow).toEqual([]);
  expect(snapshot.viewer!.width).toBeGreaterThan(0);
  expect(snapshot.viewer!.right).toBeLessThanOrEqual(snapshot.pane!.right + 2);
  if (style === "split") {
    expect(snapshot.unified).toBeNull();
    expect(snapshot.additionLines.map((line) => line.number)).toEqual(sequence(25));
    expect(snapshot.deletionLines.map((line) => line.number)).toEqual(sequence(24));
    expect(snapshot.additions!.left).toBeLessThan(snapshot.deletions!.left);
    expect(snapshot.additions!.width).toBeGreaterThan(100);
    expect(snapshot.deletions!.width).toBeGreaterThan(100);
  } else {
    expect(snapshot.additions).toBeNull();
    expect(snapshot.deletions).toBeNull();
    expect(snapshot.unified!.width).toBeGreaterThan(200);
    expect(
      snapshot.unifiedLines
        .filter((line) => line.type !== "change-deletion")
        .map((line) => line.number),
    ).toEqual(sequence(25));
    expect(
      snapshot.unifiedLines
        .filter((line) => line.type === "change-deletion")
        .map((line) => line.number),
    ).toEqual([5, 6]);
  }
  const lines = style === "split" ? snapshot.additionLines : snapshot.unifiedLines;
  expect(
    lines.find((line) => line.text.startsWith("E2E_REVIEW_LONG_LINE"))!.height,
  ).toBeGreaterThan(lines[0]!.height * 2);
  expect(lines.at(-1)?.text).toBe("unchanged context 24");
}

async function assertDiffOverviewNavigation() {
  const track = $(`[data-testid="${TID_GIT_PANE}"] [data-git-review-overview]`);
  await track.waitForDisplayed({ timeout: 10_000 });
  const readOverview = () =>
    browser.execute((paneId) => {
      const pane = document.querySelector(`[data-testid="${paneId}"]`);
      const scroll = pane?.querySelector<HTMLElement>("[data-git-review-diff-scroll]");
      const overview = pane?.querySelector<HTMLElement>("[data-git-review-overview]");
      const marker = overview?.querySelector<HTMLElement>(
        '[data-git-review-overview-change="additions"]',
      );
      const shadow = pane?.querySelector("diffs-container")?.shadowRoot;
      const changed = shadow?.querySelector<HTMLElement>(
        '[data-content] [data-line-type="change-addition"]',
      );
      const viewport = overview?.querySelector<HTMLElement>("[data-git-review-overview-viewport]");
      if (!scroll || !overview || !marker || !changed || !viewport) return null;
      const contentTop = scroll.getBoundingClientRect().top;
      const changedTop = changed.getBoundingClientRect().top - contentTop + scroll.scrollTop;
      const maxScroll = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      return {
        scrollTop: scroll.scrollTop,
        maxScroll,
        target: Math.max(0, Math.min(maxScroll, changedTop - scroll.clientHeight / 2)),
        markerTop: Number.parseFloat(marker.style.top),
        expectedMarkerTop: (changedTop / scroll.scrollHeight) * 100,
        viewportTop: Number.parseFloat(viewport.style.top),
        expectedViewportTop: (scroll.scrollTop / scroll.scrollHeight) * 100,
        deletions: overview.querySelectorAll('[data-git-review-overview-change="deletions"]')
          .length,
      };
    }, TID_GIT_PANE);

  await browser.waitUntil(async () => (await readOverview()) !== null, {
    timeout: 10_000,
    timeoutMsg: "变更概览没有映射实际 diff 行",
  });
  const initial = (await readOverview())!;
  expect(initial.deletions).toBeGreaterThan(0);
  expect(initial.markerTop).toBeCloseTo(initial.expectedMarkerTop, 1);
  await track.$('[data-git-review-overview-change="additions"]').click();
  await browser.waitUntil(
    async () => {
      const current = await readOverview();
      return current !== null && Math.abs(current.scrollTop - current.target) < 2;
    },
    { timeout: 5_000, timeoutMsg: "点击概览没有定位到新增代码" },
  );
  // 概览持有焦点，键盘只改变既有滚动容器，不触发代码选区或评论。
  await browser.keys("End");
  await browser.waitUntil(
    async () => {
      const current = await readOverview();
      return current !== null && Math.abs(current.scrollTop - current.maxScroll) < 2;
    },
    { timeout: 5_000, timeoutMsg: "概览键盘导航没有滚动到底部" },
  );
  await browser.waitUntil(
    async () => {
      const current = await readOverview();
      return current !== null && Math.abs(current.viewportTop - current.expectedViewportTop) < 0.1;
    },
    { timeout: 5_000, timeoutMsg: "概览视口框没有跟随滚动" },
  );
  await browser.keys("Home");
  await browser.waitUntil(async () => (await readOverview())?.scrollTop === 0, {
    timeout: 5_000,
    timeoutMsg: "概览键盘导航没有返回顶部",
  });
  expect(await isCommentDraftMounted()).toBe(false);
}

async function ensureWideReviewPane() {
  // Electron 未实现 WebDriver window/rect 依赖的 Browser.getWindowForTarget；
  // 复用原生窗口 helper，并等 renderer viewport 收敛后再读取拖拽几何。
  await setCurrentElectronRendererContentSize(1600, 1000);
  const geometry = await browser.execute((paneId) => {
    const pane = document.querySelector(`[data-testid="${paneId}"]`)?.getBoundingClientRect();
    const handle = document
      .querySelector('[data-workspace-side-pane-resize-handle="true"]')
      ?.getBoundingClientRect();
    return {
      width: pane?.width ?? 0,
      handle: handle
        ? {
            x: Math.round(handle.left + handle.width / 2),
            y: Math.round(handle.top + handle.height / 2),
          }
        : null,
    };
  }, TID_GIT_PANE);
  if (geometry.width < 800) {
    if (!geometry.handle) throw new Error("Git review 面板不足 800px 且没有真实拖拽手柄");
    await pointerGesture(geometry.handle, {
      x: Math.max(300, geometry.handle.x - (820 - geometry.width)),
      y: geometry.handle.y,
    });
  }
  await browser.waitUntil(async () => ((await readRenderedDiff()).pane?.width ?? 0) >= 780, {
    timeout: 10_000,
    timeoutMsg: "Git review 面板没有通过真实拖拽进入宽屏左右布局",
  });
}

async function pointerGesture(start: { x: number; y: number }, end = start) {
  try {
    await browser.performActions([
      {
        type: "pointer",
        id: "git-review-mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: "viewport", ...start },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 250, origin: "viewport", ...end },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
  } finally {
    await browser.releaseActions();
  }
}

async function selectDiffLines(
  side: DiffSide,
  start: number,
  end = start,
  useGutterUtility = false,
  endSide: DiffSide = side,
) {
  const points = await browser.execute(
    (paneId, startSide, startLine, lastSide, endLine) => {
      const shadow = document.querySelector(
        `[data-testid="${paneId}"] diffs-container`,
      )?.shadowRoot;
      const number = (version: string, line: number) => {
        const split = shadow?.querySelector(`code[data-${version}]`);
        const code = split ?? shadow?.querySelector("code[data-unified]");
        const candidates = Array.from(
          code?.querySelectorAll<HTMLElement>(`[data-column-number="${line}"]`) ?? [],
        );
        return split
          ? candidates[0]
          : candidates.find((node) =>
              version === "deletions"
                ? node.getAttribute("data-line-type") === "change-deletion"
                : node.getAttribute("data-line-type") !== "change-deletion",
            );
      };
      const first = number(startSide, startLine);
      const last = number(lastSide, endLine);
      if (!first || !last) throw new Error("真实 diff 中缺少目标行号");
      first.scrollIntoView({ block: "center", inline: "nearest" });
      const center = (node: HTMLElement) => {
        const rect = node.getBoundingClientRect();
        return {
          x: Math.round(rect.right - 6),
          y: Math.round(rect.top + Math.min(rect.height / 2, 10)),
        };
      };
      return { start: center(first), end: center(last) };
    },
    TID_GIT_PANE,
    side,
    start,
    endSide,
    end,
  );
  if (useGutterUtility) {
    await browser.performActions([
      {
        type: "pointer",
        id: "git-review-mouse",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerMove", duration: 0, origin: "viewport", ...points.start }],
      },
    ]);
    await browser.waitUntil(
      () =>
        browser.execute((paneId) => {
          const button = document
            .querySelector(`[data-testid="${paneId}"] diffs-container`)
            ?.shadowRoot?.querySelector<HTMLElement>("[data-utility-button]");
          return Boolean(
            button && button.checkVisibility() && button.getBoundingClientRect().width > 0,
          );
        }, TID_GIT_PANE),
      { timeout: 5000, timeoutMsg: "hover 行号后 gutter + 没有出现" },
    );
    const utility = await browser.execute((paneId) => {
      const rect = document
        .querySelector(`[data-testid="${paneId}"] diffs-container`)
        ?.shadowRoot?.querySelector("[data-utility-button]")
        ?.getBoundingClientRect();
      if (!rect) throw new Error("gutter + 点击前消失");
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    }, TID_GIT_PANE);
    await pointerGesture(utility);
  } else {
    await pointerGesture(points.start, points.end);
  }
}

async function assertInlineDraft(side: DiffSide, startLine: number, endLine: number) {
  const draft = $(`[data-testid="${TID_GIT_REVIEW_COMMENT_DRAFT}"]`);
  await draft.waitForDisplayed({ timeout: 10_000 });
  const geometry = await browser.execute(
    (draftId, expectedSide, line) => {
      const draft = document.querySelector<HTMLElement>(`[data-testid="${draftId}"]`);
      let slotted = draft;
      while (slotted && !slotted.assignedSlot) slotted = slotted.parentElement;
      const slot = slotted?.assignedSlot;
      const annotation = slot?.closest("[data-line-annotation]");
      const code = annotation?.closest("code");
      const candidates = Array.from(
        code?.querySelectorAll<HTMLElement>(`[data-line="${line}"]`) ?? [],
      );
      const selected = candidates.find((node) =>
        code?.hasAttribute("data-unified")
          ? expectedSide === "deletions"
            ? node.getAttribute("data-line-type") === "change-deletion"
            : node.getAttribute("data-line-type") !== "change-deletion"
          : true,
      );
      const next = annotation?.nextElementSibling;
      return {
        slotName: slot?.name,
        text: draft?.textContent ?? "",
        value: draft?.querySelector<HTMLTextAreaElement>("textarea")?.value,
        draftTop: draft?.getBoundingClientRect().top ?? 0,
        draftBottom: draft?.getBoundingClientRect().bottom ?? 0,
        selectedBottom: selected?.getBoundingClientRect().bottom ?? Infinity,
        nextTop: next?.getBoundingClientRect().top ?? -Infinity,
        followsSelected: selected?.nextElementSibling === annotation,
      };
    },
    TID_GIT_REVIEW_COMMENT_DRAFT,
    side,
    endLine,
  );
  expect(geometry.slotName).toBe(`annotation-${side}-${endLine}`);
  expect(geometry.followsSelected).toBe(true);
  expect(geometry.draftTop).toBeGreaterThanOrEqual(geometry.selectedBottom - 2);
  expect(geometry.draftBottom).toBeLessThanOrEqual(geometry.nextTop + 2);
  expect(geometry.value).toBe("");
  expect(geometry.text.match(/\d+/gu)).toEqual(
    startLine === endLine ? [String(startLine)] : [String(startLine), String(endLine)],
  );
  await browser.waitUntil(() => draft.$("textarea").isFocused(), {
    timeout: 5000,
    timeoutMsg: "行内评论 textarea 没有获得焦点，不能验证 Esc 取消",
  });
}

function isCommentDraftMounted() {
  return browser.execute(
    (id) => Boolean(document.querySelector(`[data-testid="${id}"]`)),
    TID_GIT_REVIEW_COMMENT_DRAFT,
  );
}

async function waitForDraftClosed() {
  await browser.waitUntil(async () => !(await isCommentDraftMounted()), {
    timeout: 5000,
    timeoutMsg: "行内评论草稿没有关闭",
  });
}

async function submitCommentDraft() {
  const buttons = await $(`[data-testid="${TID_GIT_REVIEW_COMMENT_DRAFT}"]`).$$("button");
  expect(buttons).toHaveLength(2);
  expect(await buttons[1]!.isEnabled()).toBe(true);
  await buttons[1]!.click();
  await waitForDraftClosed();
}

interface ObservedComment {
  side?: "L" | "R";
  startLine: number;
  endLine: number;
  selectedText: string;
  comment: string;
  sourceTitle: string;
  sourcePath: string;
  workspacePath: string;
  claimed: boolean;
}

type ReviewEvidenceWindow = Window & { __gitReviewComments?: ObservedComment[] };

function observeCodeCommentEvents() {
  // 只旁听生产事件，不注入附件、不 preventDefault；claimed 由真实 composer 决定。
  return browser.execute(() => {
    const target = window as ReviewEvidenceWindow;
    target.__gitReviewComments = [];
    window.addEventListener("zcode:code-comment-add-to-chat", (event) => {
      const detail = (event as CustomEvent<Omit<ObservedComment, "claimed">>).detail;
      queueMicrotask(() =>
        target.__gitReviewComments?.push({ ...detail, claimed: event.defaultPrevented }),
      );
    });
  });
}

function readObservedComments() {
  return browser.execute(() => (window as ReviewEvidenceWindow).__gitReviewComments ?? []);
}

function readCommentChipLabels() {
  return browser.execute(
    (paneId, composerId, sessionId) => {
      const pane = Array.from(document.querySelectorAll(`[data-testid^="${paneId}-"]`)).find(
        (node) => node.getAttribute("data-session-id") === sessionId,
      );
      return Array.from(
        pane?.querySelectorAll(`[data-testid="${composerId}"] [role="button"][aria-label]`) ?? [],
      )
        .map((node) => node.getAttribute("aria-label") ?? "")
        .filter((label) => /^\d+ (comments?|条评论)$/u.test(label));
    },
    TID_V4_SESSION_PANE,
    TID_V4_COMPOSER,
    PROVIDER_READINESS_HISTORY_SESSION_ID,
  );
}

async function waitForCommentAttachment(count: number) {
  await browser.waitUntil(
    async () => {
      const labels = await readCommentChipLabels();
      return (
        (await readObservedComments()).length === count &&
        labels.length === 1 &&
        labels[0]!.startsWith(`${count} `)
      );
    },
    { timeout: 10_000, timeoutMsg: `${count} 条代码评论没有进入当前历史会话的 composer` },
  );
  const comment = (await readObservedComments())[count - 1]!;
  expect(comment.claimed).toBe(true);
  return comment;
}

async function waitForMixedSelectionError() {
  const error = $('[data-git-review-selection-error][role="status"]');
  await error.waitForDisplayed({ timeout: 5000 });
  expect((await error.getText()).trim().length).toBeGreaterThan(0);
}

async function expectPersistedReviewSettings(diffStyle: DiffStyle, fileListVisible: boolean) {
  const saved = await browser.execute(() => localStorage.getItem("zcode-git-review-settings"));
  expect(saved).not.toBeNull();
  expect(JSON.parse(saved!)).toMatchObject({ diffStyle, fileListVisible });
}
