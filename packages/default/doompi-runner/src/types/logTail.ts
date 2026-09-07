/** A running follow; closing it stops the watch and releases the file. */
export interface LogTailHandle {
  close(): void;
}

export interface LogTailOptions {
  /** Byte offset to resume from; the caller has already read everything before it. */
  from: number;
  /**
   * Complete lines appended since the last call, in order; a partial trailing
   * line is held back. `completeThrough` is the byte offset just past the last
   * line handed over, which is where a reader that missed these must resume:
   * the file may already hold a fragment beyond it that is not a line yet.
   */
  onLines(lines: string[], completeThrough: number): void;
  /** The file went away or could not be read; the follow is over. */
  onError(error: Error): void;
}

/**
 * Follows a growing log file from a byte offset. Truncation resets to zero
 * rather than throwing, because a rotated log is a normal event.
 */
export interface ILogTail {
  follow(logPath: string, options: LogTailOptions): LogTailHandle;
}
