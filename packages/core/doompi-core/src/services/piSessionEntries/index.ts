/**
 * Boundary between the two session record formats DoomPi carries.
 *
 * The headless server persists conversations through the pi-agent-core harness `Session`, whose
 * entries are numbered (`seq`) and timestamped in epoch milliseconds. Pi extensions are instead
 * handed a pi-coding-agent `SessionManager`, whose JSONL records carry no sequence and use ISO
 * timestamps, and whose entry union has five members the harness cannot express natively.
 *
 * This module is the only place that translation happens. It is pure: no IO, no SQLite, no file
 * access, just functions over arrays.
 */
import type { Entry } from '@earendil-works/pi-agent-core';
import {
  CURRENT_SESSION_VERSION,
  type BranchSummaryEntry,
  type CompactionEntry,
  type CustomEntry,
  type FileEntry,
  type SessionEntry,
  type SessionEntryBase,
  type SessionHeader,
  type SessionMessageEntry,
} from '@earendil-works/pi-coding-agent';

/** Reserved harness `customType` prefix for Pi entry types the harness has no native record for. */
export const PI_MIRRORED_ENTRY_PREFIX = 'pi.';

/** Harness `SessionMetadata` carries no name, model, or thinking level, so the header is synthesized. */
export interface PiSessionHeaderInput {
  id: string;
  cwd: string;
  createdAt: number;
  parentSessionId?: string;
}

function toIsoTimestamp(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toISOString();
}

/** Synthesize the Pi session header the harness has no direct equivalent for. */
export function toPiSessionHeader(input: PiSessionHeaderInput): SessionHeader {
  return {
    type: 'session',
    version: CURRENT_SESSION_VERSION,
    id: input.id,
    timestamp: toIsoTimestamp(input.createdAt),
    cwd: input.cwd,
    ...(input.parentSessionId === undefined ? {} : { parentSession: input.parentSessionId }),
  };
}

/** Convert one harness entry. Returns undefined for entries with no Pi representation. */
export function toPiSessionEntry(entry: Entry): SessionEntry | undefined {
  // `seq` is deliberately dropped: Pi orders entries by file position and the parent link.
  const base: Omit<SessionEntryBase, 'type'> = {
    id: entry.id,
    parentId: entry.parentId,
    timestamp: toIsoTimestamp(entry.timestamp),
  };
  switch (entry.type) {
    case 'message': {
      const message: SessionMessageEntry = { ...base, type: 'message', message: entry.message };
      return message;
    }
    case 'compaction': {
      // Pi names the retained boundary by entry id while the harness carries the retained messages
      // inline, so the compaction entry itself is the earliest entry still in context.
      const compaction: CompactionEntry = {
        ...base,
        type: 'compaction',
        summary: entry.summary,
        firstKeptEntryId: entry.id,
        tokensBefore: entry.tokensBefore,
        fromHook: entry.fromHook,
        ...(entry.details === undefined ? {} : { details: entry.details }),
        ...(entry.usage === undefined ? {} : { usage: entry.usage }),
      };
      return compaction;
    }
    case 'branch_summary': {
      // Pi requires an origin entry id. A summary of a branch with no origin cannot be represented,
      // and a partial record would corrupt the tree Pi rebuilds from these links.
      const fromId = entry.fromId ?? entry.parentId;
      if (fromId === null) return undefined;
      const branchSummary: BranchSummaryEntry = {
        ...base,
        type: 'branch_summary',
        fromId,
        summary: entry.summary,
        fromHook: entry.fromHook,
        ...(entry.details === undefined ? {} : { details: entry.details }),
        ...(entry.usage === undefined ? {} : { usage: entry.usage }),
      };
      return branchSummary;
    }
    case 'custom': {
      const custom: CustomEntry = {
        ...base,
        type: 'custom',
        customType: entry.customType,
        ...(entry.data === undefined ? {} : { data: entry.data }),
      };
      return custom;
    }
    default:
      // A harness entry type introduced after this boundary was written has no Pi record yet.
      return undefined;
  }
}

/** Header followed by every convertible entry, preserving input order. */
export function toPiFileEntries(header: PiSessionHeaderInput, entries: readonly Entry[]): FileEntry[] {
  const files: FileEntry[] = [toPiSessionHeader(header)];
  for (const entry of entries) {
    const converted = toPiSessionEntry(entry);
    if (converted !== undefined) files.push(converted);
  }
  return files;
}

/** Reverse direction, for mirroring extension-initiated writes back into the harness. */
export function fromPiSessionEntry(entry: SessionEntry): { customType: string; data: unknown } | undefined {
  switch (entry.type) {
    case 'message':
    case 'compaction':
    case 'branch_summary':
      // Produced by the agent loop itself; mirroring these back would double-record them.
      return undefined;
    case 'custom':
      return { customType: entry.customType, data: entry.data };
    default:
      // thinking_level_change, model_change, custom_message, label and session_info have no harness
      // counterpart, so the whole Pi record is preserved under a reserved customType.
      return { customType: `${PI_MIRRORED_ENTRY_PREFIX}${entry.type}`, data: entry };
  }
}
