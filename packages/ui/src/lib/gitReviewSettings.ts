/**
 * Git 审查面板(GitPane)展示偏好的类型、默认值与加载校验。
 *
 * 与 codePreviewSettings 相同的中立模块模式:类型和默认值放在 lib,
 * store 只做状态托管与持久化,GitPane 子组件可以不依赖 store 拿到类型。
 */
export type GitDiffDisplayStyle = "unified" | "split";

export interface GitReviewSettings {
  /** diff 展示模式:split 双栏对比(新版在左)或 unified 单栏。 */
  diffStyle: GitDiffDisplayStyle;
  /** 左侧变更文件列表栏是否可见。 */
  fileListVisible: boolean;
}

export const DEFAULT_GIT_REVIEW_SETTINGS: GitReviewSettings = {
  diffStyle: "split",
  fileListVisible: true,
};

export function normalizeGitReviewSettings(patch: Partial<GitReviewSettings>): GitReviewSettings {
  return {
    diffStyle: patch.diffStyle === "unified" ? "unified" : "split",
    fileListVisible: patch.fileListVisible === false ? false : true,
  };
}
