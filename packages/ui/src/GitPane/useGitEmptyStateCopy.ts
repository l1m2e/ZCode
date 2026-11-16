import { useMemo } from "react";
import type { GitChangeSourceId } from "@zcode/shared";
import type { GitPaneRepositoryState } from "@/hooks/useGitRepository.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function useGitEmptyStateCopy(sourceId: GitChangeSourceId, state: GitPaneRepositoryState) {
  const { intl } = useZCodeIntl();
  const { loading, error } = state;
  const { isGitAvailable, isRepository } = state.summary;
  return useMemo(() => {
    if (sourceId === "last-turn")
      return {
        title: intl.formatMessage({ id: "git.empty.lastTurnTitle" }),
        description: intl.formatMessage({ id: "git.empty.lastTurnDescription" }),
      };
    if (loading)
      return {
        title: intl.formatMessage({ id: "common.loading" }),
        description: intl.formatMessage({ id: "git.loading.description" }),
      };
    if (error)
      return {
        title: intl.formatMessage({ id: "git.error.title" }),
        description: intl.formatMessage({ id: "git.error.description" }, { message: error }),
      };
    const prefix = !isGitAvailable ? "gitUnavailable" : !isRepository ? "notRepository" : "";
    return {
      title: intl.formatMessage({ id: prefix ? `git.empty.${prefix}Title` : "git.empty.title" }),
      description: intl.formatMessage({
        id: prefix ? `git.empty.${prefix}Description` : "git.empty.description",
      }),
    };
  }, [sourceId, loading, error, isGitAvailable, isRepository, intl]);
}
