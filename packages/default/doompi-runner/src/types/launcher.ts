import type { ExitResult } from './spawner';

export interface LaunchRequest {
  id: string;
  /** Runner name, already allocated and free of collisions. */
  name: string;
  command: string;
  cwd: string;
  sessionId: string;
}

export interface RunHandle {
  readonly id: string;
  readonly name: string;
  readonly pid: number | undefined;
  readonly logPath: string;
  readonly backend: 'rmux' | 'tmux' | 'native';
  readonly backendTarget?: string;
  /**
   * Output captured so far, tail-capped. The log file always holds everything.
   */
  output(): string;
  /** Resolves when the process exits, or rejects if it never started. */
  completion(): Promise<ExitResult>;
  /**
   * Stops buffering output in memory and lets the process outlive this handle.
   * Called when a run is promoted to a background runner.
   */
  detach(): void;
  /** Signals the process group and waits for it to go away. */
  stop(): Promise<boolean>;
}

export interface ILauncher {
  launch(request: LaunchRequest): RunHandle;
  /** SIGTERM the group led by `pid`, then SIGKILL if it outlasts the grace period. */
  stop(pid: number): Promise<boolean>;
}
