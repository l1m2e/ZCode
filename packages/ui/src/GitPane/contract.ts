/** Git 审查 UI 的公开类型以实际组件为唯一来源，避免登记时另建一套状态接口。 */
import type { GitPane } from "@/GitPane.js";
import type { GitPaneDiffContent } from "./GitPaneDiffContent.js";

export { DiffPreviewContent } from "./DiffPreviewContent.js";

export type GitPaneProps = Parameters<typeof GitPane>[0];
export type GitPaneDiffContentProps = Parameters<typeof GitPaneDiffContent>[0];
export type { GitPaneFileListProps } from "./GitPaneFileList.js";

/** 纯偏好接口；写入与持久化由现有 Zustand store 负责。 */
export {
  DEFAULT_GIT_REVIEW_SETTINGS,
  normalizeGitReviewSettings,
} from "@/lib/gitReviewSettings.js";
export type { GitDiffDisplayStyle, GitReviewSettings } from "@/lib/gitReviewSettings.js";
