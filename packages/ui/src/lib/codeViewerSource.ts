import type {
  CodeViewerSource,
  HistoricalDiffConversationReference,
  PatchCodeViewerSource,
} from "@/lib/codeViewer.js";
import type { CodeViewerWorkspaceScope } from "@/lib/codeViewerWorkspaceScope.js";
import { decodeFilePathUriEscapes, getPathLeaf } from "@/lib/path.js";

/** tab 可来自旧持久数据；缺少来源 scope 时不得借用当前 workspace 查询历史。 */
export function normalizeHistoricalDiffReference(
  source: PatchCodeViewerSource,
): HistoricalDiffConversationReference | undefined {
  const reference = source.conversation;
  if (
    !source.workspacePath?.trim() ||
    !source.path?.trim() ||
    typeof reference?.sessionId !== "string" ||
    !reference.sessionId.trim() ||
    !Number.isSafeInteger(reference.target?.rowId) ||
    reference.target.rowId < 0 ||
    typeof reference.target.entityId !== "string" ||
    !reference.target.entityId.trim()
  ) {
    return undefined;
  }
  return {
    sessionId: reference.sessionId.trim(),
    target: {
      rowId: reference.target.rowId,
      entityId: reference.target.entityId.trim(),
    },
    ...(typeof reference.contentPath === "string" && reference.contentPath.trim()
      ? { contentPath: reference.contentPath }
      : {}),
  };
}

/** 只给编辑 patch 绑定行来源，Read 和普通 file source 保持原入口语义。 */
export function withHistoricalDiffSource(
  source: CodeViewerSource,
  scope: CodeViewerWorkspaceScope & { sessionId?: string | null },
  target: { rowId: number; entityId?: string },
  contentPath = "path" in source ? source.path : undefined,
): CodeViewerSource {
  if (source.type !== "patch") return source;
  return normalizeCodeViewerSource({
    ...source,
    workspacePath: scope.workspacePath,
    workspaceIdentity: scope.workspaceIdentity,
    workspaceRemoteSessionId: scope.workspaceRemoteSessionId,
    conversation:
      scope.sessionId && target.entityId
        ? {
            sessionId: scope.sessionId,
            target: { rowId: target.rowId, entityId: target.entityId },
            contentPath,
          }
        : undefined,
  });
}

export function normalizeCodeViewerSource(source: CodeViewerSource): CodeViewerSource {
  if (source.type === "patch" && source.conversation !== undefined) {
    const conversation = normalizeHistoricalDiffReference(source);
    if (!conversation) {
      const { conversation: _invalidReference, ...patchSource } = source;
      source = patchSource;
    } else if (
      conversation.sessionId !== source.conversation.sessionId ||
      conversation.target.entityId !== source.conversation.target.entityId
    ) {
      source = { ...source, conversation };
    }
  }
  const decodedTitle = decodeFilePathUriEscapes(source.title);

  if (!("path" in source) || !source.path) {
    return decodedTitle === source.title ? source : { ...source, title: decodedTitle };
  }

  const decodedPath = decodeFilePathUriEscapes(source.path);
  const sourceLeaf = getPathLeaf(source.path);
  const decodedLeaf = getPathLeaf(decodedPath);
  const title =
    source.title === sourceLeaf || source.title.trim().length === 0 ? decodedLeaf : decodedTitle;

  if (decodedPath === source.path && title === source.title) {
    return source;
  }

  return {
    ...source,
    title,
    path: decodedPath,
  };
}
