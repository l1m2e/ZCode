import { parseDiffFromFile, type FileContents, type FileDiffMetadata } from "@pierre/diffs";

/**
 * editor 视图（VSCode 编辑器模式）的逐行变更标识：
 * - 绿 = 纯新增：change block 中未被配对的新增行，由 CSS 按 `data-line-type` 默认绘制；
 * - 蓝 = 修改：block 内第 i 个删除 ↔ 第 i 个新增配对的新版行，逐行生成 CSS；
 * - 红 = 删除位置：旧代码行折叠成的细条，按 `data-line-type` 默认绘制。
 *
 * 库的 gutter 色条按"连续同类行 run"合并成单个元素且不带行号，无法区分
 * 同一段落里的修改行与纯新增行，因此修改行必须在应用层配对后逐行标记。
 */
export function computeEditorViewModifiedLines(
  oldFile: FileContents,
  newFile: FileContents,
): readonly number[] {
  try {
    return collectModifiedNewLines(parseDiffFromFile(oldFile, newFile));
  } catch {
    // 配对失败只损失蓝色修改标识，不能让 editor 视图整体渲染失败。
    return [];
  }
}

function collectModifiedNewLines(metadata: FileDiffMetadata): readonly number[] {
  const modified: number[] = [];
  for (const hunk of metadata.hunks) {
    // hunk.additionStart 是该 hunk 在新版文件中的起始行号；按 hunkContent
    // 顺序累加（context 占 lines 个新版行，change 占 additions 个）得到每个
    // block 的新版起点。
    let newLine = hunk.additionStart;
    for (const group of hunk.hunkContent) {
      if (group.type === "context") {
        newLine += group.lines;
        continue;
      }
      const paired = Math.min(group.deletions, group.additions);
      for (let index = 0; index < paired; index += 1) modified.push(newLine + index);
      newLine += group.additions;
    }
  }
  return modified;
}

/**
 * 生成修改行（蓝）的 Shadow DOM CSS。选择器带 `data-line-type` 前缀，
 * 与默认绿色规则保持同优先级，靠注入顺序靠后胜出；按批合并选择器，
 * 避免大 diff 产生上千条独立规则。注意 ::before 必须逐个附加到选择器上，
 * 否则 `a,b::before{}` 中 a 会命中元素本身，把整格行号染成蓝色。
 */
export function buildEditorViewMarksCss(modifiedLines: readonly number[]): string {
  if (modifiedLines.length === 0) return "";
  const batchSize = 64;
  const rules: string[] = [];
  for (let start = 0; start < modifiedLines.length; start += batchSize) {
    const selectors = modifiedLines
      .slice(start, start + batchSize)
      .map((line) => `[data-line-type="change-addition"][data-column-number="${line}"]::before`);
    rules.push(`${selectors.join(",")}{background:var(--diffs-modified-base)}`);
  }
  return rules.join("");
}
