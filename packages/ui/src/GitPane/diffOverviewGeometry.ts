import { getLightweightDiffLineParts } from "@/components/ui/lightweight-diff-preview.js";

export interface GitDiffOverviewMarker {
  kind: "additions" | "deletions";
  top: number;
  bottom: number;
}

export interface GitDiffOverviewGeometry {
  markers: GitDiffOverviewMarker[];
  contentHeight: number;
  viewportHeight: number;
  scrollTop: number;
}

/** 使用实际行盒而非行号比例，折行、split 对齐空位和评论都会改变变更位置。 */
export function measureGitDiffOverview(
  scroll: HTMLElement,
  content: HTMLElement,
  diffHost: HTMLElement | null,
  plainTextLines: readonly string[] | undefined,
): GitDiffOverviewGeometry {
  const contentHeight = scroll.scrollHeight;
  const origin = scroll.getBoundingClientRect().top + scroll.clientTop - scroll.scrollTop;
  const markers: GitDiffOverviewMarker[] = [];
  const append = (element: Element, kind: GitDiffOverviewMarker["kind"]) => {
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0) return;
    markers.push({
      kind,
      top: Math.max(0, rect.top - origin),
      bottom: Math.min(contentHeight, rect.bottom - origin),
    });
  };

  if (plainTextLines) {
    const rows = content.querySelector("[data-lightweight-diff-scroll-content]")?.children;
    for (let index = 0; rows && index < rows.length; index += 1) {
      const line = plainTextLines[index];
      const row = rows.item(index);
      if (line === undefined || !row) continue;
      const { kind } = getLightweightDiffLineParts(line);
      if (kind !== "context") append(row, kind === "added" ? "additions" : "deletions");
    }
  } else {
    // @pierre/diffs 的 gutter 也有 line-type；限定 data-line 只测正文，避免重复色块。
    const shadow = diffHost?.shadowRoot;
    for (const kind of ["additions", "deletions"] as const) {
      const type = kind === "additions" ? "change-addition" : "change-deletion";
      shadow?.querySelectorAll(`[data-line][data-line-type="${type}"]`).forEach((line) => {
        append(line, kind);
      });
    }
  }

  markers.sort((a, b) => a.kind.localeCompare(b.kind) || a.top - b.top);
  const merged: GitDiffOverviewMarker[] = [];
  for (const marker of markers) {
    const previous = merged.at(-1);
    if (previous?.kind === marker.kind && marker.top <= previous.bottom + 1) {
      previous.bottom = Math.max(previous.bottom, marker.bottom);
    } else {
      merged.push({ ...marker });
    }
  }
  return {
    markers: merged,
    contentHeight,
    viewportHeight: scroll.clientHeight,
    scrollTop: scroll.scrollTop,
  };
}
