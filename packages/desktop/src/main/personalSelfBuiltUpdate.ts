/* oxlint-disable eslint(max-lines) -- 自编译更新源：文件读取、状态发布与安装器编排共享同一份 manifest 事实，拆开会增加跨模块同步漂移 */
import { execFile, spawn } from "node:child_process";
import { promises as fs, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

// personal-mods 只消费本地已打包产物：启动检查 + 构建完成 watch，复用现有更新 UI。
// 点击复验后走 --install-only，等待退出、替换本地包并重启；CI 仅供手动下载。

const MANIFEST_PATH = join(app.getPath("home"), ".zcode", "v2", "personal-mods-update.json");
// 每次构建追加一条（sync-personal-mods.sh 的 write_build_metadata），记录该次构建的
// 官方基线与个人补丁栈主题；更新弹窗据此计算「官方更新 / 个人修改」两个区间
const BUILDS_HISTORY_PATH = join(app.getPath("home"), ".zcode", "v2", "personal-mods-builds.jsonl");
const INSTALLER_WAIT_MS = 300 * 1000;
// 检查管线单相位上限。2026-11-16 实测：四个不同时间启动的新实例全部无发布且无任何
// 日志，唯一无界 await 是更新说明组装内的设置读取——任一相位卡死都会让 publishing
// 标志永久占用，后续 watch 检查全部静默跳过。相位超时后按兜底值继续发布，并以
// 相位日志（ready/published）作为「构建完成但不点亮」的第一诊断入口。
const CHECK_PHASE_TIMEOUT_MS = 8_000;

/** 给检查相位加界：超时写 warn 并取兜底值，原 promise 结果（含迟到的 rejection）安全丢弃。 */
async function withPhaseTimeout<T>(
  label: string,
  promise: Promise<T>,
  fallback: () => T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          logger.warn(`[self-built-update] phase ${label} timeout, continue with fallback`);
          resolve(fallback());
        }, CHECK_PHASE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface PersonalUpdateManifest {
  version: string;
  distPath: string;
  scriptPath: string;
  repoPath?: string;
  buildId?: string;
}

/** personal-mods-builds.jsonl 的单行记录。 */
interface PersonalBuildHistoryEntry {
  buildId: string;
  officialBase?: string;
  /** 该次构建包含的个人补丁栈主题（main..HEAD），跨 rebase 稳定，用于集合差 */
  personal?: string[];
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
      repoPath:
        typeof parsed.repoPath === "string" && parsed.repoPath.trim()
          ? parsed.repoPath.trim()
          : undefined,
      buildId:
        typeof parsed.buildId === "string" && parsed.buildId.trim()
          ? parsed.buildId.trim()
          : undefined,
    };
  } catch {
    return null;
  }
}

async function readBuildHistoryEntry(buildId: string): Promise<PersonalBuildHistoryEntry | null> {
  try {
    const raw = await fs.readFile(BUILDS_HISTORY_PATH, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.includes(`"buildId":"${buildId}"`)) continue;
      const parsed = JSON.parse(line) as Partial<PersonalBuildHistoryEntry>;
      if (typeof parsed.buildId === "string" && parsed.buildId === buildId) {
        return {
          buildId: parsed.buildId,
          officialBase: typeof parsed.officialBase === "string" ? parsed.officialBase : undefined,
          personal: Array.isArray(parsed.personal)
            ? parsed.personal.filter((subject): subject is string => typeof subject === "string")
            : undefined,
        };
      }
    }
    return null;
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

/** 构建 ID 形如 3.17.2-p7-20261105033248，尾部是 UTC 时间戳；还原成 git 可解析的 ISO 时刻。 */
function installedBuildIdToSince(buildId: string): string | null {
  const raw = buildId.slice(buildId.lastIndexOf("-") + 1);
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
}

/** 从构建 ID 提取个人构建序号（p<N>），旧格式 ID 无序号返回 null。 */
function buildNumberLabel(buildId: string | null | undefined): string | null {
  if (!buildId) return null;
  const match = /-p(\d+)-/.exec(buildId);
  return match ? `p${match[1]}` : null;
}

/** 本地离线序号与 CI tag 计数不可比较；按 UTC 时间判断，兼容旧版无 p 序号 ID。 */
function buildTimestamp(buildId: string): string | null {
  return /-(\d{14})$/.exec(buildId)?.[1] ?? null;
}

/**
 * 旧格式构建 ID（无历史记录）的兜底：以已装构建的时间戳为起点 git log 检出仓库。
 * rebase 会改写提交时间为 rebase 时刻，官方同步后老提交可能重复出现一次，可接受。
 */
async function readPersonalCommitsSince(
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

/**
 * 更新弹窗按真实区间组装：官方基线不同 → 列官方提交；个人补丁栈主题集合差 → 列个人新提交。
 * 只有官方就只显示官方，只有个人就只显示个人，两者都有就合并（官方在前）。
 * 历史记录缺失（旧格式构建升级到本版）时退回时间戳 git log / 官方待装日志。
 */
async function buildSelfBuiltNotes(
  settingService: SettingServiceLike,
  manifest: PersonalUpdateManifest,
  installedBuildId: string | null,
): Promise<PostUpdateReleaseNotesPayload> {
  const current = manifest.buildId ? await readBuildHistoryEntry(manifest.buildId) : null;
  const installed = installedBuildId ? await readBuildHistoryEntry(installedBuildId) : null;

  const sections: string[] = [];
  let officialNotes: PostUpdateReleaseNotesPayload | null = null;

  if (current?.officialBase && installed?.officialBase) {
    if (current.officialBase !== installed.officialBase) {
      const out = await execFileText(
        "git",
        [
          "log",
          "--no-merges",
          `${installed.officialBase}..${current.officialBase}`,
          "--pretty=format:%h%x1f%s",
          "-n",
          "30",
        ],
        manifest.repoPath,
      );
      const lines = out
        ? out
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => {
              const separator = line.indexOf("\x1f");
              return separator === -1
                ? `- ${line}`
                : `- \`${line.slice(0, separator)}\` ${line.slice(separator + 1)}`;
            })
        : [];
      if (lines.length > 0) {
        sections.push(`**官方更新（${lines.length} 条）：**\n\n${lines.join("\n")}`);
      } else {
        sections.push(
          `官方代码更新：\`${installed.officialBase.slice(0, 7)}\` → \`${current.officialBase.slice(0, 7)}\``,
        );
      }
    }
  } else {
    // 缺历史记录：可能是官方同步升级（旧格式 ID），复用官方待装日志
    officialNotes = await readOfficialPendingNotes(settingService, manifest.version);
    if (officialNotes) {
      sections.push(officialNotes.markdown);
    }
  }

  const installedSubjects = new Set(installed?.personal ?? []);
  const newPersonalSubjects = current?.personal?.filter(
    (subject) => !installedSubjects.has(subject),
  );
  if (newPersonalSubjects && newPersonalSubjects.length > 0) {
    sections.push(
      `**个人修改（${newPersonalSubjects.length} 条）：**\n\n${newPersonalSubjects
        .map((subject) => `- ${subject}`)
        .join("\n")}`,
    );
  } else if (!current && installedBuildId) {
    const commits = await readPersonalCommitsSince(manifest.repoPath, installedBuildId);
    if (commits) {
      sections.push(
        `**个人修改（${commits.length} 条）：**\n\n${commits
          .map((commit) => `- \`${commit.hash}\` ${commit.subject}`)
          .join("\n")}`,
      );
    }
  }

  if (sections.length === 0) {
    return fallbackNotes(manifest.version);
  }
  const buildNumber = buildNumberLabel(manifest.buildId);
  return {
    version: manifest.version,
    title: officialNotes?.title ?? `v${manifest.version}${buildNumber ? `-${buildNumber}` : ""}`,
    markdown: sections.join("\n\n"),
  };
}

/** 启动、watch 和点击共用事实读取，避免 UI 点亮后使用过期或半成品包。 */
async function readReadyBuild(): Promise<{
  manifest: PersonalUpdateManifest & { buildId: string };
  appBuildId: string | null;
} | null> {
  const manifest = await readManifest();
  if (!manifest?.buildId) return null;
  const expectedDist = resolve(
    dirname(manifest.scriptPath),
    "../packages/desktop/dist/mac-arm64/ZCode Preview.app",
  );
  if (resolve(manifest.distPath) !== expectedDist) return null;
  const [distBuildId, appBuildId] = await Promise.all([
    readBuildId(manifest.distPath),
    readBuildId(installedAppPath()),
  ]);
  if (distBuildId !== manifest.buildId || distBuildId === appBuildId) return null;
  const candidateTime = buildTimestamp(distBuildId);
  const installedTime = appBuildId ? buildTimestamp(appBuildId) : null;
  // 旧逻辑只判断不同，会把陈旧本地产物覆盖到新安装包；无法比较时保守拒绝。
  if (!candidateTime || (appBuildId && (!installedTime || candidateTime <= installedTime)))
    return null;
  const files = [
    manifest.scriptPath,
    join(manifest.distPath, "Contents/Info.plist"),
    join(manifest.distPath, "Contents/MacOS/ZCode Preview"),
    join(manifest.distPath, "Contents/Resources/app.asar"),
  ];
  if (
    !(
      await Promise.all(
        files.map((file) =>
          fs
            .stat(file)
            .then((stat) => stat.isFile())
            .catch(() => false),
        ),
      )
    ).every(Boolean)
  )
    return null;
  return { manifest: { ...manifest, buildId: distBuildId }, appBuildId };
}

let publishing = false;
let checkRequested = false;
let installing = false;

async function checkAndPublish(options: InitSelfBuiltUpdateOptions): Promise<void> {
  checkRequested = true;
  if (publishing || installing) return;
  publishing = true;
  try {
    do {
      checkRequested = false;
      const ready = await withPhaseTimeout("readReadyBuild", readReadyBuild(), () => null);
      logger.info(
        `[self-built-update] check ready=${ready ? ready.manifest.buildId : "none"}`,
      );
      const notes = ready
        ? await withPhaseTimeout(
            "buildSelfBuiltNotes",
            buildSelfBuiltNotes(options.settingService, ready.manifest, ready.appBuildId),
            () => fallbackNotes(ready.manifest.version),
          )
        : null;
      // watch 在异步读日志期间到达时，重新读取事实，不发布旧候选。
      if (checkRequested || installing) continue;
      if (ready) {
        publishSelfBuiltUpdateReady(ready.manifest.version, notes);
        logger.info(`[self-built-update] published version=${ready.manifest.version}`);
      } else {
        clearSelfBuiltUpdateReadyState();
      }
    } while (checkRequested && !installing);
  } catch (error) {
    clearSelfBuiltUpdateReadyState();
    logger.warn("[self-built-update] check failed:", error);
  } finally {
    publishing = false;
  }
}

function spawnInstaller(manifest: PersonalUpdateManifest & { buildId: string }): Promise<void> {
  // detached：app.exit 后安装器继续完成替换并重启。
  // APP_PID 让脚本用 kill -0 精确等待主进程退出，替代会误匹配 zcode-cli 等
  // 存活子进程（进程标题内嵌含 app 路径的 PATH）的 pgrep -f
  const child = spawn("/bin/bash", [manifest.scriptPath, "--install-only", manifest.buildId], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PERSONAL_INSTALL_WAIT_MS: String(INSTALLER_WAIT_MS),
      APP_PID: String(process.pid),
    },
  });
  return new Promise((resolveSpawn, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveSpawn();
    });
  });
}

function execFileText(file: string, args: readonly string[], cwd?: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { ...(cwd ? { cwd } : {}), timeout: 30_000 }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim());
    });
  });
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
  // 构建 ID 带 p<N> 序号时（新格式），关于面板补显个人构建号
  void readBuildId(installedAppPath()).then((installedId) => {
    const buildNumber = buildNumberLabel(installedId);
    if (!buildNumber) return;
    app.setAboutPanelOptions({
      applicationVersion: `${app.getVersion()}（自编译 ${buildNumber}）`,
      credits: "自编译版本：personal-mods 分支构建，含个人修改。",
    });
  });

  // electron-updater 禁用时这些 IPC handler 不会注册，这里按同一通道接自编译安装流程
  const install = async (rejectUnavailable: boolean): Promise<void> => {
    if (installing) return;
    installing = true;
    try {
      const ready = await readReadyBuild();
      if (!ready) {
        clearSelfBuiltUpdateReadyState();
        throw new Error("没有可安装的新本地自编译构建（产物缺失、已安装、较旧或清单不匹配）");
      }
      logger.info(`[self-built-update] user requested install version=${ready.manifest.version}`);
      await spawnInstaller(ready.manifest);
      await options.prepareQuit();
      app.exit(0);
    } catch (error) {
      installing = false;
      logger.warn("[self-built-update] install aborted:", error);
      if (rejectUnavailable) throw error;
    }
  };
  ipcMain.handle(PlatformChannels.QuitAndInstallUpdate, () => install(true));
  ipcMain.on(PlatformChannels.QuitAndInstallUpdate, () => {
    void install(false);
  });

  // 监听目录以兼容原子替换。先建立 watch 再启动检查，避免启动窗口漏掉完成通知。
  void (async () => {
    try {
      await fs.mkdir(dirname(MANIFEST_PATH), { recursive: true });
      const watcher = watch(dirname(MANIFEST_PATH), (_event, filename) => {
        if (filename !== null && filename !== "personal-mods-update.json") return;
        void checkAndPublish(options);
      });
      watcher.on("error", (error) =>
        logger.warn("[self-built-update] manifest watch failed:", error),
      );
      app.once("will-quit", () => watcher.close());
    } catch (error) {
      logger.warn("[self-built-update] manifest watch unavailable:", error);
    }
    await checkAndPublish(options);
  })();
  logger.info("[self-built-update] initialized", { manifestPath: MANIFEST_PATH });
}
