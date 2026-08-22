import type { RunHandle } from './launcher';

/** A background run hosted on a pseudo terminal, so it can be typed at. */
export interface PtyRun extends RunHandle {
  /** Sends text to the terminal. A newline is appended by the caller. */
  write(text: string): void;
  /** The visible screen, as plain text, for the overlay. */
  screen(): string;
  /** Subscribes to raw terminal output. Returns an unsubscribe function. */
  onData(handler: (data: string) => void): () => void;
  resize(cols: number, rows: number): void;
}

export interface PtyLaunchRequest {
  id: string;
  name: string;
  command: string;
  cwd: string;
  sessionId: string;
  cols?: number;
  rows?: number;
}

/**
 * Owns every pseudo terminal this session started.
 *
 * A PTY cannot outlive its host process, so unlike detached subprocesses these
 * runs are only reachable from the session that launched them.
 */
export interface IPtyHost {
  launch(request: PtyLaunchRequest): Promise<PtyRun>;
  get(name: string): PtyRun | undefined;
  /** Writes a line to a runner. False when this session does not host it. */
  write(name: string, text: string): boolean;
  list(): PtyRun[];
  disposeAll(): Promise<void>;
}
