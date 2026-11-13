import {
  normalizeGitReviewSettings,
  type GitReviewSettings,
  type GitPaneFileListProps,
} from "./contract.js";

/** store 合并 patch 后归一化，再沿既有持久化路径写入；本示例不执行 IO。 */
export function exampleGitReviewPreferenceUpdate(
  current: GitReviewSettings,
  patch: Partial<GitReviewSettings>,
): GitReviewSettings {
  return normalizeGitReviewSettings({ ...current, ...patch });
}

/** 列表只发出选择意图，由 GitPane 更新 selectedPath 并管理 diff 请求。 */
export function exampleGitReviewFileSelection(props: GitPaneFileListProps): void {
  const change = props.changes[0];
  if (change) {
    props.onSelect(change);
  }
}
