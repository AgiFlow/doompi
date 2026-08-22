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
  path: string;
  /** False when the runner has produced no log file yet. */
  exists: boolean;
}

/** Scans complete logs with bounded memory, then returns a tail or grep context. */
export interface ILogReader {
  read(logPath: string, query?: LogQuery): LogSlice;
}
