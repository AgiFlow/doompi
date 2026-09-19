import {
  VOICE_OWNERSHIP_LEASE_MS,
  VOICE_OWNERSHIP_PROTOCOL_VERSION,
  type BrowserVoiceOwnershipPayload,
  type VoiceOwnershipAcknowledgement,
  type VoiceOwnershipAction,
  type VoiceOwnershipCommand,
  type VoiceOwnershipRegistration,
  type VoiceOwnershipTarget,
} from '../../types/voiceOwnership';

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
  controllerId?: string;
}

export class VoiceOwnershipCoordinator {
  private readonly participants = new Map<string, Participant>();
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly controllerId: string;
  private selectedSessionId: string | null = null;
  private operation: Promise<unknown> = Promise.resolve();
  private catalogGeneration = 0;

  public constructor(
    private readonly delivery: VoiceOwnershipCommandDelivery,
    private readonly publishSelection: VoiceOwnershipSelectionPublisher,
    options: VoiceOwnershipCoordinatorOptions,
  ) {
    this.leaseMs = options.leaseMs ?? VOICE_OWNERSHIP_LEASE_MS;
    this.now = () => options.now();
    this.createId = () => options.createId();
    this.controllerId = options.controllerId ?? this.createId();
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
    const changed =
      previous === undefined ||
      previous.leaseId !== registration.leaseId ||
      previous.revision !== registration.revision ||
      previous.label !== registration.label ||
      previous.eligible !== registration.eligible ||
      previous.active !== registration.active;
    this.participants.set(sessionId, {
      sessionId,
      label: registration.label,
      leaseId: registration.leaseId,
      revision: registration.revision,
      eligible: registration.eligible,
      active: registration.active,
      lastSeen: this.now(),
    });
    if (changed) this.catalogGeneration += 1;
    this.reconcileSelection();
  }

  public remove(sessionId: string): void {
    if (this.participants.delete(sessionId)) this.catalogGeneration += 1;
    this.reconcileSelection();
  }

  public registration(sessionId: string): VoiceOwnershipRegistration | undefined {
    this.prune();
    const participant = this.participants.get(sessionId);
    return participant === undefined
      ? undefined
      : {
          version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
          leaseId: participant.leaseId,
          revision: participant.revision,
          label: participant.label,
          eligible: participant.eligible,
          active: participant.active,
        };
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

  public handoff(
    sourceSessionId: string,
    targetHandle: string,
    catalogRevision = this.catalogRevision(),
  ): Promise<boolean> {
    return this.enqueue(async () => {
      this.prune();
      const source = this.participants.get(sourceSessionId);
      if (source === undefined || !source.active || catalogRevision !== this.catalogRevision()) return false;
      const target = this.targetsFor(sourceSessionId).find((candidate) => candidate.handle === targetHandle);
      if (target === undefined) return false;
      const participant = this.participants.get(target.sessionId);
      if (participant === undefined) return false;
      const handoffId = this.createId();
      const staged = {
        handoffId,
        controllerId: this.controllerId,
        leaseId: participant.leaseId,
        revision: participant.revision,
      };
      if (!(await this.sendAction(target.sessionId, 'prepare', staged))) return false;
      if (!this.matches(target.sessionId, participant)) {
        await this.sendAction(target.sessionId, 'fence', staged);
        return false;
      }
      if (!(await this.sendAction(sourceSessionId, 'deactivate'))) {
        await this.sendAction(target.sessionId, 'fence', staged);
        return false;
      }
      if (!this.matches(target.sessionId, participant)) {
        await this.sendAction(target.sessionId, 'fence', staged);
        this.reconcileSelection();
        return false;
      }
      this.setSelected(target.sessionId);
      if (!(await this.sendAction(target.sessionId, 'activate', staged))) {
        await this.sendAction(target.sessionId, 'fence', staged);
        this.reconcileSelection();
        return false;
      }
      if (!(await this.sendAction(target.sessionId, 'readiness', staged))) {
        await this.sendAction(target.sessionId, 'fence', staged);
        this.reconcileSelection();
        return false;
      }
      return true;
    });
  }

  public targetsFor(sourceSessionId: string): Array<VoiceOwnershipTarget & { sessionId: string }> {
    this.prune();
    const eligible = [...this.participants.values()]
      .filter((participant) => participant.sessionId !== sourceSessionId && participant.eligible && !participant.active)
      .sort((left, right) => left.label.localeCompare(right.label) || left.sessionId.localeCompare(right.sessionId));
    return eligible.map((participant, index) => ({
      sessionId: participant.sessionId,
      handle: this.handleFor(participant),
      label: participant.label,
      order: index + 1,
    }));
  }

  public catalogRevision(): string {
    return `catalog-${String(this.catalogGeneration)}`;
  }

  public catalog(sessionId: string): VoiceOwnershipTarget[] {
    return this.targetsFor(sessionId).map(({ sessionId: _sessionId, ...target }) => target);
  }

  public publishCatalogs(sessionIds?: readonly string[]): Promise<void> {
    return this.enqueue(async () => {
      this.prune();
      const participants =
        sessionIds === undefined
          ? [...this.participants.values()]
          : sessionIds.flatMap((sessionId) => {
              const participant = this.participants.get(sessionId);
              return participant === undefined ? [] : [participant];
            });
      for (const participant of participants) {
        const command: VoiceOwnershipCommand = {
          version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
          commandId: this.createId(),
          action: 'catalog',
          targets: this.catalog(participant.sessionId),
          catalogRevision: this.catalogRevision(),
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
      .filter(
        (participant) =>
          participant.active && participant.sessionId !== sessionId && !participant.sessionId.startsWith('peer/'),
      )
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

  private async sendAction(
    sessionId: string,
    action: Exclude<VoiceOwnershipAction, 'catalog'>,
    staged?: Pick<VoiceOwnershipCommand, 'handoffId' | 'controllerId' | 'leaseId' | 'revision'>,
  ): Promise<boolean> {
    const command: VoiceOwnershipCommand = {
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      commandId: this.createId(),
      action,
      ...staged,
    };
    try {
      const acknowledgement = await this.delivery.send(sessionId, command);
      if (acknowledgement.commandId !== command.commandId || acknowledgement.action !== action) return false;
      this.applyAcknowledgement(sessionId, acknowledgement);
      const expectedActive = action === 'activate' || action === 'readiness';
      return acknowledgement.ok && acknowledgement.active === expectedActive;
    } catch {
      return false;
    }
  }

  private matches(sessionId: string, expected: Participant): boolean {
    const current = this.participants.get(sessionId);
    return (
      current !== undefined &&
      current.leaseId === expected.leaseId &&
      current.revision === expected.revision &&
      current.eligible
    );
  }

  private applyAcknowledgement(sessionId: string, acknowledgement: VoiceOwnershipAcknowledgement): void {
    const participant = this.participants.get(sessionId);
    if (participant === undefined) return;
    participant.active = acknowledgement.active;
    participant.lastSeen = this.now();
  }

  private handleFor(participant: Participant): string {
    return `${participant.leaseId}:${String(participant.revision)}`;
  }

  private prune(): void {
    const cutoff = this.now() - this.leaseMs;
    let changed = false;
    for (const [sessionId, participant] of this.participants) {
      if (participant.lastSeen >= cutoff) continue;
      this.participants.delete(sessionId);
      changed = true;
    }
    if (changed) {
      this.catalogGeneration += 1;
      this.reconcileSelection();
    }
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
