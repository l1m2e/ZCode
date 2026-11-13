"use client";

import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { memo, useMemo } from "react";
import type { BundledTheme } from "shiki";
import type {
  DiffLineAnnotation,
  FileContents,
  FileDiffOptions,
  SelectedLineRange,
} from "@pierre/diffs";
import { MultiFileDiff, PatchDiff } from "@pierre/diffs/react";

import { cn } from "@/components/lib/utils.js";
import { DIFFS_PREFERRED_HIGHLIGHTER } from "@/lib/diffsHighlighterEngine.js";

type DiffViewerStyle = CSSProperties & {
  "--diffs-bg"?: string;
  "--diffs-light-bg"?: string;
  "--diffs-dark-bg"?: string;
  "--diffs-font-family"?: string;
  "--diffs-font-size"?: string;
};

const DIFF_VIEWER_UNSAFE_CSS = ``;

// wrap 模式的 code 是 display:contents，实际行号/正文固定在四列网格；仅改 order 无效。
// 同时移动 gutter 和 content，保证新版在左且行号、选区和注解仍属于原版本。
const DIFF_SPLIT_REVERSE_UNSAFE_CSS = [
  "[data-overflow=scroll] code[data-additions]{order:-1}",
  "[data-overflow=scroll] code[data-deletions]{order:1}",
  "[data-overflow=wrap] [data-additions] [data-gutter]{grid-column:1;border-left:0}",
  "[data-overflow=wrap] [data-additions] [data-content]{grid-column:2;border-right:1px solid var(--diffs-bg)}",
  "[data-overflow=wrap] [data-deletions] [data-gutter]{grid-column:3;border-left:1px solid var(--diffs-bg)}",
  "[data-overflow=wrap] [data-deletions] [data-content]{grid-column:4;border-right:0}",
].join("");

export type DiffViewerDiffStyle = "unified" | "split";

type DiffViewerPatchInput = {
  patch: string;
  oldFile?: never;
  newFile?: never;
};

type DiffViewerMultiFileInput = {
  patch?: never;
  oldFile: FileContents;
  newFile: FileContents;
};

export type DiffViewerProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> &
  (DiffViewerPatchInput | DiffViewerMultiFileInput) & {
    options?: FileDiffOptions<undefined>;
    disableWorkerPool?: boolean;
    diffClassName?: string;
    fontSizePx?: number;
    lightTheme?: BundledTheme;
    darkTheme?: BundledTheme;
    themeType?: "light" | "dark";
    selectedLines?: DiffViewerSelectedLineRange | null;
    lineAnnotations?: DiffLineAnnotation[];
    renderAnnotation?: (annotation: DiffLineAnnotation) => ReactNode;
    /** diff 布局：unified 单栏（默认，保持既有调用方行为）或 split 双栏。 */
    diffStyle?: DiffViewerDiffStyle;
    /** 展开全部未修改上下文行（仅 MultiFileDiff 全文渲染有意义）。 */
    expandUnchanged?: boolean;
    /** 长行处理：scroll 横向滚动（默认）或 wrap 折行。 */
    overflow?: "scroll" | "wrap";
    /** split 模式下把新版（additions）列放到左栏。 */
    splitReverse?: boolean;
    /** 框选行交互（拖拽行/行号），结束时回调；null 表示清除选区。 */
    enableLineSelection?: boolean;
    onLineSelectionEnd?: (range: SelectedLineRange | null) => void;
    /** hover 行号旁展示 "+" 工具按钮，点击（含拖拽多行）时回调。 */
    enableGutterUtility?: boolean;
    onGutterUtilityClick?: (range: SelectedLineRange) => unknown;
  };

export interface DiffViewerSelectedLineRange {
  start: number;
  end: number;
  side: "additions" | "deletions";
}

function DiffViewerComponent(props: DiffViewerProps) {
  const rendersPatch = isPatchDiffProps(props);
  const {
    options: optionsOverride,
    disableWorkerPool = false,
    lightTheme,
    darkTheme,
    themeType,
    diffClassName,
    fontSizePx = 12,
    selectedLines,
    lineAnnotations,
    renderAnnotation,
    diffStyle = "unified",
    expandUnchanged = false,
    overflow = "scroll",
    splitReverse = false,
    enableLineSelection,
    onLineSelectionEnd,
    enableGutterUtility,
    onGutterUtilityClick,
    className,
    style,
  } = props;
  const viewerStyle = useMemo<DiffViewerStyle>(
    () => ({
      "--diffs-bg": "var(--color-background)",
      "--diffs-light-bg": "var(--color-background)",
      "--diffs-dark-bg": "var(--color-background)",
      // 完整 diff 运行在 @pierre/diffs Shadow DOM 中，不会自动继承外层 font-mono class。
      "--diffs-font-family": "var(--code-font-family, var(--font-mono))",
      "--diffs-font-size": `${fontSizePx}px`,
      ...style,
    }),
    [fontSizePx, style],
  );
  const options = useMemo<FileDiffOptions<undefined>>(
    () => ({
      diffStyle,
      diffIndicators: "bars",
      disableFileHeader: true,
      // PatchDiff 只有 patch 里的局部上下文，未包含完整 before/after 内容。
      // 使用 simple 避免展示无法点击展开的 “unmodified lines”；MultiFileDiff 保留可展开提示。
      hunkSeparators: rendersPatch ? "simple" : "line-info",
      expandUnchanged: rendersPatch ? false : expandUnchanged,
      lineDiffType: "word-alt",
      overflow,
      unsafeCSS:
        splitReverse && diffStyle === "split"
          ? DIFF_SPLIT_REVERSE_UNSAFE_CSS
          : DIFF_VIEWER_UNSAFE_CSS,
      // @pierre/diffs 的 code 节点在 Shadow DOM 内，外层 Tailwind class 无法命中；
      // 需要覆盖其内部样式时走 unsafeCSS 注入，且只做最小覆盖，不做大范围样式重写。
      theme:
        lightTheme && darkTheme
          ? {
              light: lightTheme,
              dark: darkTheme,
            }
          : undefined,
      themeType,
      preferredHighlighter: DIFFS_PREFERRED_HIGHLIGHTER,
      enableLineSelection: enableLineSelection === true,
      enableGutterUtility: enableGutterUtility === true,
      lineHoverHighlight: enableLineSelection || enableGutterUtility ? "both" : "disabled",
      onLineSelectionEnd,
      onGutterUtilityClick,
      ...optionsOverride,
    }),
    [
      darkTheme,
      diffStyle,
      enableGutterUtility,
      enableLineSelection,
      expandUnchanged,
      lightTheme,
      onGutterUtilityClick,
      onLineSelectionEnd,
      optionsOverride,
      overflow,
      rendersPatch,
      splitReverse,
      themeType,
    ],
  );

  const diffNode = rendersPatch ? (
    <PatchDiff
      patch={props.patch}
      options={options}
      disableWorkerPool={disableWorkerPool}
      selectedLines={selectedLines}
      lineAnnotations={lineAnnotations}
      renderAnnotation={renderAnnotation}
      className={cn("min-h-full w-full", diffClassName)}
      style={viewerStyle}
    />
  ) : (
    <MultiFileDiff
      oldFile={props.oldFile}
      newFile={props.newFile}
      options={options}
      disableWorkerPool={disableWorkerPool}
      selectedLines={selectedLines}
      lineAnnotations={lineAnnotations}
      renderAnnotation={renderAnnotation}
      className={cn("min-h-full w-full", diffClassName)}
      style={viewerStyle}
    />
  );

  const divProps = rendersPatch ? omitPatchDiffProps(props) : omitMultiFileDiffProps(props);

  return (
    <div
      className={cn("h-full w-full overflow-auto", className)}
      data-diff-viewer=""
      style={viewerStyle}
      {...divProps}
    >
      {diffNode}
    </div>
  );
}

export const DiffViewer = memo(DiffViewerComponent);
DiffViewer.displayName = "DiffViewer";

function isPatchDiffProps(
  props: DiffViewerPatchInput | DiffViewerMultiFileInput,
): props is DiffViewerPatchInput {
  return typeof props.patch === "string";
}

function omitPatchDiffProps({
  patch: _patch,
  options: _options,
  disableWorkerPool: _disableWorkerPool,
  diffClassName: _diffClassName,
  fontSizePx: _fontSizePx,
  lightTheme: _lightTheme,
  darkTheme: _darkTheme,
  themeType: _themeType,
  selectedLines: _selectedLines,
  lineAnnotations: _lineAnnotations,
  renderAnnotation: _renderAnnotation,
  diffStyle: _diffStyle,
  expandUnchanged: _expandUnchanged,
  overflow: _overflow,
  splitReverse: _splitReverse,
  enableLineSelection: _enableLineSelection,
  onLineSelectionEnd: _onLineSelectionEnd,
  enableGutterUtility: _enableGutterUtility,
  onGutterUtilityClick: _onGutterUtilityClick,
  className: _className,
  style: _style,
  ...divProps
}: DiffViewerProps & DiffViewerPatchInput) {
  return divProps;
}

function omitMultiFileDiffProps({
  oldFile: _oldFile,
  newFile: _newFile,
  options: _options,
  disableWorkerPool: _disableWorkerPool,
  diffClassName: _diffClassName,
  fontSizePx: _fontSizePx,
  lightTheme: _lightTheme,
  darkTheme: _darkTheme,
  themeType: _themeType,
  selectedLines: _selectedLines,
  lineAnnotations: _lineAnnotations,
  renderAnnotation: _renderAnnotation,
  diffStyle: _diffStyle,
  expandUnchanged: _expandUnchanged,
  overflow: _overflow,
  splitReverse: _splitReverse,
  enableLineSelection: _enableLineSelection,
  onLineSelectionEnd: _onLineSelectionEnd,
  enableGutterUtility: _enableGutterUtility,
  onGutterUtilityClick: _onGutterUtilityClick,
  className: _className,
  style: _style,
  ...divProps
}: DiffViewerProps & DiffViewerMultiFileInput) {
  return divProps;
}
