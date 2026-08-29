import type { HubSessionScope } from '@agimon-ai/doompi-web-contracts';
import type { IClock } from '../types/index.ts';
import {
  VOICE_OWNERSHIP_MAX_TARGETS,
  VOICE_OWNERSHIP_PROTOCOL_VERSION,
  type VoiceOwnershipAcknowledgement,
  type VoiceOwnershipCommand,
  type VoiceOwnershipPhase,
  type VoiceOwnershipRegistration,
  type VoiceOwnershipView,
} from '../types/voiceOwnership.ts';

const VOICE_OWNERSHIP_STEP_TIMEOUT_MS = 15_000;
interface Participant {
  scope: HubSessionScope;
  registration: VoiceOwnershipRegistration;
  seenAt: number;
}
interface Transaction {
  generation: number;
  sourceId: string;
  targetId: string;
  source: Participant;
  target: Participant;
  mediaRebindStarted: boolean;
  cancelled: boolean;
  inFlight?: Promise<unknown>;
  inFlightController?: AbortController;
  rollbackOperation?: Promise<void>;
}
export interface VoiceOwnershipCoordinatorOptions {
  send(
    scope: HubSessionScope,
    command: VoiceOwnershipCommand,
    signal?: AbortSignal,
  ): Promise<VoiceOwnershipAcknowledgement | undefined>;
  rebindMedia?(
    source: HubSessionScope,
    target: HubSessionScope,
    epoch: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<void>;
  mediaReady?(target: HubSessionScope, epoch: string, generation: number, signal?: AbortSignal): Promise<void>;
  clock: Pick<IClock, 'setTimeout' | 'clear'>;
  now(): number;
  leaseMs?: number;
  stepTimeoutMs?: number;
  onNotice?: (message: string) => void;
}

export class VoiceOwnershipCoordinator {
  private readonly participants = new Map<string, Participant>();
  private readonly handles = new Map<string, Map<string, string>>();
  private ownerId: string | undefined;
  private transaction: Transaction | undefined;
  private readonly epoch = globalThis.crypto.randomUUID();
  private generation = 0;
  private revision = 0;

  public constructor(private readonly options: VoiceOwnershipCoordinatorOptions) {}

  public update(scope: HubSessionScope, registration: VoiceOwnershipRegistration): void {
    const previous = this.participants.get(scope.sessionId);
    if (
      previous &&
      previous.registration.leaseId === registration.leaseId &&
      registration.revision < previous.registration.revision
    )
      return;
    const changed = previous === undefined || JSON.stringify(previous.registration) !== JSON.stringify(registration);
    this.participants.set(scope.sessionId, { scope, registration, seenAt: this.options.now() });
    if (this.ownerId === undefined && registration.active && registration.eligible) {
      this.ownerId = scope.sessionId;
      this.generation += 1;
    } else if (
      registration.active &&
      this.ownerId !== scope.sessionId &&
      this.transaction?.targetId !== scope.sessionId
    ) {
      void this.forceInactive(scope);
    }
    this.expire();
    if (changed) void this.publishViews();
  }

  public remove(sessionId: string): void {
    const transaction = this.transaction;
    const transactionParticipant = transaction?.sourceId === sessionId || transaction?.targetId === sessionId;
    if (transactionParticipant)
      void this.rollback(
        transaction?.sourceId === sessionId
          ? 'Voice transfer source disconnected.'
          : 'Voice transfer target disconnected.',
      );
    this.participants.delete(sessionId);
    this.handles.delete(sessionId);
    if (transaction?.sourceId === sessionId) this.ownerId = undefined;
    else if (!transactionParticipant && this.ownerId === sessionId) {
      this.ownerId = undefined;
      this.generation += 1;
      this.revision = 0;
    }
  }

  public view(sessionId: string): VoiceOwnershipView {
    this.expire();
    const owner = this.ownerId === sessionId;
    const targets = owner && this.transaction === undefined ? this.targetsFor(sessionId) : [];
    return {
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      epoch: this.epoch,
      generation: this.generation,
      revision: this.revision,
      owner,
      transaction: this.transaction !== undefined,
      targets,
    };
  }

  public async transfer(sourceId: string, handle: string): Promise<boolean> {
    this.expire();
    if (this.transaction !== undefined || this.ownerId !== sourceId) return false;
    const targetId = this.handles.get(sourceId)?.get(handle);
    if (targetId === undefined || !this.eligibleTarget(sourceId, targetId)) return false;
    const source = this.participants.get(sourceId);
    const target = this.participants.get(targetId);
    if (!source || !target) return false;
    const transaction: Transaction = {
      generation: ++this.generation,
      sourceId,
      targetId,
      source,
      target,
      mediaRebindStarted: false,
      cancelled: false,
    };
    this.revision = 0;
    this.transaction = transaction;
    try {
      await this.runStep(transaction, (signal) => this.publishViews(signal));
      this.requireCurrent(transaction);
      await this.runStep(transaction, (signal) => this.requireAck(target, 'prepare', false, signal));
      this.requireCurrent(transaction);
      await this.runStep(transaction, (signal) => this.requireAck(source, 'quiesce', true, signal));
      this.requireCurrent(transaction);
      if (
        (source.registration.requiresBrowserBind || target.registration.requiresBrowserBind) &&
        this.options.rebindMedia
      ) {
        transaction.mediaRebindStarted = true;
        await this.runStep(transaction, (signal) =>
          this.options.rebindMedia!(source.scope, target.scope, this.epoch, transaction.generation, signal),
        );
        this.requireCurrent(transaction);
      }
      const activated = await this.runStep(transaction, (signal) => this.requireAck(target, 'activate', false, signal));
      this.requireCurrent(transaction);
      if (activated.listening !== true) throw new Error('Target capture did not reach listening state.');
      if (target.registration.requiresBrowserBind && this.options.mediaReady) {
        await this.runStep(transaction, (signal) =>
          this.options.mediaReady!(target.scope, this.epoch, transaction.generation, signal),
        );
        this.requireCurrent(transaction);
      }
      await this.runStep(transaction, (signal) => this.requireAck(target, 'commit', false, signal));
      this.requireCurrent(transaction);
      await this.runStep(transaction, (signal) => this.requireAck(source, 'commit', true, signal));
      this.requireCurrent(transaction);
      this.ownerId = targetId;
      this.transaction = undefined;
      await this.publishViews();
      return true;
    } catch (error) {
      this.options.onNotice?.(
        `voice ownership transfer rolled back (${error instanceof Error ? error.message : String(error)})`,
      );
      await this.rollback('Voice transfer failed.');
      return false;
    }
  }

  private requireCurrent(transaction: Transaction): void {
    if (this.transaction !== transaction || transaction.cancelled)
      throw new Error('Voice ownership transaction is stale.');
  }

  private async runStep<T>(transaction: Transaction, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const operation = this.runBounded(run, controller);
    transaction.inFlight = operation;
    transaction.inFlightController = controller;
    try {
      return await operation;
    } finally {
      if (transaction.inFlight === operation) {
        transaction.inFlight = undefined;
        transaction.inFlightController = undefined;
      }
    }
  }

  private runBounded<T>(run: (signal: AbortSignal) => Promise<T>, controller = new AbortController()): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeout = this.options.clock.setTimeout(
        () => controller.abort(new Error('Voice ownership step timed out.')),
        this.options.stepTimeoutMs ?? VOICE_OWNERSHIP_STEP_TIMEOUT_MS,
      );
      const cleanup = (): void => {
        this.options.clock.clear(timeout);
        controller.signal.removeEventListener('abort', aborted);
      };
      const aborted = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error('Voice ownership step aborted.'),
        );
      };
      controller.signal.addEventListener('abort', aborted, { once: true });
      void Promise.resolve()
        .then(() => run(controller.signal))
        .then(
          (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          },
        );
    });
  }

  private rollback(reason: string): Promise<void> {
    const transaction = this.transaction;
    if (transaction === undefined) return Promise.resolve();
    transaction.cancelled = true;
    transaction.inFlightController?.abort(new Error(reason));
    transaction.rollbackOperation ??= this.finishRollback(transaction);
    return transaction.rollbackOperation;
  }

  private async finishRollback(transaction: Transaction): Promise<void> {
    await transaction.inFlight?.catch(() => undefined);
    this.ownerId = undefined;
    await this.sendBestEffort(transaction.target, 'abort', false);
    if (transaction.mediaRebindStarted && this.options.rebindMedia)
      await this.runBounded((signal) =>
        this.options.rebindMedia!(
          transaction.target.scope,
          transaction.source.scope,
          this.epoch,
          transaction.generation,
          signal,
        ),
      ).catch(() => undefined);
    const resumed = await this.sendBestEffort(transaction.source, 'resume', true);
    this.ownerId =
      resumed?.listening === true && this.participants.has(transaction.sourceId) ? transaction.sourceId : undefined;
    if (this.transaction === transaction) this.transaction = undefined;
    await this.publishViews();
  }

  private async forceInactive(participant: HubSessionScope): Promise<void> {
    const held = this.participants.get(participant.sessionId);
    if (held === undefined) return;
    await this.sendBestEffort(held, 'abort', false);
  }

  private targetsFor(sourceId: string): Array<{ handle: string; label: string }> {
    let sourceHandles = this.handles.get(sourceId);
    if (sourceHandles === undefined) {
      sourceHandles = new Map();
      this.handles.set(sourceId, sourceHandles);
    }
    const eligible = [...this.participants.entries()]
      .filter(([targetId]) => this.eligibleTarget(sourceId, targetId))
      .sort((left, right) => left[1].registration.label.localeCompare(right[1].registration.label))
      .slice(0, VOICE_OWNERSHIP_MAX_TARGETS);
    const live = new Set(eligible.map(([targetId]) => targetId));
    for (const [handle, targetId] of sourceHandles) if (!live.has(targetId)) sourceHandles.delete(handle);
    return eligible.map(([targetId, participant]) => {
      let handle = [...sourceHandles].find((entry) => entry[1] === targetId)?.[0];
      if (handle === undefined) {
        handle = globalThis.crypto.randomUUID();
        sourceHandles!.set(handle, targetId);
      }
      return { handle, label: participant.registration.label };
    });
  }

  private eligibleTarget(sourceId: string, targetId: string): boolean {
    const target = this.participants.get(targetId);
    return targetId !== sourceId && target !== undefined && target.registration.eligible && !target.registration.active;
  }

  private expire(): void {
    const now = this.options.now();
    const leaseMs = this.options.leaseMs ?? 15_000;
    for (const [sessionId, participant] of this.participants)
      if (now - participant.seenAt > leaseMs) this.remove(sessionId);
  }

  private async requireAck(
    participant: Participant,
    phase: VoiceOwnershipPhase,
    source: boolean,
    signal?: AbortSignal,
  ): Promise<VoiceOwnershipAcknowledgement> {
    const command = this.command(phase, source, participant.scope.sessionId);
    const acknowledgement = await this.options.send(participant.scope, command, signal);
    if (
      !acknowledgement ||
      acknowledgement.version !== VOICE_OWNERSHIP_PROTOCOL_VERSION ||
      acknowledgement.epoch !== command.epoch ||
      acknowledgement.generation !== command.generation ||
      acknowledgement.revision !== command.revision ||
      acknowledgement.phase !== phase ||
      !acknowledgement.ok
    )
      throw new Error(`Invalid or failed ${phase} acknowledgement.`);
    return acknowledgement;
  }

  private async sendBestEffort(
    participant: Participant,
    phase: VoiceOwnershipPhase,
    source: boolean,
  ): Promise<VoiceOwnershipAcknowledgement | undefined> {
    try {
      return await this.runBounded((signal) => this.requireAck(participant, phase, source, signal));
    } catch {
      return undefined;
    }
  }

  private command(phase: VoiceOwnershipPhase, source: boolean, sessionId: string): VoiceOwnershipCommand {
    this.revision += 1;
    return {
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      epoch: this.epoch,
      generation: this.generation,
      revision: this.revision,
      phase,
      source,
      catalog: this.view(sessionId),
    };
  }

  private async publishViews(signal?: AbortSignal): Promise<void> {
    await Promise.all(
      [...this.participants.values()].map(async (participant) => {
        const command = this.command(
          'prepare',
          this.ownerId === participant.scope.sessionId,
          participant.scope.sessionId,
        );
        const send = signal
          ? this.options.send(participant.scope, command, signal)
          : this.runBounded((boundedSignal) => this.options.send(participant.scope, command, boundedSignal));
        await send.catch(() => undefined);
      }),
    );
  }
}
