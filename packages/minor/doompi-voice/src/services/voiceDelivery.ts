import type { AutonomousTurnIdentity } from './autonomousVoiceMachine.ts';

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
  deliver(text: string, intent?: VoiceDeliveryIntent): void;
  onResult(result: VoiceDeliveryResult): void;
}

export class VoiceDelivery {
  private blocked = false;
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
    try {
      if (request.intent) this.dependencies.deliver(request.text, request.intent);
      else this.dependencies.deliver(request.text);
      this.dependencies.onResult({ kind: 'delivered', ...identity });
    } catch (error) {
      this.dependencies.onResult({
        kind: 'failed',
        ...identity,
        code: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
