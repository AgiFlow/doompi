export const PLAYBACK_ECHO_TAIL_MS = 800;

export interface PlaybackGateSnapshot {
  sessionId?: string;
  generation: number;
  phase: 'open' | 'playing' | 'echoTail';
  suppressUntil: number;
}

export interface PlaybackGateUpdate {
  sessionId: string;
  playbackGeneration: number;
  active: boolean;
}

export class PlaybackGate {
  private current: PlaybackGateSnapshot = {
    generation: 0,
    phase: 'open',
    suppressUntil: 0,
  };

  public update(update: PlaybackGateUpdate, now: number): boolean {
    if (this.current.sessionId === update.sessionId) {
      if (update.playbackGeneration < this.current.generation) return false;
      if (
        update.playbackGeneration === this.current.generation &&
        !(this.current.phase === 'playing' && !update.active)
      )
        return false;
    }
    this.current = {
      sessionId: update.sessionId,
      generation: update.playbackGeneration,
      phase: update.active ? 'playing' : 'echoTail',
      suppressUntil: update.active ? Number.POSITIVE_INFINITY : now + PLAYBACK_ECHO_TAIL_MS,
    };
    return true;
  }

  public suppresses(sessionId: string, now: number): boolean {
    if (this.current.sessionId !== sessionId) return false;
    if (this.current.phase === 'playing') return true;
    if (this.current.phase === 'echoTail' && now < this.current.suppressUntil) return true;
    return false;
  }

  public snapshot(now: number): PlaybackGateSnapshot {
    if (this.current.phase === 'echoTail' && now >= this.current.suppressUntil) {
      return { ...this.current, phase: 'open' };
    }
    return { ...this.current };
  }

  public reset(): void {
    this.current = { generation: 0, phase: 'open', suppressUntil: 0 };
  }
}
