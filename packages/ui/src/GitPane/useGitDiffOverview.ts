import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileDiffOptions } from "@pierre/diffs";
import { measureGitDiffOverview, type GitDiffOverviewGeometry } from "./diffOverviewGeometry.js";

const EMPTY_GEOMETRY: GitDiffOverviewGeometry = {
  markers: [],
  contentHeight: 0,
  viewportHeight: 0,
  scrollTop: 0,
};

export function useGitDiffOverview({
  enabled,
  contentVersion,
  plainTextLines,
}: {
  enabled: boolean;
  contentVersion: object;
  plainTextLines?: readonly string[];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLElement | null>(null);
  const scheduleMeasureRef = useRef<(() => void) | null>(null);
  const [snapshot, setSnapshot] = useState({ version: contentVersion, geometry: EMPTY_GEOMETRY });
  const geometry =
    enabled && snapshot.version === contentVersion ? snapshot.geometry : EMPTY_GEOMETRY;
  const onPostRender = useCallback((host: HTMLElement) => {
    hostRef.current = host;
    scheduleMeasureRef.current?.();
  }, []);
  const diffOptions = useMemo<FileDiffOptions<undefined>>(() => ({ onPostRender }), [onPostRender]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!enabled || !scroll || !content) return;
    let frame: number | null = null;
    let needsMeasure = true;
    let measured = EMPTY_GEOMETRY;
    let observedPre: Element | null = null;
    const flush = () => {
      frame = null;
      if (needsMeasure) {
        needsMeasure = false;
        // 文件切换时旧 host 的异步高亮可能晚到，不能把脱离当前内容的行映射回来。
        const host = hostRef.current;
        const currentHost = host && content.contains(host) ? host : null;
        const pre = currentHost?.shadowRoot?.querySelector("pre") ?? null;
        if (pre !== observedPre) {
          if (observedPre) resizeObserver.unobserve(observedPre);
          if (pre) resizeObserver.observe(pre);
          observedPre = pre;
        }
        measured = measureGitDiffOverview(scroll, content, currentHost, plainTextLines);
      } else {
        measured = { ...measured, scrollTop: scroll.scrollTop };
      }
      setSnapshot({ version: contentVersion, geometry: measured });
    };
    const schedule = (measure: boolean) => {
      needsMeasure ||= measure;
      if (frame === null) frame = requestAnimationFrame(flush);
    };
    const scheduleMeasure = () => schedule(true);
    const onScroll = () => schedule(false);
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(scroll);
    resizeObserver.observe(content);
    scheduleMeasureRef.current = scheduleMeasure;
    scroll.addEventListener("scroll", onScroll, { passive: true });
    scheduleMeasure();
    return () => {
      scheduleMeasureRef.current = null;
      if (frame !== null) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      scroll.removeEventListener("scroll", onScroll);
    };
  }, [contentVersion, enabled, plainTextLines]);

  const scrollTo = useCallback((top: number) => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.scrollTo({
      top: Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, top)),
      behavior: "instant",
    });
  }, []);

  return { scrollRef, contentRef, diffOptions, geometry, scrollTo };
}
