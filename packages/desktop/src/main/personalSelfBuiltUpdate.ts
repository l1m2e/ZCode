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

// personal-mods 专用：CI 发布清单是唯一自动更新源；本地构建产物只服务手动构建。
// 远程：60 秒轮询 GitHub Release latest 的 personal-update.json，buildId 比已安装新
// 就点亮现成的「更新」胶囊，确认后拉起 sync-personal-mods.sh --install-remote。
// 本地：不做启动检查与周期轮询（官方同步构建归 CI schedule 负责），只有自己跑
// sync-personal-mods.sh 写完 ~/.zcode/v2/personal-mods-update.json 时由 watch 立即
// 点亮，确认后走 --install-only（等待 app 退出 → ditto 替换 → 重启）。

const MANIFEST_PATH = join(app.getPath("home"), ".zcode", "v2", "personal-mods-update.json");
// 每次构建追加一条（sync-personal-mods.sh 的 write_build_metadata），记录该次构建的
// 官方基线与个人补丁栈主题；更新弹窗据此计算「官方更新 / 个人修改」两个区间
const BUILDS_HISTORY_PATH = join(app.getPath("home"), ".zcode", "v2", "personal-mods-builds.jsonl");
// CI 发布清单固定地址（GitHub Release latest 直链）。
// 留空 = 远程更新通道关闭，只剩本地手动构建的 watch 点亮
const PERSONAL_UPDATE_MANIFEST_URL =
  "https://github.com/l1m2e/ZCode/releases/latest/download/personal-update.json";
const REMOTE_CHECK_INTERVAL_MS = 60 * 1000;
const INSTALLER_WAIT_MS = 300 * 1000;

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

/** CI 发布清单（publish-personal-release.sh 生成，挂在 Release 资产上）。 */
interface RemoteUpdateManifest extends PersonalBuildHistoryEntry {
  version?: string;
  zipUrl?: string;
  sha256?: string;
  size?: number;
  builtAt?: string;
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
      repoPath: typeof parsed.repoPath === "string" && parsed.repoPath.trim() ? parsed.repoPath.trim() : undefined,
      buildId: typeof parsed.buildId === "string" && parsed.buildId.trim() ? parsed.buildId.trim() : undefined,
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

/**
 * 构建 ID 排序键：p<N> 序号补零 + 尾部 UTC 时间戳。本地脚本离线兜底按历史行数计数、
 * CI 按 tag 数计数，两个计数器可能撞出相同序号（如都为 p2），序号相同时以时间戳决胜。
 * 无序号的旧格式 ID 返回 null，不参与比较。
 */
function buildSortKey(buildId: string | null): string | null {
  const [, num, ts] = /-p(\d+)-(\d{14})$/.exec(buildId ?? "") ?? [];
  return num && ts ? `${num.padStart(6, "0")}-${ts}` : null;
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

let publishing = false;
/** 待安装的远程构建；点亮后由「更新」按钮消费，本地构建源为 null。 */
let pendingRemoteInstall: RemoteUpdateManifest | null = null;

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
    pendingRemoteInstall = null;
    const notes = await buildSelfBuiltNotes(options.settingService, manifest, appBuildId);
    publishSelfBuiltUpdateReady(manifest.version, notes);
  } catch (error) {
    logger.warn("[self-built-update] check failed:", error);
  } finally {
    publishing = false;
  }
}

/**
 * 远程更新通道：轮询 CI 发布清单，buildId 比已安装新就点亮。远程构建记录并入
 * 本地历史文件，分区日志的差集计算与本地构建共用同一份存储。
 */
async function checkRemoteUpdate(options: InitSelfBuiltUpdateOptions): Promise<void> {
  if (!PERSONAL_UPDATE_MANIFEST_URL || publishing) return;
  publishing = true;
  try {
    const response = await fetch(PERSONAL_UPDATE_MANIFEST_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return;
    const remote = JSON.parse(await response.text()) as Partial<RemoteUpdateManifest>;
    if (
      typeof remote.buildId !== "string" ||
      !remote.buildId.trim() ||
      typeof remote.zipUrl !== "string" ||
      !remote.zipUrl.trim() ||
      typeof remote.sha256 !== "string" ||
      !remote.sha256.trim()
    ) {
      return;
    }
    const installedId = await readBuildId(installedAppPath());
    if (remote.buildId === installedId) return;
    // 防回退：两边都有序号时，远程排序键（p<N> 补零 + 时间戳）必须严格大于已安装
    // 才点亮。不能只比序号——本地与 CI 双计数器撞号时（同为 p2），真正更新的远程
    // 构建会被误判为回退而永远不亮（2026-11-05 实测触发）
    const remoteKey = buildSortKey(remote.buildId);
    const installedKey = buildSortKey(installedId);
    if (remoteKey !== null && installedKey !== null && remoteKey <= installedKey) {
      return;
    }
    // 60 秒轮询下同一 buildId 只追加一次，避免待装期间历史文件被重复行灌满
    if (!(await readBuildHistoryEntry(remote.buildId))) {
      await fs.appendFile(
        BUILDS_HISTORY_PATH,
        `${JSON.stringify({
          buildId: remote.buildId,
          officialBase: remote.officialBase,
          personal: remote.personal,
        })}\n`,
      );
    }
    pendingRemoteInstall = remote as RemoteUpdateManifest;
    const localManifest = await readManifest();
    const notes = await buildSelfBuiltNotes(options.settingService, {
      version: typeof remote.version === "string" && remote.version.trim() ? remote.version.trim() : app.getVersion(),
      distPath: localManifest?.distPath ?? "",
      scriptPath: localManifest?.scriptPath ?? "",
      repoPath: localManifest?.repoPath,
      buildId: remote.buildId,
    }, installedId);
    publishSelfBuiltUpdateReady(notes.version, notes);
  } catch (error) {
    logger.warn("[self-built-update] remote check failed:", error);
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
    if (pendingRemoteInstall) {
      const remote = pendingRemoteInstall;
      const localManifest = await readManifest();
      if (!localManifest?.scriptPath) {
        const message = "远程安装失败：未找到 sync-personal-mods.sh（本机需保留检出仓库）";
        logger.warn(`[self-built-update] install aborted: ${message}`);
        if (rejectUnavailable) throw new Error(message);
        return;
      }
      logger.info(`[self-built-update] install remote version=${remote.version ?? "?"}`);
      const child = spawn(
        "/bin/bash",
        [localManifest.scriptPath, "--install-remote", remote.zipUrl ?? "", remote.sha256 ?? ""],
        { detached: true, stdio: "ignore", env: { ...process.env, PERSONAL_INSTALL_WAIT_MS: String(INSTALLER_WAIT_MS) } },
      );
      child.unref();
      await options.prepareQuit();
      app.exit(0);
      return;
    }
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

  if (PERSONAL_UPDATE_MANIFEST_URL) {
    // 远程发布清单很小，60 秒一次的轮询成本可忽略；CI 构建通常 6~10 分钟，
    // 该节奏足以在发包后一分钟内点亮
    void checkRemoteUpdate(options);
    const remoteTimer = setInterval(() => {
      void checkRemoteUpdate(options);
    }, REMOTE_CHECK_INTERVAL_MS);
    remoteTimer.unref?.();
  }

  // 本地构建源的唯一触发路径：自己跑完构建（构建 ID 先于 manifest 落盘）即点亮，
  // 无启动检查、无周期轮询，官方同步构建归 CI schedule 负责。监听 manifest 所在
  // 目录（而非文件本身，避免被删除重建后监听失效），防抖后只做本地比对。
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
