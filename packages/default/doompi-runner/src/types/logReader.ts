export interface LogQuery {
  /** Trailing lines to return before filtering. Defaults to 200. */
  lines?: number;
  grep?: string;
  ignoreCase?: boolean;
  contextLines?: number;
}

export interface LogSlice {
  text: string;
  /** Lines in the returned slice. */
  lineCount: number;
  /** Lines in the whole file, so a truncated view says what it left out. */
  totalLines: number;
  /** Size of the log file on disk, in bytes. */
  fileSize: number;
  /**
   * Bytes through the end of the last complete line.
   *
   * A runner caught mid-line leaves the file ending without a newline. That
   * partial line is still returned in `text`, because a finished run whose
   * last line never got a newline would otherwise lose it. A follower starts
   * from here instead of `fileSize` so the line arrives whole from the stream
   * rather than split across the slice and the first appended chunk.
   */
  completeBytes: number;
  path: string;
  /** False when the runner has produced no log file yet. */
  exists: boolean;
  /**
   * 1-based numbers of the returned lines, for a grep whose results are not
   * contiguous. Absent for a plain tail, where the numbers run unbroken to
   * `totalLines` and the reader can count them itself.
   */
  lineNumbers?: number[];
}

/** Scans complete logs with bounded memory, then returns a tail or grep context. */
export interface ILogReader {
  read(logPath: string, query?: LogQuery): LogSlice;
}
