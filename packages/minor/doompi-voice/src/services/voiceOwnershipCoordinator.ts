import {
  VOICE_OWNERSHIP_LEASE_MS,
  VOICE_OWNERSHIP_PROTOCOL_VERSION,
  type BrowserVoiceOwnershipPayload,
  type VoiceOwnershipAcknowledgement,
  type VoiceOwnershipAction,
  type VoiceOwnershipCommand,
  type VoiceOwnershipRegistration,
  type VoiceOwnershipTarget,
} from '../types/voiceOwnership.ts';

interface Participant {
  sessionId: string;
  label: string;
  leaseId: string;
  revision: number;
  eligible: boolean;
  active: boolean;
  lastSeen: number;
}

export interface VoiceOwnershipCommandDelivery {
  send(sessionId: string, command: VoiceOwnershipCommand): Promise<VoiceOwnershipAcknowledgement>;
}

export type VoiceOwnershipSelectionPublisher = (payload: BrowserVoiceOwnershipPayload) => void;

export interface VoiceOwnershipCoordinatorOptions {
  leaseMs?: number;
  now(): number;
  createId(): string;
}

export class VoiceOwnershipCoordinator {
  private readonly participants = new Map<string, Participant>();
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private selectedSessionId: string | null = null;
  private operation: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly delivery: VoiceOwnershipCommandDelivery,
    private readonly publishSelection: VoiceOwnershipSelectionPublisher,
    options: VoiceOwnershipCoordinatorOptions,
  ) {
    this.leaseMs = options.leaseMs ?? VOICE_OWNERSHIP_LEASE_MS;
    this.now = () => options.now();
    this.createId = () => options.createId();
  }

  public update(sessionId: string, registration: VoiceOwnershipRegistration): void {
    this.prune();
    const previous = this.participants.get(sessionId);
    if (
      previous !== undefined &&
      previous.leaseId === registration.leaseId &&
      registration.revision < previous.revision
    )
      return;
    this.participants.set(sessionId, {
      sessionId,
      label: registration.label,
      leaseId: registration.leaseId,
      revision: registration.revision,
      eligible: registration.eligible,
      active: registration.active,
      lastSeen: this.now(),
    });
    this.reconcileSelection();
  }

  public remove(sessionId: string): void {
    this.participants.delete(sessionId);
    this.reconcileSelection();
  }

  public payload(): BrowserVoiceOwnershipPayload {
    this.prune();
    this.reconcileSelection();
    return {
      type: 'browser-media-session',
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      activeSessionId: this.selectedSessionId,
    };
  }

  public activate(sessionId: string): Promise<boolean> {
    return this.enqueue(() => this.activateNow(sessionId));
  }

  public handoff(sourceSessionId: string, targetHandle: string): Promise<boolean> {
    return this.enqueue(async () => {
      this.prune();
      const source = this.participants.get(sourceSessionId);
      if (source === undefined || !source.active) return false;
      const targetSessionId = this.targetsFor(sourceSessionId).find(
        (target) => target.handle === targetHandle,
      )?.sessionId;
      if (targetSessionId === undefined) return false;
      if (!(await this.sendAction(sourceSessionId, 'deactivate'))) return false;
      return this.activateNow(targetSessionId);
    });
  }

  public targetsFor(sourceSessionId: string): Array<VoiceOwnershipTarget & { sessionId: string }> {
    this.prune();
    const eligible = [...this.participants.values()]
      .filter((participant) => participant.sessionId !== sourceSessionId && participant.eligible)
      .sort((left, right) => left.label.localeCompare(right.label) || left.sessionId.localeCompare(right.sessionId));
    return eligible.map((participant, index) => ({
      sessionId: participant.sessionId,
      handle: this.handleFor(participant),
      label: participant.label,
      order: index + 1,
    }));
  }

  public catalog(sessionId: string): VoiceOwnershipTarget[] {
    return this.targetsFor(sessionId).map(({ sessionId: _sessionId, ...target }) => target);
  }

  public publishCatalogs(): Promise<void> {
    return this.enqueue(async () => {
      this.prune();
      const participants = [...this.participants.values()];
      for (const participant of participants) {
        const command: VoiceOwnershipCommand = {
          version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
          commandId: this.createId(),
          action: 'catalog',
          targets: this.catalog(participant.sessionId),
        };
        const acknowledgement = await this.delivery.send(participant.sessionId, command);
        this.applyAcknowledgement(participant.sessionId, acknowledgement);
      }
      this.reconcileSelection();
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async activateNow(sessionId: string): Promise<boolean> {
    this.prune();
    const target = this.participants.get(sessionId);
    if (target === undefined || !target.eligible) return false;
    const activeOthers = [...this.participants.values()]
      .filter((participant) => participant.active && participant.sessionId !== sessionId)
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    for (const participant of activeOthers) {
      if (!(await this.sendAction(participant.sessionId, 'deactivate'))) {
        await this.sendAction(sessionId, 'deactivate');
        this.reconcileSelection();
        return false;
      }
    }
    this.setSelected(sessionId);
    if (target.active) return true;
    if (await this.sendAction(sessionId, 'activate')) return true;
    this.reconcileSelection();
    return false;
  }

  private async sendAction(sessionId: string, action: Exclude<VoiceOwnershipAction, 'catalog'>): Promise<boolean> {
    const command: VoiceOwnershipCommand = {
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      commandId: this.createId(),
      action,
    };
    try {
      const acknowledgement = await this.delivery.send(sessionId, command);
      if (acknowledgement.commandId !== command.commandId || acknowledgement.action !== action) return false;
      this.applyAcknowledgement(sessionId, acknowledgement);
      return acknowledgement.ok && acknowledgement.active === (action === 'activate');
    } catch {
      return false;
    }
  }

  private applyAcknowledgement(sessionId: string, acknowledgement: VoiceOwnershipAcknowledgement): void {
    const participant = this.participants.get(sessionId);
    if (participant === undefined) return;
    participant.active = acknowledgement.active;
    participant.lastSeen = this.now();
  }

  private handleFor(participant: Participant): string {
    return participant.leaseId;
  }

  private prune(): void {
    const cutoff = this.now() - this.leaseMs;
    let changed = false;
    for (const [sessionId, participant] of this.participants) {
      if (participant.lastSeen >= cutoff) continue;
      this.participants.delete(sessionId);
      changed = true;
    }
    if (changed) this.reconcileSelection();
  }

  private reconcileSelection(): void {
    const selected =
      (this.selectedSessionId === null ? undefined : this.participants.get(this.selectedSessionId))?.active === true
        ? this.selectedSessionId
        : ([...this.participants.values()]
            .filter((participant) => participant.active)
            .sort((left, right) => left.sessionId.localeCompare(right.sessionId))[0]?.sessionId ?? null);
    this.setSelected(selected);
  }

  private setSelected(sessionId: string | null): void {
    if (this.selectedSessionId === sessionId) return;
    this.selectedSessionId = sessionId;
    this.publishSelection({
      type: 'browser-media-session',
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      activeSessionId: sessionId,
    });
  }
}
