import {
  DEFAULT_COMPACTION_SETTINGS,
  type FileOperations,
  type SessionEntry,
  sessionEntryToContextMessages,
} from '@earendil-works/pi-coding-agent';
import {
  CHECKPOINT_HEADINGS,
  CHECKPOINT_MESSAGE_TYPE,
  COMPACTION_THRESHOLDS,
  CONTEXT_MESSAGE_TYPE,
  STATE_VERSION,
} from '../../types/constants.ts';
import type {
  AutocompactContextDetails,
  AutocompactFileDetails,
  AutocompactMessage,
  AutocompactPass,
  AutocompactState,
  CheckpointDecision,
  CheckpointRequestDetails,
  ContextProjection,
} from '../../types/index.ts';

const SHOULD_COMPACT_PATTERN = /<shouldCompact>\s*(true|false)\s*<\/shouldCompact>/i;
const FILE_SECTION_PATTERN = /\n*<(?:read-files|modified-files)>[\s\S]*?<\/(?:read-files|modified-files)>/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPass(value: unknown): value is AutocompactPass {
  return value === 1 || value === 2 || value === 3;
}

function assistantText(entry: SessionEntry): string | undefined {
  if (entry.type !== 'message' || entry.message.role !== 'assistant') return undefined;
  const text = entry.message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  return text || undefined;
}

function isAutocompactMessage(value: unknown): value is AutocompactMessage {
  return isRecord(value) && typeof value.role === 'string';
}

export function contextDetailsFromUnknown(value: unknown): AutocompactContextDetails | undefined {
  if (!isRecord(value) || !isStringArray(value.readFiles) || !isStringArray(value.modifiedFiles)) return undefined;
  if (!Array.isArray(value.retainedMessages) || !value.retainedMessages.every(isAutocompactMessage)) return undefined;
  if (!isRecord(value.doomAutocompact)) return undefined;
  const marker = value.doomAutocompact;
  if (
    marker.version !== STATE_VERSION ||
    (marker.pass !== 2 && marker.pass !== 3) ||
    typeof marker.cycle !== 'number' ||
    typeof marker.requestId !== 'string' ||
    typeof marker.snapshotLeafId !== 'string' ||
    typeof marker.tokensBefore !== 'number'
  )
    return undefined;
  return {
    readFiles: [...value.readFiles],
    modifiedFiles: [...value.modifiedFiles],
    retainedMessages: [...value.retainedMessages],
    doomAutocompact: {
      version: STATE_VERSION,
      cycle: marker.cycle,
      pass: marker.pass,
      requestId: marker.requestId,
      snapshotLeafId: marker.snapshotLeafId,
      tokensBefore: marker.tokensBefore,
    },
  };
}

export function createInitialState(): AutocompactState {
  return {
    version: STATE_VERSION,
    cycle: 1,
    pass: 1,
    phase: 'waiting',
    checkpointQueue: [],
    exhaustedPasses: [],
    invalidAttempts: 0,
    baselineTokens: 0,
    baselinePending: false,
    readFiles: [],
    modifiedFiles: [],
  };
}

export function thresholdTokens(pass: AutocompactPass, contextWindow: number, baselineTokens = 0): number {
  const threshold = COMPACTION_THRESHOLDS[pass];
  const baseline = Math.max(0, Math.min(baselineTokens, contextWindow));
  const remaining = contextWindow - baseline;
  const staged = baseline + Math.min(Math.floor(remaining * threshold.ratio), threshold.capTokens);
  // Pi compacts natively above `contextWindow - reserveTokens`. A staged threshold above that
  // point can never fire, so the ladder would silently degrade into native compaction: on a
  // 200k window the raw pass 3 ratio lands at 190_000, while Pi already compacted at 183_616.
  const nativeTrigger = contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  return nativeTrigger > baseline ? Math.min(staged, nativeTrigger) : staged;
}

export function latestCheckpointArtifactEntry(branchEntries: SessionEntry[]): SessionEntry | undefined {
  return branchEntries.findLast(
    (entry) =>
      entry.type === 'compaction' ||
      // Staged checkpoints are plain entries so they stay out of the agent's LLM context.
      (entry.type === 'custom' && entry.customType === CHECKPOINT_MESSAGE_TYPE) ||
      // Legacy sessions staged checkpoints as custom messages; committed markers still are.
      (entry.type === 'custom_message' &&
        (entry.customType === CHECKPOINT_MESSAGE_TYPE || entry.customType === CONTEXT_MESSAGE_TYPE)),
  );
}

export function baselineUsageIsSettled(branchEntries: SessionEntry[]): boolean {
  const boundaryIndex = branchEntries.findLastIndex(
    (entry) =>
      entry.type === 'compaction' || (entry.type === 'custom_message' && entry.customType === CONTEXT_MESSAGE_TYPE),
  );
  return branchEntries.slice(boundaryIndex + 1).some((entry) => {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') return false;
    const { stopReason, usage } = entry.message;
    if (stopReason === 'aborted' || stopReason === 'error' || !usage) return false;
    return (usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite) > 0;
  });
}

export function retainedMessagesAfterSnapshot(
  branchEntries: SessionEntry[],
  snapshotLeafId: string,
): AutocompactMessage[] {
  const snapshotIndex = branchEntries.findIndex((entry) => entry.id === snapshotLeafId);
  if (snapshotIndex === -1) return [];
  return branchEntries
    .slice(snapshotIndex + 1)
    .filter((entry) => entry.type !== 'custom_message' || entry.customType !== CHECKPOINT_MESSAGE_TYPE)
    .flatMap((entry) => sessionEntryToContextMessages(entry));
}

export function projectContextMessages(
  messages: AutocompactMessage[],
  branchEntries: SessionEntry[],
): ContextProjection {
  const nativeCompactionIndex = branchEntries.findLastIndex((entry) => entry.type === 'compaction');
  const markerEntry = branchEntries
    .slice(nativeCompactionIndex + 1)
    .findLast((entry) => entry.type === 'custom_message' && entry.customType === CONTEXT_MESSAGE_TYPE);
  if (!markerEntry || markerEntry.type !== 'custom_message') {
    return { messages, retainedMessageCount: 0 };
  }

  const details = contextDetailsFromUnknown(markerEntry.details);
  const summary = checkpointSummaryFromEntry(markerEntry);
  if (!details || !summary) return { messages, invalidMarker: true, retainedMessageCount: 0 };

  const markerMessageIndex = messages.findLastIndex(
    (message) =>
      message.role === 'custom' &&
      message.customType === CONTEXT_MESSAGE_TYPE &&
      contextDetailsFromUnknown(message.details)?.doomAutocompact.requestId === details.doomAutocompact.requestId,
  );
  if (markerMessageIndex === -1) return { messages, invalidMarker: true, retainedMessageCount: 0 };

  const summaryMessage: AutocompactMessage = {
    role: 'compactionSummary',
    summary,
    tokensBefore: details.doomAutocompact.tokensBefore,
    timestamp: messages[markerMessageIndex]?.timestamp ?? Date.now(),
  };
  return {
    messages: [summaryMessage, ...details.retainedMessages, ...messages.slice(markerMessageIndex + 1)],
    marker: details.doomAutocompact,
    retainedMessageCount: details.retainedMessages.length,
  };
}

export function fileOperationsFromMessages(messages: AutocompactMessage[]): FileOperations {
  const fileOps: FileOperations = { read: new Set(), written: new Set(), edited: new Set() };
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue;
      const path = typeof block.arguments.path === 'string' ? block.arguments.path : undefined;
      if (!path) continue;
      if (block.name === 'read') fileOps.read.add(path);
      else if (block.name === 'write') fileOps.written.add(path);
      else if (block.name === 'edit') fileOps.edited.add(path);
    }
  }
  return fileOps;
}

export function parseState(value: unknown): AutocompactState | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== STATE_VERSION || typeof value.cycle !== 'number' || !isPass(value.pass)) return undefined;
  if (
    value.phase !== 'waiting' &&
    value.phase !== 'checkpoint_pending' &&
    value.phase !== 'checkpoint_ready' &&
    value.phase !== 'compacting'
  )
    return undefined;
  const baselineTokens = value.baselineTokens ?? 0;
  if (typeof baselineTokens !== 'number' || baselineTokens < 0) return undefined;
  const baselinePending = value.baselinePending ?? false;
  if (typeof baselinePending !== 'boolean') return undefined;
  const checkpointQueue = value.checkpointQueue ?? [];
  if (
    !Array.isArray(checkpointQueue) ||
    !checkpointQueue.every(isPass) ||
    checkpointQueue.some((pass, index) => index > 0 && pass <= checkpointQueue[index - 1]!)
  )
    return undefined;
  // Sessions persisted before bounded retry landed simply have no attempt history to restore.
  const exhaustedPasses = value.exhaustedPasses ?? [];
  if (!Array.isArray(exhaustedPasses) || !exhaustedPasses.every(isPass)) return undefined;
  const invalidAttempts = value.invalidAttempts ?? 0;
  if (typeof invalidAttempts !== 'number' || invalidAttempts < 0) return undefined;
  if (!isStringArray(value.readFiles) || !isStringArray(value.modifiedFiles)) return undefined;
  if (value.requestId !== undefined && typeof value.requestId !== 'string') return undefined;
  if (value.compactionPass !== undefined && value.compactionPass !== 2 && value.compactionPass !== 3) return undefined;
  if ('latestCheckpointEntryId' in value) return undefined;
  if (value.latestCheckpointSnapshotLeafId !== undefined && typeof value.latestCheckpointSnapshotLeafId !== 'string')
    return undefined;
  if (value.lastAttemptLeafId !== undefined && typeof value.lastAttemptLeafId !== 'string') return undefined;
  if (value.snapshotLeafId !== undefined && typeof value.snapshotLeafId !== 'string') return undefined;
  if (value.snapshotTokens !== undefined && (typeof value.snapshotTokens !== 'number' || value.snapshotTokens < 0))
    return undefined;
  if (value.pendingCheckpoint !== undefined && typeof value.pendingCheckpoint !== 'string') return undefined;

  return {
    version: STATE_VERSION,
    cycle: value.cycle,
    pass: value.pass,
    phase: value.phase,
    checkpointQueue: [...checkpointQueue],
    exhaustedPasses: [...exhaustedPasses],
    invalidAttempts,
    baselineTokens,
    baselinePending,
    readFiles: [...value.readFiles],
    modifiedFiles: [...value.modifiedFiles],
    ...(value.requestId ? { requestId: value.requestId } : {}),
    ...(value.compactionPass ? { compactionPass: value.compactionPass } : {}),
    ...(value.latestCheckpointSnapshotLeafId
      ? { latestCheckpointSnapshotLeafId: value.latestCheckpointSnapshotLeafId }
      : {}),
    ...(value.lastAttemptLeafId ? { lastAttemptLeafId: value.lastAttemptLeafId } : {}),
    ...(value.snapshotLeafId ? { snapshotLeafId: value.snapshotLeafId } : {}),
    ...(value.snapshotTokens !== undefined ? { snapshotTokens: value.snapshotTokens } : {}),
    ...(value.pendingCheckpoint ? { pendingCheckpoint: value.pendingCheckpoint } : {}),
  };
}

export function checkpointSummaryFromEntry(entry: SessionEntry | undefined): string | undefined {
  if (!entry) return undefined;
  if (entry.type === 'compaction') return entry.summary.trim() || undefined;
  if (entry.type === 'custom') {
    return isRecord(entry.data) && typeof entry.data.summary === 'string'
      ? entry.data.summary.trim() || undefined
      : undefined;
  }
  if (entry.type === 'custom_message') {
    const content =
      typeof entry.content === 'string'
        ? entry.content
        : entry.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
    return content.trim() || undefined;
  }
  return assistantText(entry);
}

export function parseCheckpointDecision(response: string): CheckpointDecision {
  const match = response.match(SHOULD_COMPACT_PATTERN);
  const summary = response.replace(SHOULD_COMPACT_PATTERN, '').trim();
  if (!match) return { summary };
  return { summary, shouldCompact: match[1]?.toLowerCase() === 'true' };
}

export function isStructuredCheckpoint(summary: string): boolean {
  return CHECKPOINT_HEADINGS.every((heading) => summary.includes(heading));
}

export function createRequestId(
  sessionId: string,
  cycle: number,
  pass: AutocompactPass,
  leafId: string | null,
): string {
  return `${sessionId}:${cycle}:${pass}:${leafId ?? 'root'}`;
}

export function checkpointRequestDetails(
  cycle: number,
  pass: AutocompactPass,
  requestId: string,
): CheckpointRequestDetails {
  return { version: STATE_VERSION, cycle, pass, requestId };
}

export function mergeFileDetails(
  current: AutocompactFileDetails,
  fileOps?: FileOperations,
  additional?: AutocompactFileDetails,
): AutocompactFileDetails {
  const modified = new Set([
    ...current.modifiedFiles,
    ...(additional?.modifiedFiles ?? []),
    ...(fileOps ? [...fileOps.edited, ...fileOps.written] : []),
  ]);
  const read = new Set([...current.readFiles, ...(additional?.readFiles ?? []), ...(fileOps ? [...fileOps.read] : [])]);
  for (const path of modified) read.delete(path);
  return { readFiles: [...read].sort(), modifiedFiles: [...modified].sort() };
}

export function fileDetailsFromUnknown(value: unknown): AutocompactFileDetails | undefined {
  if (!isRecord(value) || !isStringArray(value.readFiles) || !isStringArray(value.modifiedFiles)) return undefined;
  return { readFiles: value.readFiles, modifiedFiles: value.modifiedFiles };
}

export function withCanonicalFileSections(summary: string, details: AutocompactFileDetails): string {
  const sections: string[] = [];
  if (details.readFiles.length > 0) sections.push(`<read-files>\n${details.readFiles.join('\n')}\n</read-files>`);
  if (details.modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${details.modifiedFiles.join('\n')}\n</modified-files>`);
  }
  const normalized = summary.replace(FILE_SECTION_PATTERN, '').trim();
  return sections.length > 0 ? `${normalized}\n\n${sections.join('\n\n')}` : normalized;
}
