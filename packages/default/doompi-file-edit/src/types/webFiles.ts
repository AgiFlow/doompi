import type { FileEditTool } from './domain.ts';

/**
 * View types shared by this package's hub channel and its web plugin. Wire
 * JSON only, no node types, so the cockpit bundle can carry them; the
 * cockpit receives them as 'file_edits' channel payloads.
 *
 * The channel carries the list alone. One file's diffs and content are large
 * and only wanted once a reader opens the file, so those come from the session
 * API instead (see fileEditsApi.ts).
 */

/** One file this session changed, as the activity dock lists it. */
export interface FilesItemView {
  /** Absolute path, and the identity every API route takes back. */
  path: string;
  /** Path relative to the session's working directory, which is what a row shows. */
  relPath: string;
  /** The tool behind the most recent change. */
  tool: FileEditTool;
  /** When that change happened, epoch milliseconds. */
  at: number;
  /** How many changes this session recorded for the file. */
  count: number;
  /**
   * Whether any change captured a baseline, so a diff can be shown at all. A
   * file found by comparing the tree around a bash call has no "before", so it
   * is listed and readable but never diffed.
   */
  diffable: boolean;
}

/** The frame type the hub publishes and the web plugin claims; declared in the doompiWeb block too. */
export const filesChannelType = 'file_edits';

/** Footer status key whose presence shows the activity group; the extension publishes it. */
export const filesStatusKey = 'doom-file-edit-files';
