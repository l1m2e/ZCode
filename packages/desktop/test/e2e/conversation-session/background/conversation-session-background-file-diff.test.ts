// BG41：background Agent 在父 launch turn 已 idle 后完成，独立 model-only turn
// 修改文件时仍必须能用隐藏 messageId 查询 checkpoint 并打开真实 Diff。
// 本 case 只覆盖 local desktop-continuous + 单 Agent + 单文件 Read/Edit；
// active-loop、batch、rewind、cold start、remote/replayable 由 catalog 剪枝。
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_GIT_REVIEW_COMMENT_DRAFT,
  TID_PREVIEW_PANE,
  TID_V4_COMPOSER,
  TID_V4_SESSION_PANE,
} from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  countUpstreamRequests,
  findFirstUpstreamRequestIndex,
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolCallId } from "#e2e/helpers/conversation-session-tool";
import {
  assertVisibleV4UserMessagesNotContaining,
  clickV4Stop,
  getV4ComposerText,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  switchV4Mode,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_ROOT = join(DEFAULT_WORKSPACE, "background-file-diff-e2e");
const RELATIVE_PATH = "background-file-diff-e2e/result.md";
const FILE_PATH = join(DEFAULT_WORKSPACE, RELATIVE_PATH);
const REQUEST_MARKER = "E2E_BACKGROUND_FILE_DIFF";
const CHILD_MARKER = "E2E_BACKGROUND_FILE_DIFF_CHILD_DONE";
const LAUNCH_MARKER = "background-file-diff-agent-launched-ok";
const FINAL_MARKER = "background-file-diff-ok";
const FIRST_CONTEXT = "E2E_TURN_HISTORY_UNCHANGED_FIRST";
const LAST_CONTEXT = "E2E_TURN_HISTORY_UNCHANGED_LAST";
const EDIT_LINE = 603;
// 1205 行跨过旧的 1200 行阈值；首尾离 hunk 很远，不能靠三行 patch 满足全文断言。
const INITIAL_LINES = Array.from({ length: 1205 }, (_, index) => {
  const line = index + 1;
  if (line === 1) return FIRST_CONTEXT;
  if (line === 1205) return LAST_CONTEXT;
  if (line === EDIT_LINE) return "before-background-diff";
  return `unchanged background context ${line}`;
});
const EXPECTED_LINES = INITIAL_LINES.map((line) =>
  line === "before-background-diff" ? "after-background-diff" : line,
);
const INITIAL_CONTENT = `${INITIAL_LINES.join("\n")}\n`;
const EXPECTED_CONTENT = `${EXPECTED_LINES.join("\n")}\n`;
const COMPOSER_DRAFT = "E2E_TURN_HISTORY_UNSENT_DRAFT";
const REVIEW_COMMENT = "E2E_TURN_HISTORY_NEW_VERSION_COMMENT";

interface FileSummarySnapshot {
  diffUnavailable: boolean;
  expanded: boolean;
  headerText: string;
  pathVisible: boolean;
  reviewEnabled: boolean;
  turnText: string;
}

describe("BG41 background model-only turn 文件 Diff", () => {
  afterEach(async () => {
    await stopIfBusy();
    await rm(CASE_ROOT, { force: true, recursive: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("父 turn idle 后 notification 摘要 Review 展开超过 1200 行历史全文且评论只加入草稿", async function () {
    this.timeout(240000);

    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
    await rm(CASE_ROOT, { force: true, recursive: true });
    await mkdir(CASE_ROOT, { recursive: true });
    await writeFile(FILE_PATH, INITIAL_CONTENT, "utf8");

    const firstExistingRecordIndex = (await getUpstreamRequestRecordCount()) - 1;
    await sendV4Prompt(
      `${REQUEST_MARKER}: launch one background Agent, then update ${RELATIVE_PATH} only after its completion notification.`,
    );
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_file_diff_agent", 60000);
    await waitForUpstreamRequest(
      {
        lastUserMessageIncludes: ["E2E_BACKGROUND_FILE_DIFF_CHILD"],
      },
      "BG41 background child provider request 没有开始",
      60000,
      { afterIndex: firstExistingRecordIndex },
    );
    await waitForV4TimelineContaining(LAUNCH_MARKER, 60000);
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "BG41 父 launch turn 没有在 child completion 前回到 idle",
      45000,
    );

    // Bug 复现前提：必须先观察到父轮稳定 idle，再允许 child 的延迟响应完成；
    // 否则 notification 可能合流 active loop，无法覆盖 model-only 隐藏 messageId。
    await browser.pause(500);
    expect((await getV4PaneSnapshot()).canStop).toBe(false);
    expect(
      await findFirstUpstreamRequestIndex(
        {
          includes: [REQUEST_MARKER, "<task-notification>", CHILD_MARKER],
          lastUserMessageIncludes: ["<task-notification>", CHILD_MARKER],
        },
        { afterIndex: firstExistingRecordIndex },
      ),
    ).toBeNull();

    await waitForUpstreamRequest(
      {
        includes: [REQUEST_MARKER, "<task-notification>", CHILD_MARKER],
        lastUserMessageIncludes: ["<task-notification>", CHILD_MARKER],
      },
      "BG41 child completion 没有触发独立 model-only notification request",
      60000,
      { afterIndex: firstExistingRecordIndex },
    );
    await waitForUpstreamRequest(
      {
        includes: ["toolu_e2e_background_file_diff_read", "before-background-diff"],
      },
      "BG41 Read 结果没有进入 notification product turn",
      60000,
      { afterIndex: firstExistingRecordIndex },
    );
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_file_diff_edit", 60000);
    await waitForV4TimelineContaining(FINAL_MARKER, 90000);
    await waitForFileContent(EXPECTED_CONTENT);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "BG41 notification Read/Edit 完成后没有回到 idle",
      60000,
    );

    await assertVisibleV4UserMessagesNotContaining("<task-notification>");
    await assertVisibleV4UserMessagesNotContaining(CHILD_MARKER);

    const collapsed = await waitForFileSummary(false);
    expect(collapsed.headerText).toMatch(/1 (file changed|个文件已更改)/);
    expect(collapsed.headerText).toContain("+1");
    expect(collapsed.headerText).toContain("-1");
    expect(collapsed.turnText).toContain(FINAL_MARKER);

    await expandFileSummary();
    const expanded = await waitForFileSummary(true);
    expect(expanded.pathVisible).toBe(true);
    expect(expanded.reviewEnabled).toBe(true);
    expect(expanded.diffUnavailable).toBe(false);
    expect(expanded.turnText).toContain(FINAL_MARKER);

    // 后续磁盘变化不能覆盖 notification 产品轮 checkpoint 的 first-before/final-after。
    await writeFile(FILE_PATH, "E2E_TURN_HISTORY_LATER_DISK_CONTENT\n", "utf8");
    await clickFileSummaryReview();
    const diff = await waitForPreviewDiff();
    expect(diff.additions.map((line) => line.text)).toEqual(EXPECTED_LINES);
    expect(diff.deletions.map((line) => line.text)).toEqual(INITIAL_LINES);
    const lineNumbers = Array.from({ length: INITIAL_LINES.length }, (_, index) => index + 1);
    expect(diff.additions.map((line) => line.number)).toEqual(lineNumbers);
    expect(diff.deletions.map((line) => line.number)).toEqual(lineNumbers);
    expect(diff.expandButtonCount).toBe(0);
    expect(diff.text).not.toContain("E2E_TURN_HISTORY_LATER_DISK_CONTENT");

    await setV4ComposerText(COMPOSER_DRAFT);
    const beforeComments = await getV4PaneSnapshot();
    const beforeRequests = await countUpstreamRequests({ includeTitle: true });
    expect(beforeComments.sessionId).not.toBeNull();
    await addReviewComment(beforeComments.sessionId!);
    expect(await getV4ComposerText()).toBe(COMPOSER_DRAFT);
    const afterComments = await getV4PaneSnapshot();
    expect(afterComments.sessionId).toBe(beforeComments.sessionId);
    expect(afterComments.canStop).toBe(false);
    // composer 文案不属于已发送消息，使用现有 network 记录检查没有新请求。
    expect(await countUpstreamRequests({ includeTitle: true })).toBe(beforeRequests);
  });
});

async function stopIfBusy() {
  const snapshot = await getV4PaneSnapshot().catch(() => null);
  if (!snapshot?.canStop) return;
  await clickV4Stop().catch(() => undefined);
  await waitForV4Pane(
    (candidate) => !candidate.canStop,
    "BG41 清理阶段主会话没有退出 running",
    30000,
  ).catch(() => undefined);
}

async function waitForFileContent(expected: string) {
  await browser.waitUntil(
    async () => (await readFile(FILE_PATH, "utf8").catch(() => "")) === expected,
    {
      timeout: 60000,
      timeoutMsg: `${FILE_PATH} 没有收敛到期望内容`,
    },
  );
}

async function waitForFileSummary(expectExpanded: boolean): Promise<FileSummarySnapshot> {
  let latest: FileSummarySnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await readFileSummary();
      return Boolean(
        latest &&
        latest.expanded === expectExpanded &&
        (!expectExpanded ||
          (latest.pathVisible && latest.reviewEnabled && !latest.diffUnavailable)),
      );
    },
    {
      timeout: 30000,
      timeoutMsg: expectExpanded
        ? `BG41 文件摘要展开后没有返回 ${RELATIVE_PATH} 的可审查 Diff`
        : "BG41 notification 产品轮次没有显示文件变更摘要",
    },
  );
  if (!latest) throw new Error("BG41 文件变更摘要快照为空");
  return latest;
}

function readFileSummary(): Promise<FileSummarySnapshot | null> {
  return browser.execute((relativePath) => {
    const expandLabels = new Set(["Expand changed files", "展开已更改文件"]);
    const collapseLabels = new Set(["Collapse changed files", "收起已更改文件"]);
    const reviewLabels = new Set(["Review", "审查"]);
    const header = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => {
        const label = button.getAttribute("aria-label") ?? "";
        return expandLabels.has(label) || collapseLabels.has(label);
      },
    );
    if (!header) return null;
    const card = header.parentElement?.parentElement;
    const turn = header.closest<HTMLElement>("[data-turn-key]");
    const label = header.getAttribute("aria-label") ?? "";
    const review = Array.from(card?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (button) => reviewLabels.has(button.getAttribute("aria-label") ?? ""),
    );
    const cardText = (card?.innerText ?? "").replace(/\u00a0/g, " ");
    return {
      diffUnavailable:
        cardText.includes("暂时无法预览这份 Diff") ||
        cardText.includes("Diff preview is temporarily unavailable"),
      expanded: collapseLabels.has(label),
      headerText: (header.innerText ?? "").replace(/\u00a0/g, " ").trim(),
      pathVisible: Boolean(
        card &&
        Array.from(card.querySelectorAll<HTMLElement>("[title]")).some((element) =>
          (element.getAttribute("title") ?? "").endsWith(relativePath),
        ),
      ),
      reviewEnabled: Boolean(review && !review.disabled),
      turnText: (turn?.innerText ?? "").replace(/\u00a0/g, " ").trim(),
    };
  }, RELATIVE_PATH);
}

async function expandFileSummary() {
  const clicked = await browser.execute(() => {
    const labels = new Set(["Expand changed files", "展开已更改文件"]);
    const header = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => labels.has(button.getAttribute("aria-label") ?? ""),
    );
    header?.click();
    return Boolean(header);
  });
  expect(clicked).toBe(true);
}

async function clickFileSummaryReview() {
  const clicked = await browser.execute(() => {
    const collapseLabels = new Set(["Collapse changed files", "收起已更改文件"]);
    const reviewLabels = new Set(["Review", "审查"]);
    const header = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => collapseLabels.has(button.getAttribute("aria-label") ?? ""),
    );
    const card = header?.parentElement?.parentElement;
    const review = Array.from(card?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (button) => reviewLabels.has(button.getAttribute("aria-label") ?? ""),
    );
    if (!review || review.disabled) return false;
    review.click();
    return true;
  });
  expect(clicked).toBe(true);
}

function readPreviewDiff() {
  return browser.execute((previewPaneTestId) => {
    const preview = document.querySelector<HTMLElement>(`[data-testid="${previewPaneTestId}"]`);
    const shadow = preview?.querySelector("[data-diff-viewer] diffs-container")?.shadowRoot;
    const lines = (side: string) =>
      Array.from(
        shadow?.querySelectorAll<HTMLElement>(`code[data-${side}] [data-content] [data-line]`) ??
          [],
      ).map((line) => ({
        number: Number(line.getAttribute("data-line")),
        text: line.textContent?.replace(/\n$/u, "") ?? "",
      }));
    return {
      additions: lines("additions"),
      deletions: lines("deletions"),
      expandButtonCount: shadow?.querySelectorAll("[data-expand-button]").length ?? 0,
      text: shadow?.textContent ?? "",
    };
  }, TID_PREVIEW_PANE);
}

async function waitForPreviewDiff() {
  await browser.waitUntil(
    async () => {
      const diff = await readPreviewDiff();
      return (
        diff.additions.length === EXPECTED_LINES.length &&
        diff.deletions.length === INITIAL_LINES.length &&
        diff.additions[EDIT_LINE - 1]?.text === "after-background-diff" &&
        diff.deletions[EDIT_LINE - 1]?.text === "before-background-diff"
      );
    },
    {
      timeout: 30000,
      timeoutMsg: "BG41 Review 没有默认展开超过 1200 行的 before/after 完整历史",
    },
  );
  return readPreviewDiff();
}

interface ReviewComment {
  side: "L" | "R";
  startLine: number;
  endLine: number;
  selectedText: string;
  comment: string;
  sourceTitle: string;
  sourcePath: string;
  workspacePath: string;
  claimed: boolean;
}

type ReviewCommentWindow = Window & { __turnReviewComment?: ReviewComment };

async function addReviewComment(sessionId: string) {
  // 只旁听真实产品事件，claimed 和 composer 附件均由生产链路产生。
  await browser.execute(() => {
    const target = window as ReviewCommentWindow;
    delete target.__turnReviewComment;
    window.addEventListener(
      "zcode:code-comment-add-to-chat",
      (event) => {
        const detail = (event as CustomEvent<Omit<ReviewComment, "claimed">>).detail;
        queueMicrotask(() => {
          target.__turnReviewComment = { ...detail, claimed: event.defaultPrevented };
        });
      },
      { once: true },
    );
  });
  // 沿用 GitPane 的 Shadow DOM 行号坐标拖选；覆盖变更行和紧接着的未修改行。
  const points = await browser.execute(
    (paneId, startLine) => {
      const code = document
        .querySelector(`[data-testid="${paneId}"] diffs-container`)
        ?.shadowRoot?.querySelector("code[data-additions]");
      const first = code?.querySelector<HTMLElement>(`[data-column-number="${startLine}"]`);
      const last = code?.querySelector<HTMLElement>(`[data-column-number="${startLine + 1}"]`);
      if (!first || !last) throw new Error("BG41 Review 缺少待评论的真实历史行号");
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
    TID_PREVIEW_PANE,
    EDIT_LINE,
  );
  try {
    await browser.performActions([
      {
        type: "pointer",
        id: "turn-review-mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: "viewport", ...points.start },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 250, origin: "viewport", ...points.end },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
  } finally {
    await browser.releaseActions();
  }
  const draft = $(`[data-testid="${TID_GIT_REVIEW_COMMENT_DRAFT}"]`);
  await draft.waitForDisplayed({ timeout: 10000 });
  const placement = await browser.execute((draftId) => {
    const draft = document.querySelector<HTMLElement>(`[data-testid="${draftId}"]`);
    let slotted = draft;
    while (slotted && !slotted.assignedSlot) slotted = slotted.parentElement;
    const slot = slotted?.assignedSlot;
    const annotation = slot?.closest("[data-line-annotation]");
    const previous = annotation?.previousElementSibling;
    return {
      slotName: slot?.name,
      previousLine: previous?.getAttribute("data-line"),
      draftTop: draft?.getBoundingClientRect().top ?? 0,
      selectedBottom: previous?.getBoundingClientRect().bottom ?? Infinity,
    };
  }, TID_GIT_REVIEW_COMMENT_DRAFT);
  expect(placement.slotName).toBe(`annotation-additions-${EDIT_LINE + 1}`);
  expect(placement.previousLine).toBe(String(EDIT_LINE + 1));
  expect(placement.draftTop).toBeGreaterThanOrEqual(placement.selectedBottom - 2);
  await draft.$("textarea").setValue(REVIEW_COMMENT);
  const buttons = await draft.$$("button");
  expect(buttons).toHaveLength(2);
  await expect(buttons[1]!).toBeEnabled();
  await buttons[1]!.click();
  await draft.waitForExist({ reverse: true, timeout: 5000 });
  await browser.waitUntil(
    () =>
      browser.execute(
        (paneId, composerId, targetSessionId) => {
          const pane = Array.from(document.querySelectorAll(`[data-testid^="${paneId}-"]`)).find(
            (node) => node.getAttribute("data-session-id") === targetSessionId,
          );
          const labels = Array.from(
            pane?.querySelectorAll(`[data-testid="${composerId}"] [role="button"][aria-label]`) ??
              [],
          )
            .map((node) => node.getAttribute("aria-label") ?? "")
            .filter((label) => /^\d+ (comments?|条评论)$/u.test(label));
          return (
            (window as ReviewCommentWindow).__turnReviewComment?.claimed === true &&
            labels.length === 1 &&
            labels[0]!.startsWith("1 ")
          );
        },
        TID_V4_SESSION_PANE,
        TID_V4_COMPOSER,
        sessionId,
      ),
    { timeout: 10000, timeoutMsg: "BG41 历史行评论没有进入当前会话 composer" },
  );
  expect(
    await browser.execute(() => (window as ReviewCommentWindow).__turnReviewComment),
  ).toMatchObject({
    side: "R",
    startLine: EDIT_LINE,
    endLine: EDIT_LINE + 1,
    selectedText: "after-background-diff\nunchanged background context 604",
    comment: REVIEW_COMMENT,
    sourceTitle: "result.md",
    sourcePath: FILE_PATH,
    workspacePath: DEFAULT_WORKSPACE,
    claimed: true,
  });
}
