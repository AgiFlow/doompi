import type { RtkProcessedOutput } from './rtkProcessor';

export interface BashRunRequest {
  command: string;
  cwd?: string;
  /**
   * Stops the command outright once it has run this long. Only meaningful
   * below the background threshold: past that the command is promoted instead.
   */
  timeoutMs?: number;
  /** Runs in the background immediately, skipping the wait entirely. */
  background?: boolean;
  /** Runs under a pseudo terminal so the command can prompt for input. */
  interactive?: boolean;
  /** Preferred runner name. A colliding name gets a numbered variant. */
  name?: string;
  /** Receives bounded output snapshots while the command remains in the foreground. */
  onOutput?: (output: string) => void;
  /** Session that owns the runner, so shutdown can stop what it started. */
  sessionId: string;
}

/** The command finished inside the foreground window. */
export interface CompletedRun {
  kind: 'completed';
  id: string;
  name: string;
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  logPath: string;
  backend: 'rmux' | 'tmux' | 'native';
  /** Present only when an eligible completed command was safely processed by RTK. */
  rtkOutput?: RtkProcessedOutput;
  /** RTK failure notice. The command outcome and raw output remain unchanged. */
  rtkWarning?: string;
  /** True when the run was stopped by the caller's timeout rather than finishing. */
  timedOut?: boolean;
}

/** The command is still running and is now a supervised background runner. */
export interface PromotedRun {
  kind: 'promoted';
  id: string;
  name: string;
  pid: number;
  logPath: string;
  backend: 'rmux' | 'tmux' | 'native';
  /**
   * `requested` when the caller asked for it, `threshold` when it outlived the
   * foreground window, `interactive` when it was hosted on a terminal.
   */
  reason: 'requested' | 'threshold' | 'interactive';
}

/** The process could not be started at all. */
export interface FailedRun {
  kind: 'failed';
  id: string;
  name: string;
  error: string;
}

export type BashRunResult = CompletedRun | PromotedRun | FailedRun;

/** Runs one bash command, promoting it to a background runner when it outlives the threshold. */
export interface IBashRunService {
  run(request: BashRunRequest): Promise<BashRunResult>;
}
