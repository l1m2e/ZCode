/** requires 与 architecture-policy.yaml 保持一致；精确文件 roots 保留现有调用路径。 */
export const gitReviewModule = {
  id: "git-review",
  requires: ["code-comment", "shared", "ui"],
  provides: ["git-review"],
  publicEntrypoints: ["contract.ts", "../GitPane.tsx", "../lib/gitReviewSettings.ts"],
} as const;
