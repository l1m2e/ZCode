import {
  RewindScope,
  SessionEventType,
  parseCheckpointCreatedPayload,
  parseWorkspaceCheckpointArtifact,
  type DiffHunk,
  type SessionEvent,
  type TurnFileChangeSummary,
  type TurnId,
} from "@zcode/contracts";
import type { V4ConversationFileChangesResult } from "@zcode/shared/zcode-protocol-v4";
import { applyPatch, structuredPatch, type StructuredPatch } from "diff";

interface FileChangeAggregate {
  afterContent?: string;
  beforeContent: string | undefined;
  fallbackAdditions: number;
  fallbackDeletions: number;
  patches: DiffHunk[];
  path: string;
  toolNames: Set<string>;
  writeCount: number;
}

interface WorkspaceCheckpointWithTurn {
  checkpoint: ReturnType<typeof parseCheckpointCreatedPayload>;
  turnId: string | null;
}

type ReadArtifact = (snapshotRef: string) => Promise<string>;

function isSplitProductTurnId(turnId: string | null | undefined): boolean {
  return Boolean(turnId?.includes("~"));
}

function isWorkspaceCheckpoint(
  checkpoint: ReturnType<typeof parseCheckpointCreatedPayload>,
): boolean {
  return checkpoint.scope === RewindScope.Workspace || checkpoint.scope === RewindScope.Both;
}

function workspaceCheckpoints(events: readonly SessionEvent[]): WorkspaceCheckpointWithTurn[] {
  return events
    .filter((event) => event.type === SessionEventType.CheckpointCreated)
    .map((event) => ({
      checkpoint: parseCheckpointCreatedPayload(event.payload),
      turnId: event.turnId ? String(event.turnId) : null,
    }))
    .filter(({ checkpoint }) => isWorkspaceCheckpoint(checkpoint));
}

function selectWorkspaceCheckpointsForFileSummary(
  events: readonly SessionEvent[],
  messageIds: readonly string[],
  targetTurnId?: TurnId | null,
): WorkspaceCheckpointWithTurn[] {
  const messageIdSet = new Set(messageIds);
  const checkpoints = workspaceCheckpoints(events);
  const byMessageId = checkpoints.filter(({ checkpoint }) =>
    messageIdSet.has(String(checkpoint.targetMessageId ?? checkpoint.messageId)),
  );
  if (byMessageId.length > 0 || !targetTurnId || isSplitProductTurnId(String(targetTurnId))) {
    return byMessageId;
  }

  // 旧事件和缺失 user messageId 映射的普通 TurnStarted
  // 只能用事件 turnId 兜底。split product turn 带 "~q" 后缀，禁止按 runtime turnId
  // 合并，避免 queued/drained 场景串轮。
  return checkpoints.filter(({ turnId }) => turnId === String(targetTurnId));
}

function readModelCompleteFileChangesFallback(
  events: readonly SessionEvent[],
  targetTurnId?: TurnId | null,
): V4ConversationFileChangesResult | null {
  if (!targetTurnId || isSplitProductTurnId(String(targetTurnId))) {
    return null;
  }
  const event = [...events]
    .reverse()
    .find(
      (candidate) =>
        candidate.type === SessionEventType.ModelComplete &&
        String(candidate.turnId ?? "") === String(targetTurnId),
    );
  const fileChanges = (event?.payload as { fileChanges?: unknown } | undefined)?.fileChanges;
  if (typeof fileChanges !== "object" || fileChanges === null) {
    return null;
  }
  const rawItems = (fileChanges as { items?: unknown }).items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return null;
  }
  const items = rawItems
    .flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.path !== "string" || record.path.length === 0) return [];
      return [
        {
          path: record.path,
          additions:
            typeof record.additions === "number" && record.additions > 0 ? record.additions : 0,
          deletions:
            typeof record.deletions === "number" && record.deletions > 0 ? record.deletions : 0,
          writeCount:
            typeof record.writeCount === "number" && record.writeCount > 0 ? record.writeCount : 1,
          toolNames: [] as string[],
          patches: [] as DiffHunk[],
        },
      ];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (items.length === 0) return null;
  return {
    files: items.length,
    additions: items.reduce((total, item) => total + item.additions, 0),
    deletions: items.reduce((total, item) => total + item.deletions, 0),
    items,
  };
}

async function aggregateWorkspaceCheckpoints(
  checkpoints: readonly WorkspaceCheckpointWithTurn[],
  readArtifact: ReadArtifact,
  options: { contentPath?: string; toolCallId?: string } = {},
): Promise<V4ConversationFileChangesResult> {
  const byPath = new Map<string, FileChangeAggregate>();
  let incomplete = false;

  // checkpoint 顺序就是同一轮文件写入顺序，必须串行聚合 first-before → final-after。
  for (const { checkpoint } of checkpoints) {
    let artifact: ReturnType<typeof parseWorkspaceCheckpointArtifact>;
    try {
      artifact = parseWorkspaceCheckpointArtifact(
        JSON.parse(await readArtifact(checkpoint.snapshotRef)),
      );
    } catch (error) {
      if (options.contentPath === undefined) throw error;
      // 缺失产物可能包含首写或末写，无法证明完整版本；只读详情保留 patch 并明确 unavailable。
      incomplete = true;
      continue;
    }
    // 旧 CheckpointCreated 不含 toolCallId；必须读取候选 artifact 后按权威工具 ID 筛选。
    if (options.toolCallId !== undefined && artifact.toolCallId !== options.toolCallId) continue;
    for (const file of artifact.files) {
      const fallback = countPatchLines(file.structuredPatch);
      const afterContent = resolveCheckpointAfterContent(file);
      const existing = byPath.get(file.path);
      if (!existing) {
        byPath.set(file.path, {
          afterContent,
          beforeContent: resolveCheckpointBeforeContent(file),
          fallbackAdditions: fallback.additions,
          fallbackDeletions: fallback.deletions,
          patches: file.structuredPatch,
          path: file.path,
          toolNames: new Set([artifact.toolName]),
          writeCount: 1,
        });
        continue;
      }
      // 末次重建失败就没有 final-after，不能用上一笔成功版本冒充末次结果。
      existing.afterContent = afterContent;
      existing.fallbackAdditions += fallback.additions;
      existing.fallbackDeletions += fallback.deletions;
      existing.patches.push(...file.structuredPatch);
      existing.toolNames.add(artifact.toolName);
      existing.writeCount += 1;
    }
  }

  const items: V4ConversationFileChangesResult["items"] = Array.from(byPath.values())
    .map((entry): V4ConversationFileChangesResult["items"][number] => {
      const available =
        !incomplete && entry.beforeContent !== undefined && entry.afterContent !== undefined;
      const patches = available
        ? createFinalPatch(entry.path, entry.beforeContent!, entry.afterContent!)
        : entry.patches;
      const stat = available
        ? countPatchLines(patches)
        : {
            additions: entry.fallbackAdditions,
            deletions: entry.fallbackDeletions,
          };
      return {
        path: entry.path,
        additions: stat.additions,
        deletions: stat.deletions,
        writeCount: entry.writeCount,
        toolNames: Array.from(entry.toolNames).sort(),
        patches,
        ...(options.contentPath === entry.path
          ? {
              content: available
                ? {
                    status: "available" as const,
                    beforeContent: entry.beforeContent!,
                    afterContent: entry.afterContent!,
                  }
                : { status: "unavailable" as const },
            }
          : {}),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    files: items.length,
    additions: items.reduce((total, item) => total + item.additions, 0),
    deletions: items.reduce((total, item) => total + item.deletions, 0),
    items,
  };
}

export async function readConversationFileChangesFromEvents(input: {
  events: readonly SessionEvent[];
  messageIds: readonly string[];
  readArtifact: ReadArtifact;
  targetTurnId?: TurnId | null;
  contentPath?: string;
  toolCallId?: string;
}): Promise<V4ConversationFileChangesResult> {
  const checkpoints = selectWorkspaceCheckpointsForFileSummary(
    input.events,
    input.messageIds,
    input.targetTurnId,
  );
  let result = await aggregateWorkspaceCheckpoints(checkpoints, input.readArtifact, input);
  if (result.items.length === 0 && input.toolCallId === undefined) {
    // 整轮旧摘要只可用于整轮查询，绝不能作为单个工具的历史事实。
    result = readModelCompleteFileChangesFallback(input.events, input.targetTurnId) ?? result;
  }
  if (input.contentPath !== undefined) {
    const selected = result.items.find((item) => item.path === input.contentPath);
    if (selected) {
      selected.content ??= { status: "unavailable" };
    } else {
      // 没有该路径的历史证据也需明确回复；零写入占位不计入文件/行数摘要，更不读取当前磁盘。
      result.items.push({
        path: input.contentPath,
        additions: 0,
        deletions: 0,
        writeCount: 0,
        toolNames: [],
        patches: [],
        content: { status: "unavailable" },
      });
      result.items.sort((left, right) => left.path.localeCompare(right.path));
    }
  }
  return result;
}

export async function buildColdFileChangeSummaries(input: {
  events: readonly SessionEvent[];
  messageIds: readonly string[];
  onArtifactError?: (messageId: string, error: unknown) => void;
  readArtifact: ReadArtifact;
}): Promise<ReadonlyMap<string, TurnFileChangeSummary>> {
  const durableMessageIds = new Set(input.messageIds);
  const checkpointsByMessageId = new Map<string, WorkspaceCheckpointWithTurn[]>();
  for (const entry of workspaceCheckpoints(input.events)) {
    const messageId = String(entry.checkpoint.targetMessageId ?? entry.checkpoint.messageId);
    if (!durableMessageIds.has(messageId)) continue;
    const entries = checkpointsByMessageId.get(messageId) ?? [];
    entries.push(entry);
    checkpointsByMessageId.set(messageId, entries);
  }

  const summaries = new Map<string, TurnFileChangeSummary>();
  const groups = [...checkpointsByMessageId.entries()];
  let cursor = 0;
  const workerCount = Math.min(8, groups.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < groups.length) {
        const group = groups[cursor];
        cursor += 1;
        if (!group) continue;
        const [messageId, checkpoints] = group;
        try {
          const result = await aggregateWorkspaceCheckpoints(checkpoints, input.readArtifact);
          if (result.items.length === 0) continue;
          summaries.set(messageId, {
            additions: result.additions,
            deletions: result.deletions,
            files: result.files,
            items: result.items.map((item) => ({
              additions: item.additions,
              deletions: item.deletions,
              path: item.path,
              toolNames: item.toolNames,
              writeCount: item.writeCount,
            })),
          });
        } catch (error) {
          input.onArtifactError?.(messageId, error);
        }
      }
    }),
  );
  return summaries;
}

function createFinalPatch(path: string, beforeContent: string, afterContent: string): DiffHunk[] {
  return (
    structuredPatch(path, path, beforeContent, afterContent, undefined, undefined, {
      timeout: 5_000,
    })?.hunks ?? []
  );
}

type CheckpointFile = ReturnType<typeof parseWorkspaceCheckpointArtifact>["files"][number];

function resolveCheckpointBeforeContent(file: CheckpointFile): string | undefined {
  // null 只在明确的新建文件中表示空文件；已存在但未记录的 before 是未知版本。
  return file.beforeContent ?? (file.existedBefore === false ? "" : undefined);
}

function patchMatchesRecordedLines(beforeContent: string, hunks: readonly DiffHunk[]): boolean {
  const lines = beforeContent.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let previousEnd = 0;
  let lineDelta = 0;
  for (const hunk of hunks) {
    if (
      ![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(
        (value) => Number.isInteger(value) && value >= 0,
      )
    )
      return false;
    // structuredPatch 的内部坐标始终从 1 起（包括零行 hunk），与序列化 unified header 不同。
    const start = hunk.oldStart - 1;
    const newStart = hunk.newStart - 1;
    if (start < previousEnd || start > lines.length || newStart !== start + lineDelta) return false;
    let oldLines = 0;
    let newLines = 0;
    for (const line of hunk.lines) {
      if (line === "\\ No newline at end of file") continue;
      const operation = line[0];
      if (operation !== " " && operation !== "-" && operation !== "+") return false;
      if (operation !== "+") {
        if (lines[start + oldLines] !== line.slice(1)) return false;
        oldLines += 1;
      }
      if (operation !== "-") newLines += 1;
    }
    if (oldLines !== hunk.oldLines || newLines !== hunk.newLines) return false;
    previousEnd = start + oldLines;
    lineDelta += newLines - oldLines;
  }
  return true;
}

function resolveCheckpointAfterContent(file: CheckpointFile): string | undefined {
  if (typeof file.afterContent === "string") return file.afterContent;
  const beforeContent = resolveCheckpointBeforeContent(file);
  if (beforeContent === undefined) return undefined;
  // 没有持久 after 且没有 patch 时无法证明最终版本，不能把 before 当作未变化的 after。
  if (file.structuredPatch.length === 0) return undefined;
  // applyPatch 的 fuzzFactor=0 仍会扫描偏移位置；先核对持久行号和原文，禁止近似恢复历史。
  if (!patchMatchesRecordedLines(beforeContent, file.structuredPatch)) return undefined;
  const patch: StructuredPatch = {
    oldFileName: file.path,
    newFileName: file.path,
    oldHeader: undefined,
    newHeader: undefined,
    hunks: file.structuredPatch,
  };
  try {
    const patched = applyPatch(beforeContent, patch, {
      autoConvertLineEndings: false,
      fuzzFactor: 0,
    });
    return typeof patched === "string" &&
      (file.afterContentLength === undefined || patched.length === file.afterContentLength)
      ? patched
      : undefined;
  } catch {
    // 旧产物中的坏 hunk 可能直接抛错；只标记历史版本不可恢复，保留原 patch 供展示。
    return undefined;
  }
}

function countPatchLines(hunks: readonly DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }
  return { additions, deletions };
}
