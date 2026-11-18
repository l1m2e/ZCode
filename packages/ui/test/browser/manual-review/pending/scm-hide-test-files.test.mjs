// SCM 隐藏测试文件：真实 GitPane/SourceControlPanel/Store 链路，验证图标开关的
// 列表投影、分组计数、批量写操作范围、专用空状态和偏好持久化。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/scm-hide-test-files.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/scm-hide-test-files-browser");
const TOGGLE = '[data-testid="scm-hide-test-files-toggle"]';
let server;
let browser;
let origin;

before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "scm-hide-test-files-fixture",
        enforce: "pre",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: { ignored: ["**/packages/desktop/out/**", "**/.e2e-artifacts/**"] },
    },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function openFixture(locale = "zh-CN", extraQuery = "") {
  const page = await browser.newPage({ viewport: { width: 960, height: 900 } });
  page.setDefaultTimeout(90_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${origin}fixture?locale=${locale}${extraQuery}`);
  await page.locator(TOGGLE).waitFor();
  return { page, errors };
}

async function visibleRows(page) {
  return await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-git-review-file-row]")).map((row) =>
      row.getAttribute("data-git-review-file-row"),
    ),
  );
}

async function calls(page) {
  return await page.evaluate(() => window.fixtureCalls ?? []);
}

test("SCM 隐藏测试文件开关裁剪列表、计数与写操作范围", async () => {
  const { page, errors } = await openFixture();

  // 默认显示测试文件，开关处于未按下状态。
  assert.equal(await page.locator(TOGGLE).getAttribute("aria-pressed"), "false");
  const initialRows = await visibleRows(page);
  assert.ok(initialRows.some((path) => path?.endsWith("chat-attachments.test.ts")));
  assert.ok(initialRows.some((path) => path?.endsWith("mastra.ts")));
  assert.ok(initialRows.some((path) => path?.endsWith("session-reducer.test.ts")));
  await page.screenshot({
    path: join(artifacts, "01-default-show-test-files.png"),
    fullPage: true,
  });

  // 开启隐藏：测试目录与 *.test.ts 都消失，普通源码仍在，已暂存分组计数同步。
  await page.locator(TOGGLE).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-git-review-file-row$=".test.ts"]').length === 0 &&
      document.querySelectorAll('[data-git-review-file-row$="fixtures.ts"]').length === 0,
  );
  assert.equal(await page.locator(TOGGLE).getAttribute("aria-pressed"), "true");
  const hiddenRows = await visibleRows(page);
  assert.ok(hiddenRows.some((path) => path?.endsWith("mastra.ts")));
  assert.ok(hiddenRows.some((path) => path?.endsWith("ConversationSummaryMarkdown.vue")));
  assert.ok(!hiddenRows.some((path) => path?.includes("/test/")));
  assert.equal(
    await page.locator('[data-testid="source-control-group-staged"] span.tabular-nums').innerText(),
    "1",
  );
  assert.equal(
    await page
      .locator('[data-testid="source-control-group-unstaged"] span.tabular-nums')
      .innerText(),
    "4",
  );
  await page.screenshot({ path: join(artifacts, "02-hidden-test-files.png"), fullPage: true });

  // 批量暂存只覆盖可见文件；隐藏的测试文件不得进入 stage 调用。
  await page.locator('[data-testid="source-control-group-unstaged"]').hover();
  await page.locator('[data-testid="source-control-stage-all"]').click();
  await page.waitForFunction(() => (window.fixtureCalls ?? []).some((c) => c.startsWith("stage:")));
  const stageCall = (await calls(page)).find((c) => c.startsWith("stage:"));
  assert.ok(stageCall);
  assert.ok(stageCall.includes("mastra.ts"));
  assert.ok(!stageCall.includes(".test.ts"));
  assert.ok(!stageCall.includes("fixtures.ts"));

  // 关闭后全部条目恢复，选择仍有效。
  await page.locator(TOGGLE).click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-git-review-file-row$=".test.ts"]').length > 0,
  );
  assert.equal(await page.locator(TOGGLE).getAttribute("aria-pressed"), "false");

  // 偏好写入 localStorage 的既有 key。
  const stored = await page.evaluate(() => localStorage.getItem("zcode-git-review-settings"));
  assert.ok(stored);
  assert.equal(JSON.parse(stored).hideTestFiles, false);

  assert.deepEqual(errors, []);
  await page.close();
});

test("SCM 全部为测试文件时显示专用空状态并可一键恢复", async () => {
  const { page, errors } = await openFixture("zh-CN", "&onlyTest=1");
  await page.locator(TOGGLE).click();
  await page.waitForFunction(
    () => document.querySelectorAll("[data-git-review-file-row]").length === 0,
  );
  // 空状态必须说明是“测试文件已隐藏”，不能误报“当前来源下没有可展示的改动”。
  const empty = page.locator("[data-testid='git-review-file-list']");
  await empty.getByText("测试文件已隐藏").waitFor();
  assert.equal(await page.getByText("当前来源下没有可展示的改动").count(), 0);
  await page.screenshot({ path: join(artifacts, "03-only-test-files-empty.png"), fullPage: true });
  await empty.getByRole("button", { name: "显示测试文件" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll("[data-git-review-file-row]").length > 0,
  );
  assert.equal(await page.locator(TOGGLE).getAttribute("aria-pressed"), "false");
  assert.deepEqual(errors, []);
  await page.close();
});
