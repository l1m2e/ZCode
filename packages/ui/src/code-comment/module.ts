/** 共享评论草稿 UI；依赖声明与 architecture-policy.yaml 保持一致。 */
export const codeCommentModule = {
  id: "code-comment",
  requires: ["ui"],
  provides: ["code-comment"],
  publicEntrypoints: ["contract.ts", "../components/ui/code-comment.tsx"],
} as const;
