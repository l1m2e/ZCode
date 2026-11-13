import type { SystemFontsResult } from "@zcode/shared";

export interface BrowserReadableStorageLike {
  getItem(key: string): string | null;
}

export interface BrowserStorageLike extends BrowserReadableStorageLike {
  setItem(key: string, value: string): void;
}

function getLocalStorageCandidate(): unknown {
  try {
    return typeof window !== "undefined"
      ? window.localStorage
      : typeof localStorage !== "undefined"
        ? localStorage
        : undefined;
  } catch {
    return undefined;
  }
}

function isBrowserReadableStorageLike(storage: unknown): storage is BrowserReadableStorageLike {
  return (
    Boolean(storage) &&
    typeof (storage as Partial<BrowserReadableStorageLike>).getItem === "function"
  );
}

function isBrowserStorageLike(storage: unknown): storage is BrowserStorageLike {
  return (
    isBrowserReadableStorageLike(storage) &&
    typeof (storage as Partial<BrowserStorageLike>).setItem === "function"
  );
}

export function getSafeReadableLocalStorage(): BrowserReadableStorageLike | null {
  const storage = getLocalStorageCandidate();

  if (!isBrowserReadableStorageLike(storage)) {
    return null;
  }

  return storage;
}

export function getSafeLocalStorage(): BrowserStorageLike | null {
  const storage = getLocalStorageCandidate();

  if (!isBrowserStorageLike(storage)) {
    return null;
  }

  return storage;
}

export function readSafeLocalStorage(key: string): string | null {
  try {
    return getSafeReadableLocalStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeSafeLocalStorage(key: string, value: string): void {
  try {
    getSafeLocalStorage()?.setItem(key, value);
  } catch {
    // SSR/测试环境或隐私模式下 localStorage 可能存在但不可写。
    // 写入失败不应阻断 UI 渲染，真实偏好下次仍可从 settingService 或默认值恢复。
  }
}

export function readNavigatorLanguage(): string | null {
  if (typeof navigator === "undefined" || typeof navigator.language !== "string") {
    return null;
  }

  return navigator.language;
}

/** Desktop/Web 共用当前显示设备的字体枚举；不能通过远控代理读取另一台设备的字体。 */
export async function queryBrowserSystemFonts(): Promise<SystemFontsResult> {
  if (typeof window === "undefined") return { status: "unsupported" };
  const fontWindow = window as Window & { queryLocalFonts?: () => Promise<unknown> };
  if (!fontWindow.queryLocalFonts) return { status: "unsupported" };
  try {
    const entries = await fontWindow.queryLocalFonts();
    if (!Array.isArray(entries)) return { status: "error" };
    const families = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || !("family" in entry)) continue;
      const family: unknown = entry.family;
      if (typeof family !== "string") continue;
      const trimmed = family.trim();
      if (trimmed && trimmed.length <= 256 && !/\p{Cc}/u.test(trimmed)) {
        families.add(trimmed);
      }
    }
    return { status: "available", families: [...families].sort((a, b) => a.localeCompare(b)) };
  } catch (error) {
    const denied =
      error instanceof Error &&
      (error.name === "NotAllowedError" || error.name === "SecurityError");
    return { status: denied ? "denied" : "error" };
  }
}
