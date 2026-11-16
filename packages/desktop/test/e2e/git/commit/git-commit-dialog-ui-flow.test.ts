import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { ServiceChannels } from "@zcode/shared";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import {
  E2E_REPLY_TOKEN,
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { sel } from "#e2e/helpers/selectors";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const TEST_TIMEOUT_MS = 120000;
const COMMIT_MESSAGE = "test(git): verify commit dialog keyboard flow";
const TARGET_BRANCH = "e2e-target";
const TID_CHAT_SUMMARY_PANEL = "chat-summary-panel";
const TID_GIT_ACTION_TRIGGER = "git-action-trigger";
const TID_GIT_COMMIT_ACTION_COMMAND = "git-commit-action-command";
const TID_GIT_COMMIT_ACTION_ITEM = "git-commit-action-item";
const TID_GIT_COMMIT_DIALOG = "git-commit-dialog";
const TID_GIT_COMMIT_GENERATE_BUTTON = "git-commit-generate-button";
const TID_GIT_COMMIT_INCLUDE_UNSTAGED = "git-commit-include-unstaged";
const TID_GIT_COMMIT_MESSAGE_INPUT = "git-commit-message-input";
const GIT_FIXTURE_FILE = join(".zcode-e2e", "git-commit-dialog", "tracked-file.md");
const GIT_FIXTURE_STAGED_FILE = join(".zcode-e2e", "git-commit-dialog", "staged-file.md");
const execGit = promisify(execFile);

function testId(base: string, suffix: string): string {
  return `${base}-${suffix}`;
}

describe("Git 提交弹窗 UI manual-review E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SCM-01: SCM复用Git列表并在当前标签查看diff及提交index", async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await enlargeWindowIfSupported();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await prepareGitRepositoryFixture();
    await writeFile(
      join(DEFAULT_WORKSPACE, GIT_FIXTURE_STAGED_FILE),
      Array.from({ length: 200 }, (_, index) => `same path unstaged marker ${index}`).join("\n") +
        "\n",
      "utf8",
    );
    await openSourceControlTab();
    await $(sel("source-control-panel")).waitForDisplayed({ timeout: 30000 });
    // 应用启动已读取预置仓库；测试在运行中改fixture后显式刷新，避免沿用启动快照。
    await $(
      `${sel("source-control-panel")} button[aria-label="刷新"], ${sel("source-control-panel")} button[aria-label="Refresh"]`,
    ).click();
    await $(
      `${sel("source-control-panel")} [data-git-review-file-section="staged"][data-git-review-file-row$="staged-file.md"] button`,
    ).waitForDisplayed({ timeout: 15000 });
    const message = $(sel("source-control-message"));
    const split = $(sel("source-control-submit"));
    expect(await split.getAttribute("data-disabled")).toBe("true");
    const disabledSplit = await browser.execute(() => {
      const group = document.querySelector('[data-testid="source-control-submit"]')!;
      return {
        opacity: getComputedStyle(group).opacity,
        halves: Array.from(group.querySelectorAll("button")).map((button) => ({
          disabled: button.disabled,
          opacity: getComputedStyle(button).opacity,
          background: getComputedStyle(button).backgroundColor,
        })),
      };
    });
    expect(disabledSplit.opacity).toBe("0.5");
    expect(disabledSplit.halves.every((half) => half.disabled && half.opacity === "1")).toBe(true);
    expect(disabledSplit.halves[0]?.background).toBe(disabledSplit.halves[1]?.background);
    await message.setValue(COMMIT_MESSAGE);
    expect(await split.getAttribute("data-disabled")).toBe("false");
    await $(sel("source-control-group-staged")).waitForDisplayed();
    await $(sel("source-control-group-unstaged")).waitForDisplayed();
    // 仅 isDisplayed 不会发现祖先 opacity:0；移开鼠标后检查实际可见样式。
    await message.moveTo();
    const groupActions = await browser.execute(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="source-control-group-staged"] button, [data-testid="source-control-group-unstaged"] button',
        ),
      ).map((button) => {
        let visible = true;
        for (let node: HTMLElement | null = button; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.opacity === "0" || style.visibility === "hidden" || style.display === "none")
            visible = false;
        }
        return {
          visible,
          iconOnly: button.textContent?.trim() === "",
          hasIcon: Boolean(button.querySelector("svg")),
        };
      }),
    );
    expect(groupActions.length).toBe(3);
    expect(
      groupActions.every((action) => action.visible && action.iconOnly && action.hasIcon),
    ).toBe(true);
    expect(await $(sel("source-control-group-unstaged")).$("svg.lucide-undo-2").isExisting()).toBe(
      true,
    );
    await browser.saveScreenshot("/tmp/zcode-scm-groups-visible.png");
    await $(
      `${sel("source-control-panel")} [data-git-review-file-section="staged"] button`,
    ).click();
    await $(sel("git-pane")).waitForDisplayed({ timeout: 15000 });
    expect(await $('[data-side-pane-tab-id="source-control"]').getAttribute("data-state")).toBe(
      "active",
    );
    expect(await $$('[data-side-pane-tab-id="git"]').length).toBe(0);
    expect(await $(sel("git-pane")).getAttribute("data-git-selected-source")).toBe("staged");
    await $(sel("side-pane-full-view-toggle")).click();
    await $(sel("source-control-group-staged")).moveTo();
    await $(sel("source-control-unstage-all")).waitForDisplayed({
      timeout: 15000,
    });
    await $(
      `${sel("source-control-panel")} [data-git-review-file-section="unstaged"][data-git-review-file-row$="staged-file.md"] button`,
    ).click();
    await $("[data-git-review-diff-scroll]").waitForExist({ timeout: 15000 });
    await $(
      "[data-git-review-diff-scroll] [data-diff-viewer], [data-git-review-plain-text-diff-preview]",
    ).waitForExist({ timeout: 15000 });
    // 布局回归：提交区属于左栏，diff 从两栏共同顶部展开；不能仅检查 DOM 存在。
    const geometry = await browser.execute(() => {
      const message = document
        .querySelector('[data-testid="source-control-message"]')!
        .getBoundingClientRect();
      const list = document
        .querySelector('[data-testid="git-pane"] #file-list')!
        .getBoundingClientRect();
      const diff = document
        .querySelector('[data-testid="git-pane"] #diff')!
        .getBoundingClientRect();
      return {
        messageRight: message.right,
        listRight: list.right,
        listTop: list.top,
        diffTop: diff.top,
        diffLeft: diff.left,
        listWidth: list.width,
      };
    });
    expect(geometry.messageRight).toBeLessThanOrEqual(geometry.listRight);
    expect(geometry.diffLeft).toBeGreaterThanOrEqual(geometry.listRight);
    expect(Math.abs(geometry.listTop - geometry.diffTop)).toBeLessThan(2);
    expect(geometry.listWidth).toBeGreaterThanOrEqual(280);
    expect(geometry.listWidth).toBeLessThanOrEqual(360);
    const scmRow = $(
      '[data-git-review-file-section="unstaged"][data-git-review-file-row$="staged-file.md"]',
    );
    await scmRow.moveTo();
    await scmRow.$('[data-scm-action="stage"]').waitForDisplayed();
    await scmRow.$('[data-scm-action="discard"]').waitForDisplayed();
    await scmRow.$('[data-scm-action="open"]').waitForDisplayed();
    expect(await scmRow.$('[data-scm-action="discard"] svg.lucide-undo-2').isExisting()).toBe(true);
    const actionSurface = await browser.execute(() => {
      const row = document.querySelector<HTMLElement>(
        '[data-git-review-file-section="unstaged"][data-git-review-file-row$="staged-file.md"]',
      )!;
      const container = row.querySelector('[data-scm-action="open"]')!.parentElement!;
      const surface = getComputedStyle(container);
      return {
        background: surface.backgroundColor,
        shadow: surface.boxShadow,
        border: surface.borderTopWidth,
        iconOnly: Array.from(container.querySelectorAll("button")).every(
          (button) => !button.textContent?.trim() && Boolean(button.querySelector("svg")),
        ),
      };
    });
    expect(actionSurface).toEqual({
      background: "rgba(0, 0, 0, 0)",
      shadow: "none",
      border: "0px",
      iconOnly: true,
    });
    expect(await scmRow.$("[data-scm-status]").getText()).toBe("M");
    expect(await scmRow.$("[data-scm-directory]").getText()).toContain("git-commit-dialog");
    expect(await scmRow.$$('button[aria-haspopup="menu"]').length).toBe(0);
    await browser.saveScreenshot("/tmp/zcode-scm-layout.png");
    const collapse = $('[data-testid="git-pane"] button[aria-label="unstaged"][aria-expanded]');
    await collapse.click();
    expect(await collapse.getAttribute("aria-expanded")).toBe("false");
    expect(await $$('[data-git-review-file-section="unstaged"]').length).toBe(0);
    await collapse.click();
    await scmRow.waitForDisplayed();

    // 真实刷新时监听移除记录，短暂 loading 即使在最终断言前恢复也不能漏检。
    await browser.execute(() => {
      const selectors = [
        '[data-testid="git-pane"]',
        '[data-testid="source-control-message"]',
        '[data-testid="git-review-file-list"]',
        "[data-git-review-diff-scroll]",
        "[data-diff-viewer]",
      ];
      const nodes = selectors.map((selector) => document.querySelector(selector)!);
      const scroll = document.querySelector<HTMLElement>("[data-git-review-diff-scroll]")!;
      scroll.scrollTop = 120;
      if (scroll.scrollTop !== 120) throw new Error("fixture 必须产生可滚动 diff");
      const removed: string[] = [];
      const busySamples: boolean[] = [];
      const observer = new MutationObserver((records) => {
        const message = document.querySelector<HTMLTextAreaElement>(
          '[data-testid="source-control-message"]',
        );
        if (message?.disabled) {
          busySamples.push(
            Array.from(
              document.querySelectorAll<HTMLButtonElement>(
                '[data-testid="source-control-stage-all"], [data-testid="source-control-unstage-all"]',
              ),
            ).every((button) => button.disabled),
          );
        }
        for (const record of records)
          for (const node of record.removedNodes)
            nodes.forEach((target, index) => {
              if (node === target || node.contains(target)) removed.push(selectors[index]!);
            });
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled"],
      });
      Object.assign(window, {
        scmRefreshProbe: { nodes, removed, observer, busySamples },
      });
    });
    await $(sel("source-control-group-staged")).moveTo();
    await $(sel("source-control-unstage-all")).click();
    await $(sel("source-control-group-staged")).waitForExist({
      reverse: true,
      timeout: 15000,
    });
    await browser.waitUntil(async () => await message.isEnabled(), {
      timeout: 15000,
    });
    const removed = await browser.execute(() => {
      const probe = (
        window as unknown as {
          scmRefreshProbe: {
            removed: string[];
            observer: MutationObserver;
            busySamples: boolean[];
          };
        }
      ).scmRefreshProbe;
      probe.observer.disconnect();
      if (!probe.busySamples.length || probe.busySamples.some((disabled) => !disabled))
        throw new Error("刷新期间写操作未保持禁用");
      return probe.removed;
    });
    expect(removed).toEqual([]);
    expect(
      await browser.execute(
        () => document.querySelector("[data-git-review-diff-scroll]")?.scrollTop,
      ),
    ).toBe(120);
    expect(await message.getValue()).toBe(COMMIT_MESSAGE);
    // 连续操作后 selection 跟随同路径，真实 index 与分组一致；不回退无关首项。
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await $(sel("source-control-group-unstaged")).moveTo();
      await $(sel("source-control-stage-all")).click();
      await $(sel("source-control-group-unstaged")).waitForExist({
        reverse: true,
        timeout: 15000,
      });
      await browser.waitUntil(async () => await message.isEnabled(), {
        timeout: 15000,
      });
      expect(await $(sel("git-pane")).getAttribute("data-git-selected-source")).toBe("staged");
      expect(await $(sel("git-pane")).getAttribute("data-git-selected-path")).toContain(
        "staged-file.md",
      );
      expect(
        (
          await execGit("git", ["diff", "--cached", "--name-only"], {
            cwd: DEFAULT_WORKSPACE,
          })
        ).stdout,
      ).toContain("staged-file.md");
      await $(sel("source-control-group-staged")).moveTo();
      await $(sel("source-control-unstage-all")).click();
      await $(sel("source-control-group-staged")).waitForExist({
        reverse: true,
        timeout: 15000,
      });
      await browser.waitUntil(async () => await message.isEnabled(), {
        timeout: 15000,
      });
      expect(await $(sel("git-pane")).getAttribute("data-git-selected-source")).toBe("unstaged");
      expect(await $(sel("git-pane")).getAttribute("data-git-selected-path")).toContain(
        "staged-file.md",
      );
      expect(
        (
          await execGit("git", ["diff", "--cached", "--name-only"], {
            cwd: DEFAULT_WORKSPACE,
          })
        ).stdout.trim(),
      ).toBe("");
      expect(await message.getValue()).toBe(COMMIT_MESSAGE);
    }
    // 恢复本用例的部分暂存前置条件。
    await execGit("git", ["add", GIT_FIXTURE_STAGED_FILE], {
      cwd: DEFAULT_WORKSPACE,
    });
    await writeFile(
      join(DEFAULT_WORKSPACE, GIT_FIXTURE_STAGED_FILE),
      "same path unstaged marker restored\n",
      "utf8",
    );
    await $(
      `${sel("source-control-panel")} button[aria-label="刷新"], ${sel("source-control-panel")} button[aria-label="Refresh"]`,
    ).click();
    await $(sel("source-control-group-staged")).waitForExist({
      timeout: 15000,
    });
    await returnToScmList();
    const unstagedRow = $(
      `${sel("source-control-panel")} [data-git-review-file-section="unstaged"][data-git-review-file-row$="staged-file.md"] button`,
    );
    await $(`${sel("source-control-panel")} [data-testid="git-review-file-filter"]`).setValue(
      "staged-file.md",
    );

    await unstagedRow.waitForDisplayed({ timeout: 15000 });
    await unstagedRow.click();
    expect(await $(sel("git-pane")).getAttribute("data-git-selected-source")).toBe("unstaged");
    await returnToScmList();
    await $(`${sel("source-control-panel")} [data-testid="git-review-file-filter"]`).click();
    await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"]);
    await browser.keys("Backspace");
    await message.waitForDisplayed();
    expect(await message.getValue()).toBe(COMMIT_MESSAGE);
    await $(sel("source-control-group-staged")).moveTo();
    await $(sel("source-control-unstage-all")).click();
    await browser.waitUntil(
      async () => {
        const result = await execGit("git", ["diff", "--cached", "--name-only"], {
          cwd: DEFAULT_WORKSPACE,
        });
        return !result.stdout.trim();
      },
      { timeout: 15000, timeoutMsg: "取消暂存没有更新真实 index" },
    );
    // 写操作完成后共享快照异步刷新；等待已暂存分组消失，再读取新更改组的操作范围。
    await $(sel("source-control-group-staged")).waitForExist({
      reverse: true,
      timeout: 15000,
    });

    await $(sel("source-control-group-unstaged")).moveTo();
    await $(sel("source-control-stage-all")).click();
    await browser.waitUntil(
      async () => {
        const result = await execGit("git", ["diff", "--cached", "--name-only"], {
          cwd: DEFAULT_WORKSPACE,
        });
        return (
          result.stdout.includes("tracked-file.md") && result.stdout.includes("staged-file.md")
        );
      },
      { timeout: 15000, timeoutMsg: "暂存没有更新真实 index" },
    );
    // 暂存后再次编辑同文件，提交快捷键只能提交 index，不能吸入这次工作树编辑。
    await writeFile(
      join(DEFAULT_WORKSPACE, GIT_FIXTURE_FILE),
      "baseline\nworking tree change\nkeep unstaged\n",
      "utf8",
    );
    await browser.waitUntil(async () => await message.isEnabled(), {
      timeout: 15000,
      timeoutMsg: "SCM刷新后输入未恢复",
    });
    await message.click();
    await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "Enter"]);
    await browser.waitUntil(
      async () => {
        const result = await execGit("git", ["log", "-1", "--format=%s"], {
          cwd: DEFAULT_WORKSPACE,
        });
        return result.stdout.trim() === COMMIT_MESSAGE;
      },
      { timeout: 15000, timeoutMsg: "SCM快捷键未完成真实提交" },
    );
    const committed = await execGit("git", ["show", `HEAD:${GIT_FIXTURE_FILE}`], {
      cwd: DEFAULT_WORKSPACE,
    });
    expect(committed.stdout).not.toContain("keep unstaged");
    const remaining = await execGit("git", ["diff", "--", GIT_FIXTURE_FILE], {
      cwd: DEFAULT_WORKSPACE,
    });
    expect(remaining.stdout).toContain("keep unstaged");
    await openSourceControlTab();
    expect(await $$('[data-side-pane-tab-id="source-control"]').length).toBe(1);
    await $(sel("side-pane-full-view-toggle")).click();
    await returnToScmList();
    await message.waitForDisplayed();
    await $('[data-git-review-file-section="unstaged"] button[aria-pressed]').click();
    await $(sel("git-pane")).waitForDisplayed();
    await returnToScmList();
    await message.waitForDisplayed();
  });

  it("SCM-02: 同一任务项目的多根目录隔离status、diff、index、commit和push", async function () {
    this.timeout(180000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await prepareGitRepositoryFixture();
    await createActiveTaskForSummaryPanel(true);
    await installHandoffRpcProbe();
    const taskId = (await getV4PaneSnapshot()).sessionId;
    const directories = await callHandoffHost<{ projectId?: string }>(
      ServiceChannels.Project,
      "resolveSessionDirectories",
      [{ workspacePath: DEFAULT_WORKSPACE, taskId }],
    );
    expect(Boolean(directories.projectId)).toBe(true);
    const projects = await callHandoffHost<
      Array<{ id: string; roots: Array<{ rootPath: string; isPrimary: boolean }> }>
    >(ServiceChannels.Project, "readProjects", [{}]);
    const project = projects.find((value) => value.id === directories.projectId)!;
    expect(project.roots.some((root) => root.rootPath === DEFAULT_WORKSPACE)).toBe(true);
    // B 与 bare remote 均在隔离 HOME 内，不能让 git add/commit 碰到开发仓库。
    const fixture = await mkdtemp(join(dirname(DEFAULT_WORKSPACE), "scm-multi-root-"));
    const rootB = join(fixture, "repository-b");
    const remoteB = join(fixture, "remote-b.git");
    await mkdir(rootB);
    await execGit("git", ["init", "-q", "-b", "scm-root-b"], { cwd: rootB });
    await execGit("git", ["config", "user.email", "zcode-e2e@example.invalid"], { cwd: rootB });
    await execGit("git", ["config", "user.name", "ZCode E2E"], { cwd: rootB });
    await writeFile(join(rootB, "only-b.md"), "B baseline\n");
    await execGit("git", ["add", "only-b.md"], { cwd: rootB });
    await execGit("git", ["commit", "-qm", "B baseline"], { cwd: rootB });
    await execGit("git", ["init", "--bare", "-q", remoteB], { cwd: fixture });
    await execGit("git", ["remote", "add", "origin", remoteB], { cwd: rootB });
    await execGit("git", ["push", "-qu", "origin", "HEAD"], { cwd: rootB });
    await writeFile(join(rootB, "only-b.md"), "B baseline\nSCM_ROOT_B_DIFF_MARKER\n");
    const readA = async () => ({
      head: (await execGit("git", ["rev-parse", "HEAD"], { cwd: DEFAULT_WORKSPACE })).stdout,
      index: (await execGit("git", ["diff", "--cached", "--binary"], { cwd: DEFAULT_WORKSPACE }))
        .stdout,
      status: (await execGit("git", ["status", "--porcelain"], { cwd: DEFAULT_WORKSPACE })).stdout,
      branch: (await execGit("git", ["branch", "--show-current"], { cwd: DEFAULT_WORKSPACE }))
        .stdout,
    });
    const beforeA = await readA();
    try {
      await callHandoffHost(ServiceChannels.Project, "saveProject", [
        {
          id: project.id,
          roots: [DEFAULT_WORKSPACE, rootB],
          primaryRoot: DEFAULT_WORKSPACE,
        },
      ]);
      await openSourceControlTab();
      const trigger = $(sel("source-control-repository-trigger"));
      await trigger.waitForDisplayed({ timeout: 15000 });
      await trigger.click();
      const options = await $$(sel("source-control-repository-option"));
      expect(await options.map((option) => option.getAttribute("data-workspace-path"))).toEqual([
        DEFAULT_WORKSPACE,
        rootB,
      ]);
      await browser.saveScreenshot("/tmp/zcode-scm-root-options.png");
      await $(
        `${sel("source-control-repository-option")}[data-workspace-path=${JSON.stringify(rootB)}]`,
      ).click();
      const panel = $(sel("source-control-panel"));
      await browser.waitUntil(
        async () => (await panel.getAttribute("data-workspace-path")) === rootB,
        { timeout: 15000 },
      );
      const row = $(
        `${sel("source-control-panel")} [data-git-review-file-section="unstaged"][data-git-review-file-row$="only-b.md"]`,
      );
      await row.waitForDisplayed({ timeout: 15000 });
      expect(await panel.getText()).toContain("scm-root-b");
      expect(await panel.$$("[data-branch-switcher-primary-icon]").length).toBe(0);
      expect(await panel.$$('[data-git-review-file-row$="tracked-file.md"]').length).toBe(0);
      await row.$("button[aria-pressed]").click();
      await browser.waitUntil(
        async () =>
          (await $("[data-git-review-diff-scroll]").getText()).includes("SCM_ROOT_B_DIFF_MARKER"),
        { timeout: 15000 },
      );
      await returnToScmList();
      await $(sel("source-control-stage-all")).click();
      await browser.waitUntil(
        async () =>
          (
            await execGit("git", ["diff", "--cached", "--name-only"], { cwd: rootB })
          ).stdout.trim() === "only-b.md",
        { timeout: 15000 },
      );
      expect(await readA()).toEqual(beforeA);
      const message = $(sel("source-control-message"));
      await browser.waitUntil(async () => await message.isEnabled(), { timeout: 15000 });
      await writeFile(
        join(rootB, "only-b.md"),
        "B baseline\nSCM_ROOT_B_DIFF_MARKER\nB_KEEP_UNSTAGED\n",
      );
      await message.setValue("test(scm): commit root B only");
      await message.click();
      await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "Enter"]);
      await browser.waitUntil(
        async () =>
          (await execGit("git", ["log", "-1", "--format=%s"], { cwd: rootB })).stdout.trim() ===
          "test(scm): commit root B only",
        { timeout: 15000 },
      );
      expect(
        (await execGit("git", ["show", "HEAD:only-b.md"], { cwd: rootB })).stdout,
      ).not.toContain("B_KEEP_UNSTAGED");
      expect((await execGit("git", ["diff", "--", "only-b.md"], { cwd: rootB })).stdout).toContain(
        "B_KEEP_UNSTAGED",
      );
      const commitB = (await execGit("git", ["rev-parse", "HEAD"], { cwd: rootB })).stdout.trim();
      const menu = $(`${sel("source-control-submit")} button[aria-haspopup="menu"]`);
      await menu.waitForEnabled({ timeout: 15000 });
      await menu.click();
      // 通过可访问文案选真实菜单动作，不直接调用 Git service 代替 UI。
      await browser.waitUntil(
        async () => {
          for (const item of await $$('[role="menuitem"]')) {
            if (["推送", "Push"].includes((await item.getText()).trim())) {
              await item.click();
              return true;
            }
          }
          return false;
        },
        { timeout: 15000, timeoutMsg: "SCM push 菜单不可用" },
      );
      await browser.waitUntil(
        async () =>
          (
            await execGit("git", ["--git-dir", remoteB, "rev-parse", "refs/heads/scm-root-b"], {
              cwd: fixture,
            })
          ).stdout.trim() === commitB,
        { timeout: 15000 },
      );
      expect(await readA()).toEqual(beforeA);
      expect(
        (await execGit("git", ["branch", "--show-current"], { cwd: rootB })).stdout.trim(),
      ).toBe("scm-root-b");
      await browser.saveScreenshot("/tmp/zcode-scm-root-b.png");
      await trigger.click();
      await $(
        `${sel("source-control-repository-option")}[data-workspace-path=${JSON.stringify(DEFAULT_WORKSPACE)}]`,
      ).click();
      await browser.waitUntil(
        async () => (await panel.getAttribute("data-workspace-path")) === DEFAULT_WORKSPACE,
        { timeout: 15000 },
      );
      await $(
        `${sel("source-control-panel")} [data-git-review-file-row$="tracked-file.md"]`,
      ).waitForDisplayed({ timeout: 15000 });
      expect(await panel.$$('[data-git-review-file-row$="only-b.md"]').length).toBe(0);
      expect((await getV4PaneSnapshot()).sessionId).toBe(taskId);
      await browser.saveScreenshot("/tmp/zcode-scm-root-a.png");
    } finally {
      await callHandoffHost(ServiceChannels.Project, "saveProject", [
        {
          id: project.id,
          roots: project.roots.map((root) => root.rootPath),
          primaryRoot: project.roots.find((root) => root.isPrimary)?.rootPath,
        },
      ]);
      await restoreHandoffProbes();
    }
  });

  it("GCD-UI-01: 打开提交弹窗后可聚焦输入、切换未暂存范围、用方向键切换 Command 动作并展开分支列表", async function () {
    this.timeout(TEST_TIMEOUT_MS);

    await enlargeWindowIfSupported();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await prepareGitRepositoryFixture();
    await createActiveTaskForSummaryPanel();
    await expandSummaryPanelIfCollapsed();
    await openCommitDialog();
    await waitForCommitDialogReady();

    await assertDialogOverlayVisible();
    // 圆角规范迁移：提交弹窗曾局部覆盖为 xl，读取计算样式防止覆盖共享 2xl 默认值。
    const radius = await browser.execute((id) => {
      const dialog = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (!dialog) throw new Error("Git 提交弹窗不存在");
      return getComputedStyle(dialog).borderTopLeftRadius;
    }, TID_GIT_COMMIT_DIALOG);
    expect(radius).toBe("16px");
    await assertMessageInputFocused();
    await assertGenerateButtonIsIconOnly();
    await setCommitMessage(COMMIT_MESSAGE);
    await toggleIncludeUnstaged();

    await assertSelectedAction("commit");
    await pressArrowInMessageInput("ArrowDown");
    await assertSelectedAction("commitAndPush");
    await assertSelectedActionShowsShortcutOnly("commitAndPush");
    await pressArrowInMessageInput("ArrowUp");
    await assertSelectedAction("commit");

    await focusActionCommand();
    await browser.keys("ArrowDown");
    await assertSelectedAction("commitAndPush");

    await openBranchSwitcherFromDialog();
    await waitForBranchOption(TARGET_BRANCH);
  });
});

async function enlargeWindowIfSupported() {
  try {
    await browser.setWindowSize(1440, 900);
  } catch {
    // Electron Chromedriver 并不总是支持 window/rect；宽度只影响摘要面板自动展开策略。
  }
}

async function prepareGitRepositoryFixture(): Promise<void> {
  const fixturePath = join(DEFAULT_WORKSPACE, GIT_FIXTURE_FILE);
  await mkdir(dirname(fixturePath), { recursive: true });
  await execGit("git", ["init", "-q"], { cwd: DEFAULT_WORKSPACE });
  await execGit("git", ["config", "user.email", "zcode-e2e@example.invalid"], {
    cwd: DEFAULT_WORKSPACE,
  });
  await execGit("git", ["config", "user.name", "ZCode E2E"], {
    cwd: DEFAULT_WORKSPACE,
  });
  await writeFile(fixturePath, "baseline\n", "utf8");
  await execGit("git", ["add", GIT_FIXTURE_FILE], { cwd: DEFAULT_WORKSPACE });
  await execGit("git", ["commit", "-qm", "test: git dialog baseline"], {
    cwd: DEFAULT_WORKSPACE,
  });
  await execGit("git", ["branch", "-f", TARGET_BRANCH], {
    cwd: DEFAULT_WORKSPACE,
  });
  // 该用例会关闭“包含未暂存更改”。因此 fixture 必须同时提供一个已暂存和一个未暂存
  // 改动；之前只有未暂存改动，关闭后提交动作正确地变为 disabled，却被误判为 UI 回归。
  await writeFile(
    join(DEFAULT_WORKSPACE, GIT_FIXTURE_STAGED_FILE),
    // 同一套件会重复准备；上一例暂存内容可能已进入下一次 baseline，必须产生新内容。
    `staged working tree change ${Date.now()}\n`,
    "utf8",
  );
  await execGit("git", ["add", GIT_FIXTURE_STAGED_FILE], {
    cwd: DEFAULT_WORKSPACE,
  });
  await writeFile(fixturePath, "baseline\nworking tree change\n", "utf8");
}

async function createActiveTaskForSummaryPanel(inProject = false) {
  await ensureReadonlyToolFixtureFile();
  await prepareV4ConversationE2E();
  // 多根测试必须从真实项目入口创建；通用准备函数允许无归属草稿。
  if (inProject) await startDraftFromProject(DEFAULT_WORKSPACE);
  const marker = `E2E_GIT_COMMIT_DIALOG_${Date.now()}`;
  await sendV4Prompt(buildReadonlyToolPrompt(marker));
  await waitForV4TimelineContaining(marker);
  await waitForV4TimelineContaining(E2E_REPLY_TOKEN, 90000);
  await waitForV4Pane(
    (snapshot) =>
      !snapshot.canStop && Boolean(snapshot.sessionId) && snapshot.sessionId !== "draft",
    "Git 提交弹窗 E2E 的真实 v4 session 没有完成",
    90000,
  );

  // 修复原因：直接向 Zustand 塞一个 CLI 不存在的 task 会被 v4 session 订阅校验清掉，
  // 导致 activeTaskId 竞态归零。测试必须通过真实 createSession/sendText 建立活动任务。
  await $(sel(TID_CHAT_SUMMARY_PANEL)).waitForDisplayed({
    timeout: 30000,
    timeoutMsg: "Git 提交弹窗 E2E 没有显示摘要面板",
  });
}

interface SummaryPanelSnapshot {
  buttonCount?: number;
  exists: boolean;
  gitActionVisible?: boolean;
  state?: string | null;
  text?: string;
}

async function expandSummaryPanelIfCollapsed() {
  let latest: SummaryPanelSnapshot | null = null;

  try {
    await browser.waitUntil(
      async () => {
        latest = (await browser.execute(
          (panelTestId: string, triggerTestId: string): SummaryPanelSnapshot => {
            const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
            if (!panel) {
              return { exists: false };
            }

            const getTriggerVisible = () => {
              const trigger = document.querySelector<HTMLElement>(
                `[data-testid="${triggerTestId}"]`,
              );
              const rect = trigger?.getBoundingClientRect();
              return Boolean(trigger && rect && rect.width > 0 && rect.height > 0);
            };

            if (!getTriggerVisible()) {
              const expandButton = panel.querySelector<HTMLElement>("button[aria-label]");
              expandButton?.click();
            }

            return {
              buttonCount: panel.querySelectorAll("button").length,
              exists: true,
              gitActionVisible: getTriggerVisible(),
              state: panel.getAttribute("data-state"),
              text: panel.textContent?.trim().slice(0, 200) ?? "",
            };
          },
          TID_CHAT_SUMMARY_PANEL,
          TID_GIT_ACTION_TRIGGER,
        )) as SummaryPanelSnapshot;
        return latest.gitActionVisible === true || latest.state === "expanded";
      },
      {
        timeout: 15000,
        timeoutMsg: "Git 提交弹窗 E2E 没有展开摘要面板",
      },
    );
  } catch (error) {
    throw new Error(`Git 提交弹窗 E2E 没有展开摘要面板: ${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
}

async function openCommitDialog() {
  let latest: SummaryPanelSnapshot | null = null;

  try {
    await browser.waitUntil(
      async () => {
        const result = (await browser.execute(
          (panelTestId: string, triggerTestId: string) => {
            const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
            const testIdTrigger = Array.from(
              document.querySelectorAll<HTMLElement>(`[data-testid="${triggerTestId}"]`),
            ).find((element) => {
              const disabled =
                (element instanceof HTMLButtonElement ||
                  element instanceof HTMLInputElement ||
                  element instanceof HTMLTextAreaElement) &&
                element.disabled;
              // macOS ChromeDriver 在状态面板 container query 切换后可能把已渲染的
              // button 报为 0×0；test id 和 disabled 才是这里的交互合同，DOM click
              // 也正是通用 helper 用于跨平台处理该 WebDriver 限制的路径。
              return !disabled;
            });
            // Git 汇总卡会把变更统计拼进可见文案（例如“提交或推送更改+3-0”）。
            // 保留 test id 优先级，并兼容旧渲染树只暴露文案入口的情形。
            const trigger =
              testIdTrigger ??
              Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((element) => {
                const text = element.innerText.trim();
                const label = element.getAttribute("aria-label")?.trim();
                return (
                  !element.disabled &&
                  [text, label].some(
                    (value) =>
                      value?.startsWith("Commit or push") || value?.startsWith("提交或推送"),
                  )
                );
              });
            trigger?.click();
            return {
              buttonCount: panel?.querySelectorAll("button").length,
              exists: Boolean(trigger),
              gitActionVisible: Boolean(trigger),
              state: panel?.getAttribute("data-state"),
              text: panel?.textContent?.trim().slice(0, 200) ?? "",
            };
          },
          TID_CHAT_SUMMARY_PANEL,
          TID_GIT_ACTION_TRIGGER,
        )) as SummaryPanelSnapshot;
        latest = result;
        return result.gitActionVisible === true;
      },
      {
        timeout: 30000,
        timeoutMsg: "Git 提交或推送入口没有出现或不可点击",
      },
    );
  } catch (error) {
    throw new Error(`Git 提交或推送入口没有出现或不可点击: ${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
}

async function waitForCommitDialogReady() {
  await $(sel(TID_GIT_COMMIT_DIALOG)).waitForDisplayed({
    timeout: 30000,
    timeoutMsg: "Git 提交弹窗没有打开",
  });
  await $(sel(TID_GIT_COMMIT_MESSAGE_INPUT)).waitForDisplayed({
    timeout: 30000,
    timeoutMsg: "Git 提交信息输入框没有出现",
  });
}

async function assertDialogOverlayVisible() {
  await browser.waitUntil(
    () => browser.execute(() => Boolean(document.querySelector('[data-slot="dialog-overlay"]'))),
    {
      timeout: 10000,
      timeoutMsg: "Git 提交弹窗没有显示 overlay",
    },
  );
}

async function assertMessageInputFocused() {
  await browser.waitUntil(
    () =>
      browser.execute(
        (inputTestId: string) =>
          document.activeElement?.getAttribute("data-testid") === inputTestId,
        TID_GIT_COMMIT_MESSAGE_INPUT,
      ),
    {
      timeout: 10000,
      timeoutMsg: "提交弹窗打开后没有自动聚焦提交信息输入框",
    },
  );
}

async function assertGenerateButtonIsIconOnly() {
  const snapshot = (await browser.execute((buttonTestId: string) => {
    const button = document.querySelector<HTMLElement>(`[data-testid="${buttonTestId}"]`);
    return {
      exists: Boolean(button),
      hasIcon: Boolean(button?.querySelector("svg")),
      text: button?.textContent?.trim() ?? "",
    };
  }, TID_GIT_COMMIT_GENERATE_BUTTON)) as {
    exists: boolean;
    hasIcon: boolean;
    text: string;
  };

  expect(snapshot).toEqual({ exists: true, hasIcon: true, text: "" });
}

async function setCommitMessage(message: string) {
  const input = $(sel(TID_GIT_COMMIT_MESSAGE_INPUT));
  await input.setValue(message);
  expect(await input.getValue()).toBe(message);
}

async function toggleIncludeUnstaged() {
  const checkbox = $(sel(TID_GIT_COMMIT_INCLUDE_UNSTAGED));
  await checkbox.waitForDisplayed({
    timeout: 10000,
    timeoutMsg: "包含未暂存更改 checkbox 没有出现",
  });
  expect(await checkbox.getAttribute("aria-checked")).toBe("true");
  await checkbox.click();
  await browser.waitUntil(async () => (await checkbox.getAttribute("aria-checked")) === "false", {
    timeout: 10000,
    timeoutMsg: "包含未暂存更改 checkbox 点击后没有切到 false",
  });
}

async function pressArrowInMessageInput(key: "ArrowDown" | "ArrowUp") {
  const input = $(sel(TID_GIT_COMMIT_MESSAGE_INPUT));
  await input.click();
  await browser.keys(key);
}

async function focusActionCommand() {
  await browser.execute((commandTestId: string) => {
    const command = document.querySelector<HTMLElement>(`[data-testid="${commandTestId}"]`);
    command?.focus();
  }, TID_GIT_COMMIT_ACTION_COMMAND);
}

async function assertSelectedAction(actionId: string) {
  await browser.waitUntil(async () => (await getSelectedActionId()) === actionId, {
    timeout: 10000,
    timeoutMsg: `提交弹窗选中动作不是 ${actionId}`,
  });
}

async function getSelectedActionId() {
  return browser.execute((actionItemBaseTestId: string) => {
    const prefix = `${actionItemBaseTestId}-`;
    const selected = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"][data-selected="true"]`),
    )[0];
    return selected?.dataset.testid?.slice(prefix.length) ?? null;
  }, TID_GIT_COMMIT_ACTION_ITEM);
}

async function assertSelectedActionShowsShortcutOnly(actionId: string) {
  const actionTestId = testId(TID_GIT_COMMIT_ACTION_ITEM, actionId);
  const snapshot = (await browser.execute((currentActionTestId: string) => {
    const action = document.querySelector<HTMLElement>(`[data-testid="${currentActionTestId}"]`);
    return {
      checked: action?.getAttribute("data-checked") ?? null,
      hasShortcut: Boolean(action?.querySelector('[data-slot="command-shortcut"]')),
    };
  }, actionTestId)) as { checked: string | null; hasShortcut: boolean };

  expect(snapshot).toEqual({ checked: null, hasShortcut: true });
}

async function openBranchSwitcherFromDialog() {
  await browser.waitUntil(
    async () =>
      browser.execute((dialogTestId: string) => {
        const dialog = document.querySelector(`[data-testid="${dialogTestId}"]`);
        const trigger = dialog
          ?.querySelector('[data-branch-switcher-primary-icon="true"]')
          ?.closest("button");
        trigger?.click();
        return Boolean(trigger);
      }, TID_GIT_COMMIT_DIALOG),
    {
      timeout: 10000,
      timeoutMsg: "提交弹窗顶部的分支切换入口没有出现",
    },
  );
}

async function waitForBranchOption(branchName: string) {
  await browser.waitUntil(
    () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')).some(
          (item) => item.textContent?.includes("e2e-target"),
        ),
      ),
    {
      timeout: 15000,
      timeoutMsg: `分支下拉列表没有展示可切换分支 ${branchName}`,
    },
  );
}

async function openSourceControlTab() {
  const launcher = $('[data-side-pane-open-tab-item="source-control"]');
  const add = $("[data-side-pane-add-tab-trigger]");
  if (!(await launcher.isDisplayed()) && !(await add.isDisplayed()))
    await $(sel("side-pane-toggle")).click();
  await browser.waitUntil(async () => (await launcher.isDisplayed()) || (await add.isDisplayed()), {
    timeout: 15000,
  });
  if (!(await launcher.isDisplayed())) await add.click();
  const item = $('[data-state="active"] [data-side-pane-open-tab-item="source-control"]');
  await item.waitForClickable({ timeout: 15000 });
  await item.click();
}

async function returnToScmList() {
  const back = $(
    `${sel("source-control-panel")} button[aria-label="Back to files"], ${sel("source-control-panel")} button[aria-label="返回文件列表"], ${sel("source-control-panel")} button[aria-label="Back to file list"]`,
  );
  if (await back.isDisplayed()) await back.click();
}
