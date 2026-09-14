export interface IEditTracker {
  start(id: string, tool: string, args: unknown, cwd: string): Promise<void>;
  /**
   * Closes out a call. The working directory comes back in because a bash call
   * is closed by walking the tree, not by re-reading a path the arguments named.
   */
  end(id: string, isError: boolean, cwd: string): Promise<void>;
  /**
   * Awaits the tree walk `end` deferred so it does not hold up a tool result.
   * A caller about to clear this session's state needs it, or the walk appends
   * behind the clear.
   */
  flush(): Promise<void>;
  /**
   * Drops the tree baseline so a new session does not inherit the last one's,
   * and takes the paths this session's own bookkeeping occupies, which a tree
   * walk must never report as an edit.
   *
   * `isIgnored` carries the project's own ignore rules, so a path the project
   * disowns is dropped before it costs a git call, a read, or a stored blob.
   */
  reset(options?: { exclude?: readonly string[]; isIgnored?: (filePath: string) => boolean }): void;
}
