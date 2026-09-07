import type { RunHandle } from './launcher';
import type { PtyRun } from './ptyHost';
import type { ExitResult } from './spawner';

export interface RmuxLaunchRequest {
  id: string;
  name: string;
  command: string;
  cwd: string;
  sessionId: string;
  interactive: boolean;
}

export interface IRmuxBackend {
  /** Returns undefined when no compatible RMUX binary is available before launch. */
  launch(request: RmuxLaunchRequest): Promise<RunHandle | undefined>;
  /** Reconnects completion monitoring for a persisted RMUX session. */
  watch(id: string, target: string, sessionId?: string): Promise<ExitResult | undefined>;
  /** Reads persisted terminal evidence without contacting RMUX. */
  readOutcome(id: string, sessionId: string): ExitResult | undefined;
  stop(target: string, expectedPid: number): Promise<boolean>;
  input(target: string, text: string): Promise<boolean>;
  /**
   * The pane's current screen as text, or undefined when it cannot be read.
   *
   * A screen, not a byte stream: the multiplexer holds the rendered state and
   * hands back what is on it now. That is what makes an attached view possible
   * from another process, where the live PTY handle is out of reach, and it is
   * why the log file cannot stand in: it is scrubbed of cursor movement before
   * it is ever written.
   */
  capture(target: string): Promise<string | undefined>;
  get(name: string): PtyRun | undefined;
}
