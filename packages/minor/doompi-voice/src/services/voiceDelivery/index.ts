import type { AutonomousTurnIdentity } from '../../models/autonomousVoiceMachine';

export type VoiceDeliveryIntent = 'immediate' | 'queuedFollowUp';

export interface VoiceDeliveryRequest extends AutonomousTurnIdentity {
  revision: number;
  text: string;
  intent?: VoiceDeliveryIntent;
}

export type VoiceDeliveryResult =
  | ({ kind: 'delivered' } & Omit<VoiceDeliveryRequest, 'text'>)
  | ({ kind: 'failed'; code: string } & Omit<VoiceDeliveryRequest, 'text'>);

export interface VoiceDeliveryDependencies {
  deliver(text: string, intent?: VoiceDeliveryIntent): void | Promise<void>;
  onResult(result: VoiceDeliveryResult): void;
}

export class VoiceDelivery {
  private blocked = false;
  private generation = 0;
  private pending: VoiceDeliveryRequest | undefined;

  public constructor(private readonly dependencies: VoiceDeliveryDependencies) {}

  public setBlocked(blocked: boolean): void {
    this.blocked = blocked;
    if (!blocked) this.flush();
  }

  public submit(request: VoiceDeliveryRequest): void {
    if (this.blocked) {
      this.pending = request;
      return;
    }
    this.dispatch(request);
  }

  public clear(): void {
    this.pending = undefined;
    this.generation += 1;
  }

  private flush(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    this.dispatch(pending);
  }

  private dispatch(request: VoiceDeliveryRequest): void {
    const identity = {
      sessionId: request.sessionId,
      captureId: request.captureId,
      turnId: request.turnId,
      revision: request.revision,
    };
    if (request.text.trim().length === 0) {
      this.dependencies.onResult({ kind: 'failed', ...identity, code: 'blank transcript' });
      return;
    }
    const generation = this.generation;
    const succeeded = (): void => {
      if (generation === this.generation) this.dependencies.onResult({ kind: 'delivered', ...identity });
    };
    const failed = (error: unknown): void => {
      if (generation === this.generation)
        this.dependencies.onResult({
          kind: 'failed',
          ...identity,
          code: error instanceof Error ? error.message : String(error),
        });
    };
    try {
      const admitted = request.intent
        ? this.dependencies.deliver(request.text, request.intent)
        : this.dependencies.deliver(request.text);
      if (admitted) void admitted.then(succeeded, failed);
      else succeeded();
    } catch (error) {
      this.dependencies.onResult({
        kind: 'failed',
        ...identity,
        code: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
