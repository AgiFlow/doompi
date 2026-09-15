export interface DomainSwitchHandoffIdentity {
  readonly sessionId: string;
  readonly hostGeneration: string;
}

export interface DomainSwitchHandoffRequest extends DomainSwitchHandoffIdentity {
  readonly hostGeneration: string;
  readonly operationId: string;
  readonly domains: readonly string[];
  readonly reloadHandoffToken: string;
}

export interface DomainSwitchHandoff extends DomainSwitchHandoffRequest {
  readonly token: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * The TTL-bounded store standing between the voice tool and the command.
 *
 * The voice tool cannot reload the session itself, so it parks the validated
 * selection here and sends the command an opaque token. Every owner gets its own
 * generation so two stores sharing the process registry cannot read each other's
 * records.
 */
export interface DomainSwitchHandoffStore {
  readonly ownerGeneration: string;
  issue(request: DomainSwitchHandoffRequest): DomainSwitchHandoff;
  consume(token: string, identity: DomainSwitchHandoffIdentity): DomainSwitchHandoff | undefined;
  discard(token: string, identity: DomainSwitchHandoffIdentity): boolean;
  clearSession(sessionId: string): number;
  dispose(): number;
}
