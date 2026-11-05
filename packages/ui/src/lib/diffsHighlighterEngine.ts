import type { HighlighterTypes } from "@pierre/diffs";
import { preloadHighlighter } from "@pierre/diffs";
import type { WorkerInitializationRenderOptions } from "@pierre/diffs/react";
import type { BundledTheme } from "shiki";

/**
 * @pierre/diffs 默认使用 shiki 的 JavaScript 正则引擎（shiki-js）。该引擎把 TextMate
 * 语法逐条翻译成巨型 RegExp 并在引擎级缓存里永久持有，V8 会把执行过的正则编译成原生代码放进
 * code space；双字节文本（中文注释等）还会再编译一份。主窗口和 4 个 diff worker 共用同一个
 * 256MB code range，长时间运行后会被这些正则占满，触发 renderer 的 V8 OOM
 * （CALL_AND_RETRY_LAST，old-space 仍有大量空闲，code cage "ran out of reservation"）。
 * oniguruma WASM 引擎的正则活在 wasm 线性内存里，不占 V8 代码区，且是 TextMate 语法的参考实现。
 */
export const DIFFS_PREFERRED_HIGHLIGHTER: HighlighterTypes = "shiki-wasm";

// 修复：shiki 4.x 的 vue 语法对 <script lang="jsx"> 用外部 scope 引用（source.js.jsx），
// 只加载 vue 时该引用解析不到，脚本区几乎不着色。这里在主线程共享高亮器里预载 jsx，
// vue 语法渲染前必须已 attach；lang="ts" 的脚本块是内联规则，不受影响。
void preloadHighlighter({
  langs: ["jsx"],
  themes: [],
  preferredHighlighter: DIFFS_PREFERRED_HIGHLIGHTER,
}).catch(() => {
  // 预载失败不阻塞渲染，vue 文件会退化为仅模板区着色
});

export interface DiffsHighlighterThemeSettings {
  lightTheme: BundledTheme;
  darkTheme: BundledTheme;
}

/** diff worker 池初始化参数；主线程兜底渲染与 worker 必须使用同一个引擎选择。 */
export function createDiffsWorkerHighlighterOptions(
  settings: DiffsHighlighterThemeSettings,
): WorkerInitializationRenderOptions {
  return {
    theme: {
      light: settings.lightTheme,
      dark: settings.darkTheme,
    },
    // 不同 patch 的逐词差异计算会额外占用主线程；先沿用库默认阈值，
    // 后续可基于慢日志再单独收紧，避免一次改动引入“高亮信息突然消失”的回归。
    lineDiffType: "word-alt",
    maxLineDiffLength: 1_000,
    tokenizeMaxLineLength: 1_000,
    useTokenTransformer: false,
    // worker 里解析语言会抛错，语言数据必须由主线程预解析传入；带上 jsx 让
    // vue 语法的 source.js.jsx scope 引用在 worker 里也能解析
    langs: ["jsx"],
    preferredHighlighter: DIFFS_PREFERRED_HIGHLIGHTER,
  };
}
