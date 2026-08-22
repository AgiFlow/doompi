import type { IClock, TimerHandle } from '../types/index.ts';
import { DEFAULT_VAD_CONFIGURATION } from './vad.ts';

const ENDPOINT_TRANSITION_SCORE = 8;

export interface EndpointBoundaryEvidence {
  segmentClosed: boolean;
  forcedClose: boolean;
  trailingSilenceMs: number;
}

interface WeightedEndpointGuard {
  matched: boolean;
  weight: number;
}

function endpointGuardScore(guards: readonly WeightedEndpointGuard[]): number {
  return guards.reduce((score, guard) => score + (guard.matched ? guard.weight : 0), 0);
}

export class AutonomousEndpoint {
  private timer: TimerHandle | undefined;
  private currentGeneration = 0;

  public constructor(
    private readonly clock: IClock,
    private readonly onEndpoint: (speechGeneration: number) => void,
  ) {}

  public get speechGeneration(): number {
    return this.currentGeneration;
  }

  public speechStarted(): number {
    this.currentGeneration += 1;
    this.cancelTimer();
    return this.currentGeneration;
  }

  public speechEnded(utteranceIdleMs: number, evidence: EndpointBoundaryEvidence): void {
    this.cancelTimer();
    const transitionScore = endpointGuardScore([
      { matched: this.currentGeneration > 0, weight: 3 },
      { matched: evidence.segmentClosed, weight: 3 },
      { matched: evidence.trailingSilenceMs >= DEFAULT_VAD_CONFIGURATION.trailingSilenceMs, weight: 2 },
      { matched: evidence.forcedClose, weight: 2 },
    ]);
    if (transitionScore < ENDPOINT_TRANSITION_SCORE) return;
    const generation = this.currentGeneration;
    const observedSilenceMs = Math.min(utteranceIdleMs, Math.max(0, evidence.trailingSilenceMs));
    const delayMs = Math.max(0, utteranceIdleMs - observedSilenceMs);
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      if (generation === this.currentGeneration) this.onEndpoint(generation);
    }, delayMs);
  }

  public invalidate(): number {
    this.currentGeneration += 1;
    this.cancelTimer();
    return this.currentGeneration;
  }

  public cancel(): void {
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    this.clock.clear(this.timer);
    this.timer = undefined;
  }
}
