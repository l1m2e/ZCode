/* oxlint-disable eslint(max-lines) -- 自编译更新源：文件读取、状态发布与安装器编排共享同一份 manifest 事实，拆开会增加跨模块同步漂移 */
import { execFile, spawn } from "node:child_process";
import { promises as fs, watch } from "node:fs";
import { join } from "node:path";
import { app, ipcMain } from "electron";
import type { PostUpdateReleaseNotesPayload } from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import type { SettingServiceLike } from "./autoUpdater.js";
import {
  clearSelfBuiltUpdateReadyState,
  isAutoUpdaterDisabledForProductFlavor,
  publishSelfBuiltUpdateReady,
} from "./autoUpdater.js";
import { logger } from "./logger.js";

// personal-mods 专用：把 sync-personal-mods.sh 的构建产物当作更新源。
// 流水线每次构建后写 ~/.zcode/v2/personal-mods-update.json（version/distPath/scriptPath），
// 这里发现 dist 比已安装 app 新时，点亮现成的「更新」胶囊；点击确认后
// 拉起脚本 --install-only（等待 app 退出 → ditto 替换 → 重启），与官方更新体验一致。

const MANIFEST_PATH = join(app.getPath("home"), ".zcode", "v2", "personal-mods-update.json");
// 与官方 autoUpdater 的 AUTO_UPDATE_POLL_INTERVAL_MS 同口径：15 分钟检查一次
const OFFICIAL_SYNC_POLL_INTERVAL_MS = 15 * 60 * 1000;
const INSTALLER_WAIT_MS = 300 * 1000;

interface PersonalUpdateManifest {
  version: string;
  distPath: string;
  scriptPath: string;
  repoPath?: string;
}

interface InitSelfBuiltUpdateOptions {
  settingService: SettingServiceLike;
  /** 安装前的主进程退出准备（停 Host/Agent、释放文件锁），与 autoUpdater 的 onBeforeQuitAndInstall 同一语义。 */
  prepareQuit: () => Promise<void>;
}

/** ditto 会保留 mtime，判断「是否已装这个构建」比较脚本写入的构建 ID 而非时间。 */
async function readBuildId(appDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(join(appDir, ".personal-build-id"), "utf8");
    const id = raw.trim();
    return id === "" ? null : id;
  } catch {
    return null;
  }
}

async function readManifest(): Promise<PersonalUpdateManifest | null> {
  try {
    const raw = await fs.readFile(MANIFEST_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersonalUpdateManifest>;
    if (
      typeof parsed.version !== "string" ||
      typeof parsed.distPath !== "string" ||
      typeof parsed.scriptPath !== "string" ||
      !parsed.version.trim() ||
      !parsed.distPath.trim() ||
      !parsed.scriptPath.trim()
    ) {
      return null;
    }
    return {
      version: parsed.version.trim(),
      distPath: parsed.distPath.trim(),
      scriptPath: parsed.scriptPath.trim(),
    };
  } catch {
    return null;
  }
}

/** 已安装 app 的包目录（…/Contents/MacOS/<name> → …/<App>.app）。 */
function installedAppPath(): string {
  return join(app.getPath("exe"), "..", "..", "..");
}

async function readOfficialPendingNotes(
  settingService: SettingServiceLike,
  version: string,
): Promise<PostUpdateReleaseNotesPayload | null> {
  try {
    const settings = await settingService.get();
    const pending = settings.pendingPostUpdateReleaseNotes ?? null;
    // 官方待装说明与构建产物同版本时直接复用（真实更新日志）；否则给自编译说明
    return pending && pending.version === version
      ? {
          ...pending,
          title: `${pending.title}（自编译）`,
          markdown: `> 本包为自编译版本（personal-mods 分支），已包含官方更新与个人修改。\n\n${pending.markdown}`,
        }
      : null;
  } catch (error) {
    logger.warn("[self-built-update] read pending release notes failed:", error);
    return null;
  }
}

function fallbackNotes(version: string): PostUpdateReleaseNotesPayload {
  return {
    version,
    title: `v${version} 自编译更新`,
    markdown: [
      "> 本包为自编译版本（personal-mods 分支）：同步官方最新代码并保留个人修改。",
      "",
      "点击「立即重启更新」将退出应用、替换 /Applications 中的自编译 Preview 并自动重启。",
    ].join("\n"),
  };
}

/** 构建 ID 形如 3.17.2-20261105033248，尾部是 UTC 时间戳；还原成 git 可解析的 ISO 时刻。 */
function installedBuildIdToSince(buildId: string): string | null {
  const raw = buildId.slice(buildId.lastIndexOf("-") + 1);
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
}

/**
 * 更新弹窗展示本次构建真实包含的个人提交：以上一版构建 ID 的时间戳为起点
 * git log 检出仓库（流水线与手动构建都在 personal-mods 工作区进行）。rebase
 * 会改写提交时间为 rebase 时刻，官方同步后老提交可能重复出现一次，可接受。
 */
async function readPersonalCommits(
  repoPath: string | undefined,
  installedBuildId: string | null,
): Promise<{ hash: string; subject: string }[] | null> {
  if (!repoPath || !installedBuildId) return null;
  const since = installedBuildIdToSince(installedBuildId);
  if (!since) return null;
  const out = await execFileText(
    "git",
    ["log", "--no-merges", `--since=${since}`, "--pretty=format:%h%x1f%s", "-n", "30"],
    repoPath,
  );
  if (out === null || out === "") return null;
  const commits = out
    .split("\n")
    .map((line) => {
      const separator = line.indexOf("\x1f");
      return separator === -1
        ? null
        : { hash: line.slice(0, separator), subject: line.slice(separator + 1) };
    })
    .filter((commit): commit is { hash: string; subject: string } => commit !== null);
  return commits.length > 0 ? commits : null;
}

async function buildSelfBuiltNotes(
  settingService: SettingServiceLike,
  manifest: PersonalUpdateManifest,
  installedBuildId: string | null,
): Promise<PostUpdateReleaseNotesPayload> {
  const [officialNotes, commits] = await Promise.all([
    readOfficialPendingNotes(settingService, manifest.version),
    readPersonalCommits(manifest.repoPath, installedBuildId),
  ]);
  if (!officialNotes && !commits) {
    return fallbackNotes(manifest.version);
  }
  const sections: string[] = [];
  if (officialNotes) {
    sections.push(officialNotes.markdown);
  }
  if (commits) {
    sections.push(
      `**本次个人修改（${commits.length} 条）：**\n\n${commits
        .map((commit) => `- \`${commit.hash}\` ${commit.subject}`)
        .join("\n")}`,
    );
  }
  return {
    version: manifest.version,
    title: officialNotes?.title ?? `v${manifest.version} 自编译更新`,
    markdown: sections.join("\n\n"),
  };
}

let publishing = false;

async function checkAndPublish(options: InitSelfBuiltUpdateOptions): Promise<void> {
  if (publishing) return;
  publishing = true;
  try {
    const manifest = await readManifest();
    if (!manifest) {
      clearSelfBuiltUpdateReadyState();
      return;
    }
    const [distBuildId, appBuildId] = await Promise.all([
      readBuildId(manifest.distPath),
      readBuildId(installedAppPath()),
    ]);
    // 与 sync-personal-mods.sh 同口径：dist 没有构建 ID（旧产物）或与已安装一致 → 无待装更新
    if (distBuildId === null || distBuildId === appBuildId) {
      clearSelfBuiltUpdateReadyState();
      return;
    }
    const notes = await buildSelfBuiltNotes(options.settingService, manifest, appBuildId);
    publishSelfBuiltUpdateReady(manifest.version, notes);
  } catch (error) {
    logger.warn("[self-built-update] check failed:", error);
  } finally {
    publishing = false;
  }
}

function spawnInstaller(manifest: PersonalUpdateManifest): void {
  // detached：app.exit 后安装器继续完成替换并重启
  const child = spawn("/bin/bash", [manifest.scriptPath, "--install-only"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PERSONAL_INSTALL_WAIT_MS: String(INSTALLER_WAIT_MS) },
  });
  child.unref();
}

function execFileText(
  file: string,
  args: readonly string[],
  cwd?: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { ...(cwd ? { cwd } : {}), timeout: 30_000 }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim());
    });
  });
}

let officialSyncInFlight = false;

/**
 * 对齐官方更新检查语义：由运行中的 app 每 15 分钟检查一次官方 GitHub main，
 * 有新提交才触发同步构建流水线（rebase 个人修改 → 构建 → 点亮更新按钮），
 * 没有新提交不触发任何构建/合并。官方没有更新时这一步只是廉价的 ref 查询。
 */
async function checkOfficialAndSync(manifest: PersonalUpdateManifest): Promise<void> {
  if (!manifest.repoPath) return;
  if (officialSyncInFlight) return;
  const busy = await execFileText("pgrep", ["-f", "sync-personal-mods\\.sh"]);
  if (busy) {
    logger.info("[self-built-update] sync script already running, skip official check");
    return;
  }
  officialSyncInFlight = true;
  try {
    const [remote, local] = await Promise.all([
      execFileText("git", ["-c", "http.version=HTTP/1.1", "ls-remote", "origin", "refs/heads/main"], manifest.repoPath),
      execFileText("git", ["rev-parse", "main"], manifest.repoPath),
    ]);
    if (remote === null || local === null) {
      logger.warn("[self-built-update] official check failed (network or git), skip");
      return;
    }
    const remoteHash = remote.split("\t")[0] ?? "";
    if (remoteHash === "" || remoteHash === local) {
      logger.info("[self-built-update] official up to date, no build triggered");
      return;
    }
    logger.info(
      `[self-built-update] official main moved (${local.slice(0, 7)} -> ${remoteHash.slice(0, 7)}), trigger sync build`,
    );
    const child = spawn("/bin/bash", [manifest.scriptPath], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } finally {
    officialSyncInFlight = false;
  }
}

export function initSelfBuiltUpdateSupport(options: InitSelfBuiltUpdateOptions): void {
  if (!isAutoUpdaterDisabledForProductFlavor()) {
    // 真更新器在位的构建（production flavor）不启用自编译更新源，避免双写更新状态
    logger.info("[self-built-update] skip: product updater is active");
    return;
  }

  app.setAboutPanelOptions({
    applicationVersion: `${app.getVersion()}（自编译）`,
    credits: "自编译版本：personal-mods 分支构建，含个人修改。",
  });

  // electron-updater 禁用时这些 IPC handler 不会注册，这里按同一通道接自编译安装流程
  const install = async (rejectUnavailable: boolean): Promise<void> => {
    const manifest = await readManifest();
    // 退出前先验证构建产物在位，避免 app 退出后安装器才发现无事可装
    const distReady = manifest
      ? await fs
          .stat(join(manifest.distPath, ".personal-build-id"))
          .then(() => true)
          .catch(() => false)
      : false;
    if (!manifest || !distReady) {
      const message = manifest
        ? `构建产物缺失：${manifest.distPath}（先运行 sync-personal-mods.sh 重新构建）`
        : "没有可安装的自编译更新包（未找到构建产物清单）";
      logger.warn(`[self-built-update] install aborted: ${message}`);
      if (rejectUnavailable) throw new Error(message);
      return;
    }
    logger.info(`[self-built-update] user requested install version=${manifest.version}`);
    spawnInstaller(manifest);
    await options.prepareQuit();
    app.exit(0);
  };
  ipcMain.handle(PlatformChannels.QuitAndInstallUpdate, () => install(true));
  ipcMain.on(PlatformChannels.QuitAndInstallUpdate, () => {
    void install(false);
  });

  void checkAndPublish(options);
  const check = async (): Promise<void> => {
    const manifest = await readManifest();
    if (!manifest) return;
    await checkOfficialAndSync(manifest);
    await checkAndPublish(options);
  };
  void check();
  const timer = setInterval(() => {
    void check();
  }, OFFICIAL_SYNC_POLL_INTERVAL_MS);
  timer.unref?.();

  // 本地构建完成即点亮：无论流水线还是手动构建，构建 ID 都先于 manifest 落盘，
  // 监听 manifest 所在目录（而非文件本身，避免被删除重建后监听失效），
  // 防抖后只做本地比对（checkAndPublish），不触发官方检查。15 分钟轮询仍保留，
  // 继续负责官方新提交的发现与流水线拉起。
  let manifestWatchDebounce: NodeJS.Timeout | undefined;
  try {
    watch(join(MANIFEST_PATH, ".."), (_event, filename) => {
      if (filename !== "personal-mods-update.json") return;
      clearTimeout(manifestWatchDebounce);
      manifestWatchDebounce = setTimeout(() => {
        void checkAndPublish(options);
      }, 2_000);
      manifestWatchDebounce.unref?.();
    });
  } catch (error) {
    logger.warn("[self-built-update] manifest watch unavailable, poll remains:", error);
  }
  logger.info("[self-built-update] initialized", { manifestPath: MANIFEST_PATH });
}
