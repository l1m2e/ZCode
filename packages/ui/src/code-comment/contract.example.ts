import type { CommentDraftProps } from "./contract.js";

/** 把调用方持有的选区、附言与命令回调交给共享草稿组件，不创建本地副本。 */
export function exampleCodeCommentDraft(
  range: CommentDraftProps["range"],
  labels: CommentDraftProps["labels"],
  value: string,
  commands: Pick<CommentDraftProps, "onValueChange" | "onSubmit" | "onCancel">,
): CommentDraftProps {
  return { range, labels, value, ...commands };
}
