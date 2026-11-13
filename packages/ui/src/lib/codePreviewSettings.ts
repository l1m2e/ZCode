/**
 * 代码预览设置的类型与默认值。
 *
 * 独立的中立模块：若定义在 zustand store（@/store/index.ts）里，
 * 纯展示组件（ai-elements / ToolCallBlocks）为了拿类型和默认值就要依赖 store。
 * store 只做 re-export，展示组件改为 props 传入 + 本模块默认值兜底。
 */
import type { BundledTheme } from "shiki";

// 兼容先前保存的预设 ID；下拉选项由系统字体枚举提供，不再由此表生成。
const LEGACY_CODE_FONT_FAMILIES: Record<string, string> = {
  "jetbrains-mono": "JetBrains Mono",
  "fira-code": "Fira Code",
  "cascadia-code": "Cascadia Code",
  menlo: "Menlo",
  monaco: "Monaco",
  consolas: "Consolas",
  "liberation-mono": "Liberation Mono",
  "courier-new": "Courier New",
};

export type CodeFontFamily = string;

export function normalizeCodeFontFamily(value: unknown): CodeFontFamily {
  if (typeof value !== "string") return "default";
  const family = value.trim();
  if (!family || family.length > 256 || /\p{Cc}/u.test(family)) return "default";
  return Object.hasOwn(LEGACY_CODE_FONT_FAMILIES, family)
    ? LEGACY_CODE_FONT_FAMILIES[family]!
    : family;
}

export function getCodeFontFamilyCss(value: CodeFontFamily): string {
  const family = normalizeCodeFontFamily(value);
  // 系统 family 可能带引号或反斜杠，必须作为一个 CSS 字符串，不能拼成多条声明。
  return family === "default" ? "var(--font-mono)" : `${JSON.stringify(family)}, var(--font-mono)`;
}

export interface CodePreviewSettings {
  fontFamily: CodeFontFamily;
  lightTheme: BundledTheme;
  darkTheme: BundledTheme;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
  fontSizePx: number;
}

export const DEFAULT_CODE_PREVIEW_SETTINGS: CodePreviewSettings = {
  fontFamily: "default",
  lightTheme: "github-light",
  darkTheme: "github-dark",
  showLineNumbers: true,
  wrapLongLines: false,
  fontSizePx: 12,
};
