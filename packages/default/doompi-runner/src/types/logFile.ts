/** An open append handle for one runner's log. */
export interface LogWriter {
  readonly path: string;
  append(text: string): void;
  /** Complete bytes written to the authoritative raw log. */
  size(): number;
  close(): void;
}

/** Opens runner log files, truncating any output left by a previous runner of the same name. */
export interface ILogFile {
  open(id: string): LogWriter;
}
