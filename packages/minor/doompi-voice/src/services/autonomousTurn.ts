import type { IClock } from '../types/index.ts';
import type { AutonomousTurnIdentity } from './autonomousVoiceMachine.ts';

export type AutonomousTurnNonceFactory = () => string;

function defaultNonce(): string {
  return globalThis.crypto.randomUUID();
}

export class AutonomousTurnIdentityFactory {
  private sequence = 0;
  private readonly nonce: string;

  public constructor(
    private readonly clock: IClock,
    nonceFactory: AutonomousTurnNonceFactory = defaultNonce,
  ) {
    const nonce = nonceFactory().trim();
    if (!nonce) throw new Error('Autonomous voice identity nonce must not be empty.');
    this.nonce = nonce;
  }

  public createSession(): string {
    return this.identifier('auto-session');
  }

  public createTurn(sessionId: string): AutonomousTurnIdentity {
    return {
      sessionId,
      captureId: this.identifier('capture'),
      turnId: this.identifier('turn'),
    };
  }

  private identifier(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.clock.now()}-${this.nonce}-${this.sequence}`;
  }
}
