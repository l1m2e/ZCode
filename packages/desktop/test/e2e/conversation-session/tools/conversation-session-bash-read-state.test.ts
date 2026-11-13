import {
  expandAssistantHistoriesWithContent,
  expandVisibleSummaryGroups,
} from "#e2e/helpers/conversation-session-tool-diagnostics";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
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
  E2E_REPLY_TOKEN,
  getV4ComposerText,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  countUpstreamRequests,
  waitForUpstreamRequestContaining,
} from "#e2e/helpers/conversation-session-network";
import {
  listToolCallBlocks,
  waitForToolCallBlockByToolName,
} from "#e2e/helpers/conversation-session-tool";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";

const CASE_ROOT = join(DEFAULT_WORKSPACE, "bash-read-state-e2e");
const TARGET_RELATIVE_PATH = "bash-read-state-e2e/target.txt";
const FORMATTER_RELATIVE_PATH = "bash-read-state-e2e/overwrite-target.mjs";
const TARGET_PATH = join(DEFAULT_WORKSPACE, TARGET_RELATIVE_PATH);
const FORMATTER_PATH = join(DEFAULT_WORKSPACE, FORMATTER_RELATIVE_PATH);
const FIRST_CONTEXT = "E2E_TOOL_HISTORY_UNCHANGED_FIRST";
const LAST_CONTEXT = "E2E_TOOL_HISTORY_UNCHANGED_LAST";
const INITIAL_LINES = [
  FIRST_CONTEXT,
  ...Array.from({ length: 10 }, (_, index) => `unchanged before ${index + 1}`),
  "alpha",
  "beta",
  ...Array.from({ length: 10 }, (_, index) => `unchanged after ${index + 1}`),
  LAST_CONTEXT,
];
const EDIT_LINE = INITIAL_LINES.indexOf("alpha") + 1;
const EDITED_LINES = INITIAL_LINES.map((line) => (line === "alpha" ? "gamma" : line));
const INITIAL_CONTENT = `${INITIAL_LINES.join("\n")}\n`;
const FORMATTED_CONTENT = `${INITIAL_LINES.map((line) => (line === "alpha" ? "delta" : line)).join("\n")}\n`;
const COMPOSER_DRAFT = "E2E_TOOL_HISTORY_UNSENT_DRAFT";
const OLD_COMMENT = "E2E_TOOL_HISTORY_OLD_VERSION_COMMENT";
const STALE_HINT = "Call Read before editing";
const NOT_READ_ERROR = "File has not been read yet. Read it first before writing to it.";

describe("会话区 Bash read-state E2E", () => {
  afterEach(async () => {
    await rm(CASE_ROOT, { recursive: true, force: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(CASE_ROOT, { recursive: true, force: true });
    await clearAppData();
  });

  it("Bash read-state 与 formatter stale hint 保持，Edit chip 展示全文且新旧版评论仅加入草稿", async function () {
    this.timeout(180000);

    const runId = Date.now();
    const marker = `E2E_BASH_READ_STATE_${runId}`;
    await writeFixtures();
    await prepareV4ConversationE2E();
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await ensureToolCrossProductFullAccessMode();

    const prompt = buildPrompt(marker);
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "Bash read-state 首发后输入框没有清空");
    await waitForV4UserMessageContaining(marker);
    await waitForUpstreamRequestContaining(marker, 60000);

    await waitForToolCallBlockByToolName("Bash", 90000);
    await waitForToolCallBlockByToolName("Edit", 90000);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "Bash read-state 工具链没有回到 idle",
      120000,
    );

    // 完成后历史和工具组默认收起；先展开真实内容，再逐条检查 Bash/Edit。
    await expandAssistantHistoriesWithContent();
    await browser.waitUntil(
      async () => {
        await expandVisibleSummaryGroups();
        return (
          (await listToolCallBlocks()).filter((block) => block.toolName === "Bash").length === 2
        );
      },
      { timeout: 15000, timeoutMsg: "Bash 历史未展开" },
    );
    const toolBlocks = await listToolCallBlocks();
    expect(toolBlocks.filter((block) => block.toolName === "Bash").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(toolBlocks.some((block) => block.toolName === "Edit")).toBe(true);
    expect(await readFile(TARGET_PATH, "utf-8")).toBe(FORMATTED_CONTENT);
    expect(await countUpstreamRequests({ includes: [STALE_HINT] })).toBeGreaterThan(0);
    expect(await countUpstreamRequests({ includes: [NOT_READ_ERROR] })).toBe(0);

    // 工具文件名与轮次摘要 Review 是不同入口；formatter 已把磁盘改成 delta，
    // 这里必须仍打开该次 Edit 的 alpha → gamma 完整历史，不能用当前文件补全版本。
    await waitForToolCallBlockByToolName("Edit", 15000);
    const fileChip = $('[data-tool-name="Edit"] button [data-tool-file-name]');
    await fileChip.waitForDisplayed();
    await expect(fileChip).toHaveText("target.txt");
    await fileChip.click();

    const preview = $(`[data-testid="${TID_PREVIEW_PANE}"]`);
    await preview.waitForDisplayed();
    await expect($("[data-file-manager-pane]")).not.toExist();
    await expect(preview.$('[role="tree"]')).not.toExist();
    await expect(preview.$("[data-git-review-diff-scroll]")).toBeDisplayed();

    // 页头可能 portal 到 side pane 的标签栏，按专属属性查找真实切换按钮。
    const toggle = $("[data-preview-diff-style-toggle]");
    await toggle.waitForDisplayed();
    const split = await waitForToolDiff("split");
    expect(split.additions.lines).toEqual(EDITED_LINES);
    expect(split.deletions.lines).toEqual(INITIAL_LINES);
    expect(split.expandButtonCount).toBe(0);
    expect(split.additions.left!).toBeLessThan(split.deletions.left!);
    expect(split.text).not.toContain("delta");
    await expectDiffOverview();

    await setV4ComposerText(COMPOSER_DRAFT);
    const beforeComments = await getV4PaneSnapshot();
    const beforeRequests = await countUpstreamRequests({ includeTitle: true });
    expect(beforeComments.sessionId).not.toBeNull();

    // 真实 Shadow DOM 行号拖选后在末行下评论；空附言也保留新版的准确文本和行号。
    expect(
      await addHistoricalComment(
        "additions",
        EDIT_LINE,
        EDIT_LINE + 1,
        "",
        1,
        beforeComments.sessionId!,
      ),
    ).toMatchObject({
      side: "R",
      startLine: EDIT_LINE,
      endLine: EDIT_LINE + 1,
      selectedText: "gamma\nbeta",
      comment: "",
      sourceTitle: "target.txt",
      sourcePath: TARGET_PATH,
      workspacePath: DEFAULT_WORKSPACE,
      claimed: true,
    });
    expect(
      await addHistoricalComment(
        "deletions",
        EDIT_LINE,
        EDIT_LINE,
        OLD_COMMENT,
        2,
        beforeComments.sessionId!,
      ),
    ).toMatchObject({
      side: "L",
      startLine: EDIT_LINE,
      endLine: EDIT_LINE,
      selectedText: "alpha",
      comment: OLD_COMMENT,
      sourceTitle: "target.txt",
      sourcePath: TARGET_PATH,
      workspacePath: DEFAULT_WORKSPACE,
      claimed: true,
    });

    await toggle.click();
    const unified = await waitForToolDiff("unified");
    expect(unified.unified.lines).toContain(FIRST_CONTEXT);
    expect(unified.unified.lines).toContain(LAST_CONTEXT);
    expect(unified.unified.lines).toContain("alpha");
    expect(unified.unified.lines).toContain("gamma");
    expect(unified.expandButtonCount).toBe(0);
    expect(unified.text).not.toContain("delta");
    await expectDiffOverview();
    await expect($("[data-file-manager-pane]")).not.toExist();

    // 首行远离三行 hunk，单栏下也必须能引用完整历史中的未修改行。
    expect(
      await addHistoricalComment("additions", 1, 1, "", 3, beforeComments.sessionId!),
    ).toMatchObject({
      side: "R",
      startLine: 1,
      endLine: 1,
      selectedText: FIRST_CONTEXT,
      comment: "",
      claimed: true,
    });
    expect(await getV4ComposerText()).toBe(COMPOSER_DRAFT);
    const afterComments = await getV4PaneSnapshot();
    expect(afterComments.sessionId).toBe(beforeComments.sessionId);
    expect(afterComments.canStop).toBe(false);
    // timelineText 包含 composer，不能用它判断是否发送；请求数覆盖真实发送边界。
    expect(await countUpstreamRequests({ includeTitle: true })).toBe(beforeRequests);

    await toggle.click();
    const restored = await waitForToolDiff("split");
    expect(restored.additions.left!).toBeLessThan(restored.deletions.left!);
    expect(restored.additions.lines).toEqual(EDITED_LINES);
    expect(restored.deletions.lines).toEqual(INITIAL_LINES);
  });
});

function readToolDiff() {
  return browser.execute((previewId) => {
    const pane = document.querySelector(`[data-testid="${previewId}"]`);
    const shadow = pane?.querySelector("[data-diff-viewer] diffs-container")?.shadowRoot;
    const column = (selector: string) => {
      const code = shadow?.querySelector(selector);
      // wrap 模式 code 为 display:contents，读取实际内容列的矩形。
      const content = code?.querySelector<HTMLElement>("[data-content]");
      return {
        text: content?.textContent ?? "",
        lines: Array.from(content?.querySelectorAll<HTMLElement>("[data-line]") ?? []).map(
          (line) => line.textContent?.replace(/\n$/u, "") ?? "",
        ),
        left: content?.getBoundingClientRect().left ?? null,
      };
    };
    return {
      additions: column("code[data-additions]"),
      deletions: column("code[data-deletions]"),
      unified: column("code[data-unified]"),
      text: shadow?.textContent ?? "",
      expandButtonCount: shadow?.querySelectorAll("[data-expand-button]").length ?? 0,
    };
  }, TID_PREVIEW_PANE);
}

async function waitForToolDiff(style: "split" | "unified") {
  await browser.waitUntil(
    async () => {
      const diff = await readToolDiff();
      return style === "split"
        ? diff.additions.text.includes("gamma") &&
            diff.deletions.text.includes("alpha") &&
            diff.additions.lines.length === EDITED_LINES.length &&
            diff.deletions.lines.length === INITIAL_LINES.length &&
            diff.unified.left === null
        : diff.unified.text.includes("gamma") &&
            diff.unified.text.includes("alpha") &&
            diff.unified.lines.length === INITIAL_LINES.length + 1 &&
            diff.additions.left === null &&
            diff.deletions.left === null;
    },
    { timeout: 15000, timeoutMsg: `工具文件名预览没有呈现 ${style} 历史 diff` },
  );
  return readToolDiff();
}

async function expectDiffOverview() {
  const overview = $(`[data-testid="${TID_PREVIEW_PANE}"] [data-git-review-overview]`);
  await overview.waitForDisplayed();
  await expect(overview.$('[data-git-review-overview-change="additions"]')).toExist();
  await expect(overview.$('[data-git-review-overview-change="deletions"]')).toExist();
  await expect(overview.$("[data-git-review-overview-viewport]")).toExist();
}

interface HistoricalComment {
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

type HistoricalCommentWindow = Window & { __historicalDiffComment?: HistoricalComment };

async function addHistoricalComment(
  side: "additions" | "deletions",
  startLine: number,
  endLine: number,
  comment: string,
  attachmentCount: number,
  sessionId: string,
) {
  // 复用 GitPane E2E 的真实 Shadow DOM 行号坐标与 pointer 拖选，只旁听事件，不注入附件。
  await browser.execute(() => {
    const target = window as HistoricalCommentWindow;
    delete target.__historicalDiffComment;
    window.addEventListener(
      "zcode:code-comment-add-to-chat",
      (event) => {
        const detail = (event as CustomEvent<Omit<HistoricalComment, "claimed">>).detail;
        queueMicrotask(() => {
          target.__historicalDiffComment = { ...detail, claimed: event.defaultPrevented };
        });
      },
      { once: true },
    );
  });
  const points = await browser.execute(
    (paneId, version, start, end) => {
      const shadow = document.querySelector(
        `[data-testid="${paneId}"] diffs-container`,
      )?.shadowRoot;
      const split = shadow?.querySelector(`code[data-${version}]`);
      const code = split ?? shadow?.querySelector("code[data-unified]");
      const number = (line: number) => {
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
      const first = number(start);
      const last = number(end);
      if (!first || !last) throw new Error("历史 diff 中缺少待评论的真实行号");
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
    side,
    startLine,
    endLine,
  );
  try {
    await browser.performActions([
      {
        type: "pointer",
        id: "historical-diff-mouse",
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
  const placement = await browser.execute(
    (draftId, line) => {
      const draft = document.querySelector<HTMLElement>(`[data-testid="${draftId}"]`);
      let slotted = draft;
      while (slotted && !slotted.assignedSlot) slotted = slotted.parentElement;
      const slot = slotted?.assignedSlot;
      const annotation = slot?.closest("[data-line-annotation]");
      const previous = annotation?.previousElementSibling;
      return {
        slotName: slot?.name,
        followsLastLine: previous?.getAttribute("data-line") === String(line),
        draftTop: draft?.getBoundingClientRect().top ?? 0,
        selectedBottom: previous?.getBoundingClientRect().bottom ?? Infinity,
      };
    },
    TID_GIT_REVIEW_COMMENT_DRAFT,
    endLine,
  );
  expect(placement.slotName).toBe(`annotation-${side}-${endLine}`);
  expect(placement.followsLastLine).toBe(true);
  expect(placement.draftTop).toBeGreaterThanOrEqual(placement.selectedBottom - 2);
  await expect(draft.$("textarea")).toHaveValue("");
  if (comment) await draft.$("textarea").setValue(comment);
  const buttons = await draft.$$("button");
  expect(buttons).toHaveLength(2);
  await expect(buttons[1]!).toBeEnabled();
  await buttons[1]!.click();
  await draft.waitForExist({ reverse: true, timeout: 5000 });
  await browser.waitUntil(
    () =>
      browser.execute(
        (paneId, composerId, targetSessionId, count) => {
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
            (window as HistoricalCommentWindow).__historicalDiffComment?.claimed === true &&
            labels.length === 1 &&
            labels[0]!.startsWith(`${count} `)
          );
        },
        TID_V4_SESSION_PANE,
        TID_V4_COMPOSER,
        sessionId,
        attachmentCount,
      ),
    { timeout: 10000, timeoutMsg: `${attachmentCount} 条历史评论没有进入当前会话 composer` },
  );
  return browser.execute(() => (window as HistoricalCommentWindow).__historicalDiffComment!);
}

function buildPrompt(marker: string) {
  return [
    `${marker}: Follow these tool steps exactly.`,
    `1. Use Bash with exactly this command: cat ${TARGET_RELATIVE_PATH}`,
    `2. Use Edit on ${TARGET_PATH}; replace exactly "alpha" with "gamma".`,
    `3. Use Bash with exactly this command: node ${FORMATTER_RELATIVE_PATH} --fix`,
    `4. Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
    "Do not use the Read tool in this case.",
  ].join(" ");
}

async function writeFixtures() {
  await mkdir(CASE_ROOT, { recursive: true });
  await writeFile(TARGET_PATH, INITIAL_CONTENT, "utf-8");
  await writeFile(
    FORMATTER_PATH,
    [
      "import { writeFile } from 'node:fs/promises';",
      "await new Promise((resolve) => setTimeout(resolve, 30));",
      `await writeFile(${JSON.stringify(TARGET_PATH)}, ${JSON.stringify(FORMATTED_CONTENT)});`,
      "console.log('formatted target');",
      "",
    ].join("\n"),
    "utf-8",
  );
}
