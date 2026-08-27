/**
 * Store and read the file content this session's diffs are built from.
 *
 * Nothing else in reach holds a "before". Git is not assumed, because plenty of
 * working directories are not repositories, and the edit tool discards the
 * content it read the moment it has written. So the package keeps its own
 * copies, addressed by the hash of what they hold, which means a file rewritten
 * with identical content costs nothing the second time.
 *
 * Every snapshot is bounded: text only, under a byte cap. A file failing either
 * test is still recorded as changed, just without content, and the surfaces say
 * so rather than drawing an empty diff.
 *
 * Declared here, not beside its implementation: services may import types but
 * never adapters, so a port living in src/adapters would be unreachable from
 * the code that needs it.
 */
export interface SnapshotStorePort {
  /** Names the directory the snapshots live in; called once per session. */
  initialize(directory: string): void;
  /**
   * Stores what the file holds right now and answers its hash, or undefined
   * when the file is missing, binary, or past the cap.
   */
  capture(filePath: string): Promise<string | undefined>;
  /** Stores content already in hand, which is what a save from the cockpit has. */
  put(content: string): Promise<string>;
  /** The content behind a hash, or undefined once the session dropped it. */
  read(hash: string): Promise<string | undefined>;
  /** Removes every snapshot this session took. */
  clear(): Promise<void>;
}
