/** Outcome of a finished child process. */
export interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type OutputStream = 'stdout' | 'stderr';

export interface SpawnRequest {
  /** Shell command line, run through the login shell like pi's built-in bash. */
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Detached puts the child in its own process group, so the whole tree stays killable. */
  detached: boolean;
}

export interface SpawnedProcess {
  readonly pid: number | undefined;
  onOutput(handler: (chunk: string, stream: OutputStream) => void): void;
  onExit(handler: (result: ExitResult) => void): void;
  onError(handler: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
  /** Lets the host process exit while the child keeps running. */
  unref(): void;
}

/** Subprocess creation as a port, so launching is testable without real processes. */
export interface ISpawner {
  spawn(request: SpawnRequest): SpawnedProcess;
}
