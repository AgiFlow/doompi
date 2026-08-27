export interface IEditTracker {
  start(id: string, tool: string, args: unknown, cwd: string): Promise<void>;
  /**
   * Closes out a call. The working directory comes back in because a bash call
   * is closed by walking the tree, not by re-reading a path the arguments named.
   */
  end(id: string, isError: boolean, cwd: string): Promise<void>;
  /**
   * Drops the tree baseline so a new session does not inherit the last one's,
   * and takes the paths this session's own bookkeeping occupies, which a tree
   * walk must never report as an edit.
   */
  reset(options?: { exclude?: readonly string[] }): void;
}
