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
import { buildEditorViewMarksCss } from "@/lib/editorViewDiffMarks.js";

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

// editor 视觉模式：像 VSCode 编辑器一样阅读当前文件全文，不在行背景上铺增删色。
// 库按“增删背景 → 选中背景 → 最终行背景”合成颜色；覆盖 --diffs-line-bg 会
// 抹掉新增/修改行及行号的选区。只重置增删背景层，让选中和悬停继续由库合成。
// 行号仅在未选中时恢复普通前景色，保留库的选中行号配色。
// 删除行折叠与逐行色条见下方 DIFF_EDITOR_MARKS_CSS。
const DIFF_EDITOR_UNSAFE_CSS = [
  "[data-line-type=change-addition]:is([data-gutter-buffer],[data-column-number],[data-line],[data-no-newline]){--diffs-computed-diff-line-bg:var(--diffs-bg);--diffs-diff-line-mix-target:var(--diffs-bg)}",
  "[data-line-type=change-deletion]:is([data-gutter-buffer],[data-column-number],[data-line],[data-no-newline]){--diffs-computed-diff-line-bg:var(--diffs-bg);--diffs-diff-line-mix-target:var(--diffs-bg)}",
  ":is([data-line-type=change-addition],[data-line-type=change-deletion]):is([data-gutter-buffer],[data-column-number],[data-line],[data-no-newline]):not([data-selected-line]){color:var(--diffs-fg-number)}",
  "[data-line-type=change-addition] del,[data-line-type=change-addition] ins{background:transparent;color:inherit;text-decoration:none}",
  "[data-line-type=change-deletion] del,[data-line-type=change-deletion] ins{background:transparent;color:inherit;text-decoration:none}",
].join("");

// editor 档的逐行变更标识：库的 gutter 色条按"连续同类行 run"合并成单个元素，
// 无法区分同一段落里的修改行与纯新增行，因此隐藏后改在逐行的行号格上重绘。
// 逐行保留 4px 会让大段删除累积空白；仅段首保留可供概览测量的薄标记。
// 库把注解放在行后的独立兄弟节点；跨过它识别连续段，保留注解自身高度和版本锚点。
const DIFF_EDITOR_DELETION = '[data-line-type="change-deletion"]';
const DIFF_EDITOR_COLLAPSED_RUN_HEIGHT_PX = 4;
const DIFF_EDITOR_MARKS_CSS = [
  // 隐藏 run 合并的库色条；annotation（评论锚点背景）与 metadata（\ No newline）不在其列。
  '[data-gutter-buffer="buffer"]{display:none}',
  '[data-line-type="change-deletion"][data-gutter-buffer]{display:none}',
  // 行号和正文同步压缩网格轨道；无末尾换行元数据不额外占位。
  `${DIFF_EDITOR_DELETION}:is([data-line],[data-column-number]){height:${DIFF_EDITOR_COLLAPSED_RUN_HEIGHT_PX}px;min-height:0;line-height:0;font-size:0;overflow:hidden;color:transparent;background:transparent}`,
  `${DIFF_EDITOR_DELETION}[data-no-newline]{height:0;min-height:0;line-height:0;font-size:0;overflow:hidden}`,
  // 每行至多一个注解容器；正文与 gutter 分别跳过各自的注解节点，段内后续旧行归零。
  `${DIFF_EDITOR_DELETION}[data-line] + ${DIFF_EDITOR_DELETION}[data-line],${DIFF_EDITOR_DELETION}[data-line] + [data-line-annotation] + ${DIFF_EDITOR_DELETION}[data-line],${DIFF_EDITOR_DELETION}[data-column-number] + ${DIFF_EDITOR_DELETION}[data-column-number],${DIFF_EDITOR_DELETION}[data-column-number] + [data-gutter-buffer="annotation"] + ${DIFF_EDITOR_DELETION}[data-column-number]{height:0}`,
  '[data-line-type="change-deletion"] [data-line-number-content]{display:none}',
  // 行号格左缘逐行色条：绿=新增、红=删除位置；修改行（蓝）由 editorModifiedLines 生成。
  "[data-column-number]{position:relative}",
  '[data-column-number]::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:transparent}',
  '[data-line-type="change-addition"][data-column-number]::before{background:var(--diffs-addition-base)}',
  '[data-line-type="change-deletion"][data-column-number]::before{background:var(--diffs-deletion-base)}',
].join("");

const NO_EDITOR_MODIFIED_LINES: readonly number[] = [];

export type DiffViewerDiffStyle = "unified" | "split" | "editor";

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
    /** diff 布局：unified 单栏（默认，保持既有调用方行为）、split 双栏或 editor 视觉模式。 */
    diffStyle?: DiffViewerDiffStyle;
    /**
     * editor 档的"修改行"（与删除配对的新版行号，1 基）。调用方用
     * parseDiffFromFile 配对计算；缺省时新增行一律绿色，无蓝/绿区分。
     */
    editorModifiedLines?: readonly number[];
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
    editorModifiedLines = NO_EDITOR_MODIFIED_LINES,
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
      // editor 是 unified 单栏之上的视觉变体：整文件阅读，仅 gutter 色条标记增删。
      diffStyle: diffStyle === "editor" ? "unified" : diffStyle,
      diffIndicators: "bars",
      disableFileHeader: true,
      // PatchDiff 只有 patch 里的局部上下文，未包含完整 before/after 内容。
      // 使用 simple 避免展示无法点击展开的 “unmodified lines”；MultiFileDiff 保留可展开提示。
      hunkSeparators: rendersPatch ? "simple" : "line-info",
      expandUnchanged: rendersPatch ? false : expandUnchanged,
      // editor 模式逐词高亮也属于"改动噪音"，与行背景一起关闭，保持编辑器观感。
      lineDiffType: diffStyle === "editor" ? "none" : "word-alt",
      overflow,
      unsafeCSS:
        diffStyle === "editor"
          ? DIFF_EDITOR_UNSAFE_CSS +
            DIFF_EDITOR_MARKS_CSS +
            buildEditorViewMarksCss(editorModifiedLines)
          : splitReverse && diffStyle === "split"
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
      editorModifiedLines,
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
  editorModifiedLines: _editorModifiedLines,
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
  editorModifiedLines: _editorModifiedLines,
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
