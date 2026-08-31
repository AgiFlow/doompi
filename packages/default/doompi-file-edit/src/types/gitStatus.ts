/**
 * Ask git which of a set of paths still hold exactly what git has for them.
 *
 * A tree walk can only see size and modification time, so a checkout, an
 * install, or a formatter that rewrote identical bytes looks the same as a real
 * edit. Git knows the difference for every file it tracks, and answering for a
 * batch of paths at once keeps that knowledge to one process per bash call.
 *
 * Only tracked, clean paths are reported. A path git does not track, one it
 * ignores, or a tree that is not a repository at all is simply absent from the
 * answer: this port never claims a file is unchanged when it cannot know.
 */
export interface GitStatusPort {
  /** The subset of `filePaths` git tracks and reports as unmodified. */
  unchanged(cwd: string, filePaths: readonly string[]): Promise<ReadonlySet<string>>;
}
