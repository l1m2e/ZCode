/**
 * usePlatform —— 通过 React Context 提供 IPlatformService
 *
 * 平台操作（native dialog、窗口生命周期等）通过此 hook 访问，
 * 替代直接调用 window.zcode。
 */
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { IPlatformService, RemoteTarget, SystemFontsResult } from "@zcode/shared";

const PlatformContext = createContext<IPlatformService | null>(null);

export function PlatformProvider({
  platform,
  children,
}: {
  platform: IPlatformService;
  children: ReactNode;
}) {
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): IPlatformService {
  const ctx = useOptionalPlatform();
  if (!ctx) {
    throw new Error("usePlatform 必须在 PlatformProvider 内使用");
  }
  return ctx;
}

export function useOptionalPlatform(): IPlatformService | null {
  const ctx = useContext(PlatformContext);
  return ctx;
}

/** 在用户打开选择器时直接请求，避免 effect 异步发起丢失浏览器用户激活。 */
export function useSystemFonts() {
  const platform = usePlatform();
  const [result, setResult] = useState<SystemFontsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);
  const pendingRef = useRef(false);
  useEffect(() => {
    // 平台换代会使旧请求失效，同时清理旧加载态，避免重连后停留在加载中。
    setResult(null);
    setLoading(false);
    return () => {
      requestRef.current += 1;
      pendingRef.current = false;
    };
  }, [platform]);
  const load = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const next = await (platform.getSystemFonts?.() ??
        Promise.resolve<SystemFontsResult>({ status: "unsupported" }));
      if (requestRef.current === request) setResult(next);
    } catch {
      if (requestRef.current === request) setResult({ status: "error" });
    } finally {
      if (requestRef.current === request) {
        pendingRef.current = false;
        setLoading(false);
      }
    }
  }, [platform]);
  return { result, loading, load };
}

/** 选择目录的便捷 hook */
export function useSelectDirectory() {
  const platform = usePlatform();
  return useCallback(() => platform.selectDirectory(), [platform]);
}

/** 连接远程的便捷 hook */
export function useConnectRemote() {
  const platform = usePlatform();
  return useCallback(
    async (options: RemoteTarget, requestId?: string) => {
      const result = await platform.connectRemote(options, requestId);
      if (!result.success) {
        throw new Error(result.error || "Connection failed");
      }
    },
    [platform],
  );
}
