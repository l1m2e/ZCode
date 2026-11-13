import type { CommentDraft } from "@/components/ui/code-comment.js";

/** 调用方持有选区与 value；组件只报告编辑、提交和取消意图。 */
export type CommentDraftProps = Parameters<typeof CommentDraft>[0];
export type { CodeCommentLabels } from "@/components/ui/code-comment.js";
