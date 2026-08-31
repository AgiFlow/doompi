export type FileEditTool = 'edit' | 'write' | 'bash' | 'user';
export type FileEditState = 'modified' | 'added' | 'deleted' | 'unchanged' | 'binary' | 'external';

/**
 * How a change was discovered, which is what decides whether it can be diffed.
 *
 * A `tool` change names its path in the call arguments, so the content is read
 * before the tool runs and both sides of the change are known. A `scan` change
 * is found by comparing a tree manifest taken around a bash call: the path is
 * only known afterwards, so there is no "before" to diff against.
 */
export type FileEditOrigin = 'tool' | 'scan';

/**
 * One recorded change, appended to the session's timeline.
 *
 * Version 1 events carried the path alone. Version 2 adds the blob hashes that
 * make a diff possible; both are still read, because a session already running
 * when the package updates keeps appending to the file it opened.
 */
export interface TimelineEvent {
  version: 2;
  path: string;
  tool: FileEditTool;
  at: number;
  origin: FileEditOrigin;
  /** Snapshot hash of the content before the change; absent for a scan-found path. */
  before?: string;
  /** Snapshot hash of the content after the change; absent when it could not be stored. */
  after?: string;
  additions?: number;
  removals?: number;
  /**
   * Set on a scan change whose content was proven to have moved, rather than
   * only its modification time. Absent on a scan recorded by an older build,
   * which could not tell an edit from a file a command merely touched.
   */
  verified?: boolean;
}

/** A version 1 event, still accepted from a timeline opened by an older build. */
export interface LegacyTimelineEvent {
  version: 1;
  path: string;
  tool: 'edit' | 'write' | 'bash';
  at: number;
}

export interface FileEditEntry {
  path: string;
  tool: FileEditTool;
  at: number;
  count: number;
}

/** One change in a file's history, as the cockpit lists it. */
export interface FileEditVersion {
  /** Position in the file's own history, oldest first, starting at 1. */
  index: number;
  tool: FileEditTool;
  at: number;
  origin: FileEditOrigin;
  before?: string;
  after?: string;
  additions?: number;
  removals?: number;
  verified?: boolean;
}

export interface FileDiff {
  path: string;
  state: FileEditState;
  lines: string[];
  additions: number;
  removals: number;
  tracked: boolean;
  truncated: boolean;
  suggestedLine: number;
}

export interface ResolvedEditor {
  template: string;
  source: 'configured' | 'VISUAL' | 'EDITOR' | 'fallback';
}
