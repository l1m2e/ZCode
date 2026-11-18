import { useMemo } from "react";
import type { GitPaneFileChange } from "@/hooks/useGitRepository.js";

/**
 * SCM 列表投影：按调用方谓词（如隐藏测试文件）裁剪展示条目。
 *
 * 只裁剪列表投影，Git 快照与写操作范围仍由调用方按同一谓词计算；
 * 谓词必须由调用方稳定（useCallback），否则每次渲染都会重建数组，
 * 让下游以数组为依赖的 memo 全部失效。
 */
export function useVisibleGitPaneChanges(
  changes: readonly GitPaneFileChange[],
  changeFilter: ((change: GitPaneFileChange) => boolean) | undefined,
): readonly GitPaneFileChange[] {
  return useMemo(
    () => (changeFilter ? changes.filter(changeFilter) : changes),
    [changeFilter, changes],
  );
}
