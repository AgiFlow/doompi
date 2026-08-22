export type RunnerBackend = 'rmux' | 'tmux' | 'native';
export type RunnerState = 'running' | 'completed';
export type RunnerExitReason =
  | 'completed'
  | 'failed'
  | 'signaled'
  | 'stopped'
  | 'timed_out'
  | 'launcher_error'
  | 'backend_lost';

export interface RunnerExit {
  reason: RunnerExitReason;
  code: number | null;
  signal: NodeJS.Signals | null;
  stopReason?: string;
  finishedAt: string;
}

/** A recurring snapshot of a running runner, pushed to the model until it exits. */
export interface RunnerAlarm {
  intervalMs: number;
  /** The last fire, or the runner's start time before the first one. */
  lastFiredAt: string;
}

/** A command this extension supervises, retained after completion for CLI access. */
export interface RunnerRecord {
  id: string;
  name: string;
  /** Process group leader, the pid signals are sent to. */
  pid: number;
  command: string;
  cwd: string;
  logPath: string;
  interactive: boolean;
  sessionId: string;
  /** Root Pi session shared by the process tree. Ownership remains with sessionId. */
  rootSessionId?: string;
  startedAt: string;
  state: RunnerState;
  promoted: boolean;
  backend: RunnerBackend;
  backendTarget?: string;
  exit?: RunnerExit;
  /** Present only while a runner is running with an alarm attached. */
  alarm?: RunnerAlarm;
  /** pid of the pi process that launched it, for orphan detection. */
  hostPid: number;
}

export interface RegisterRunnerInput {
  id: string;
  name: string;
  pid: number;
  command: string;
  cwd: string;
  logPath: string;
  interactive: boolean;
  sessionId: string;
  backend: RunnerBackend;
  backendTarget?: string;
  /** Arms a recurring snapshot at this interval. */
  alarmMs?: number;
}

export interface CompleteRunnerInput {
  reason: RunnerExitReason;
  code: number | null;
  signal: NodeJS.Signals | null;
  stopReason?: string;
}

/** Worktree-scoped active registry with session-scoped retained history. */
export interface IRunnerRegistry {
  register(input: RegisterRunnerInput): Promise<RunnerRecord>;
  list(): Promise<RunnerRecord[]>;
  /** Active doom-runner records across repository scopes, used only for safe legacy-store cleanup. */
  listAcrossRepositories(): Promise<RunnerRecord[]>;
  /** Active records started by one session, used for scoped bulk stop and shutdown. */
  listBySession(sessionId: string): Promise<RunnerRecord[]>;
  /** Active records visible to every descendant of one root Pi session. */
  listByRootSession(rootSessionId: string): Promise<RunnerRecord[]>;
  /** Active and recently completed records retained for one session. */
  listAll(sessionId?: string): Promise<RunnerRecord[]>;
  get(id: string, sessionId?: string): Promise<RunnerRecord | undefined>;
  markPromoted(id: string): Promise<RunnerRecord | undefined>;
  complete(id: string, outcome: CompleteRunnerInput, sessionId?: string): Promise<RunnerRecord | undefined>;
  /** Disarms an alarm. Safe to call on a runner that has none. */
  clearAlarm(id: string, sessionId?: string): Promise<RunnerRecord | undefined>;
  /**
   * Reschedules an alarm from `firedAt`, returning the record the caller may
   * report on.
   *
   * Returns undefined when the alarm was disarmed or the runner finished since
   * the caller read it, which is what stops a concurrent `alarm stop` from
   * being overwritten by an in-flight fire.
   */
  markAlarmFired(id: string, firedAt: string): Promise<RunnerRecord | undefined>;
  /** Removes the active process entry while retaining run metadata. */
  release(id: string): Promise<void>;
  /** Marks entries whose process is gone as lost. Returns their ids. */
  pruneDead(): Promise<string[]>;
  /** Notifies in-process consumers after the registry changes. */
  subscribe(listener: () => void): () => void;
  close(): void;
}
