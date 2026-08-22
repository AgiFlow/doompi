export interface PtyExitResult {
  exitCode: number;
  signal?: number;
}

export interface PtySpawnRequest {
  /** Shell command line, run under a pseudo terminal so it can prompt. */
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(handler: (data: string) => void): void;
  onExit(handler: (result: PtyExitResult) => void): void;
  kill(signal?: string): void;
}

/** Pseudo terminal creation retained as a compatibility port for custom hosts. */
export interface IPtySpawner {
  spawn(request: PtySpawnRequest): Promise<PtyProcess>;
}
