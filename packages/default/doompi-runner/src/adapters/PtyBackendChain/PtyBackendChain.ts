import type { RunHandle } from '../../types/launcher';
import type { PtyRun } from '../../types/ptyHost';
import type { IRmuxBackend, RmuxLaunchRequest } from '../../types/rmuxBackend';
import type { ExitResult } from '../../types/spawner';
import { TMUX_TARGET_PREFIX } from '../TmuxBackend/TmuxBackend.ts';

/**
 * Presents the available PTY backends as one, preferring RMUX.
 *
 * A launch takes the first backend that accepts it, so a host without a
 * compatible RMUX binary still gets panes rather than falling through to the
 * plain subprocess launcher. Every later call routes on the target's prefix
 * instead of asking each backend in turn: a backend cannot tell "this session
 * is gone" from "this session was never mine", and guessing would let one
 * report success for the other's run.
 */
export class PtyBackendChain implements IRmuxBackend {
  constructor(
    private readonly rmux: IRmuxBackend,
    private readonly tmux: IRmuxBackend,
  ) {}

  async launch(request: RmuxLaunchRequest): Promise<RunHandle | undefined> {
    return (await this.rmux.launch(request)) ?? (await this.tmux.launch(request));
  }

  watch(id: string, target: string, sessionId?: string): Promise<ExitResult | undefined> {
    return this.owner(target).watch(id, target, sessionId);
  }

  stop(target: string, expectedPid: number): Promise<boolean> {
    return this.owner(target).stop(target, expectedPid);
  }

  input(target: string, text: string): Promise<boolean> {
    return this.owner(target).input(target, text);
  }

  /** Both backends persist terminal evidence at the same path, so either answers. */
  readOutcome(id: string, sessionId: string): ExitResult | undefined {
    return this.rmux.readOutcome(id, sessionId) ?? this.tmux.readOutcome(id, sessionId);
  }

  get(name: string): PtyRun | undefined {
    return this.rmux.get(name) ?? this.tmux.get(name);
  }

  private owner(target: string): IRmuxBackend {
    return target.startsWith(TMUX_TARGET_PREFIX) ? this.tmux : this.rmux;
  }
}
