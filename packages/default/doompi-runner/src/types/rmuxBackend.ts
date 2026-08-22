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
  get(name: string): PtyRun | undefined;
}
