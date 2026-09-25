import type { AutoCaptureActivationState, IClock, TimerHandle } from '../../types';
import {
  VOICE_OWNERSHIP_PROTOCOL_VERSION,
  type VoiceOwnershipAcknowledgement,
  type VoiceOwnershipActivationRequest,
  type VoiceOwnershipCommand,
  type VoiceOwnershipHandoffRequest,
  type VoiceOwnershipRegistration,
  type VoiceOwnershipSessionSnapshot,
  type VoiceOwnershipTarget,
} from '../../types/voiceOwnership';

export interface SessionVoiceOwnershipController {
  state: AutoCaptureActivationState;
  readonly activationError?: string;
  activateVoice(): Promise<void>;
  deactivateVoice(reason?: 'stop' | 'handoff'): Promise<void>;
}

interface RuntimeBinding {
  leaseId: string;
  revision: number;
  active: boolean;
  label: string;
  labelSource?: () => string;
  eligible: boolean;
  controller: SessionVoiceOwnershipController;
}

type RuntimeBindingInput = Omit<RuntimeBinding, 'leaseId' | 'revision' | 'active' | 'label' | 'labelSource'> & {
  label: string | (() => string);
};

function ownershipLabel(value: string | (() => string), fallback: string): string {
  try {
    const label = (typeof value === 'function' ? value() : value).trim().slice(0, 80);
    return label || fallback;
  } catch {
    return fallback;
  }
}

/** Starting only reserves capture. Ownership needs usable media, which is reported as active. */
function isOwnershipActive(state: AutoCaptureActivationState): boolean {
  return state === 'active';
}

export class SessionVoiceOwnership {
  private binding: RuntimeBinding | undefined;
  private targets: VoiceOwnershipTarget[] = [];
  private catalogRevision: string | undefined;
  private prepared: { handoffId: string; controllerId: string; leaseId: string; revision: number } | undefined;
  private activationRequest: VoiceOwnershipActivationRequest | undefined;
  private handoffRequest: VoiceOwnershipHandoffRequest | undefined;
  private lastAcknowledgement: VoiceOwnershipAcknowledgement | undefined;
  private generation = 0;

  public register(input: RuntimeBindingInput): () => void {
    const { label, ...runtime } = input;
    const binding: RuntimeBinding = {
      ...runtime,
      label: ownershipLabel(label, 'Voice session'),
      ...(typeof label === 'function' ? { labelSource: label } : {}),
      leaseId: globalThis.crypto.randomUUID(),
      revision: 1,
      active: isOwnershipActive(input.controller.state),
    };
    this.cancelPending();
    this.targets = [];
    this.catalogRevision = undefined;
    this.lastAcknowledgement = undefined;
    this.binding = binding;
    return () => {
      if (this.binding !== binding) return;
      this.binding = undefined;
      this.targets = [];
      this.catalogRevision = undefined;
      this.cancelPending();
    };
  }

  public registration(): VoiceOwnershipRegistration | undefined {
    const binding = this.binding;
    if (binding === undefined) return undefined;
    if (binding.controller.state === 'disabled') this.handoffRequest = undefined;
    const active = isOwnershipActive(binding.controller.state);
    const label =
      binding.labelSource === undefined ? binding.label : ownershipLabel(binding.labelSource, binding.label);
    if (active !== binding.active || label !== binding.label) {
      binding.active = active;
      binding.label = label;
      binding.revision += 1;
    }
    return {
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      leaseId: binding.leaseId,
      revision: binding.revision,
      label: binding.label,
      eligible: binding.eligible,
      active,
    };
  }

  public snapshot(): VoiceOwnershipSessionSnapshot {
    const registration = this.registration();
    return {
      ...(registration === undefined ? {} : { registration }),
      targets: this.targets,
      ...(this.catalogRevision === undefined ? {} : { catalogRevision: this.catalogRevision }),
      ...(this.activationRequest === undefined ? {} : { activation: this.activationRequest }),
      ...(this.handoffRequest === undefined ? {} : { handoff: this.handoffRequest }),
      ...(this.lastAcknowledgement === undefined ? {} : { acknowledgement: this.lastAcknowledgement }),
    };
  }

  public requestActivation(): VoiceOwnershipActivationRequest | undefined {
    const binding = this.binding;
    if (binding === undefined || !binding.eligible || binding.controller.state !== 'disabled') return undefined;
    this.activationRequest = {
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      requestId: globalThis.crypto.randomUUID(),
    };
    return this.activationRequest;
  }

  /** Stop or session replacement withdraws authority before any asynchronous cleanup begins. */
  public cancelPending(): void {
    this.generation += 1;
    // Commands stamped before stop must not apply after a rapid reactivation.
    if (this.binding) this.binding.revision += 1;
    this.prepared = undefined;
    this.activationRequest = undefined;
    this.handoffRequest = undefined;
    this.lastAcknowledgement = undefined;
  }

  public clearActivationRequest(requestId: string): void {
    if (this.activationRequest?.requestId === requestId) this.activationRequest = undefined;
  }

  public handoff(order: number, catalogRevision = this.catalogRevision): VoiceOwnershipHandoffRequest | undefined {
    const binding = this.binding;
    if (binding?.controller.state !== 'active' || catalogRevision !== this.catalogRevision) return undefined;
    const target = this.targets.find((candidate) => candidate.order === order);
    if (target === undefined || catalogRevision === undefined) return undefined;
    this.handoffRequest = {
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      requestId: globalThis.crypto.randomUUID(),
      handle: target.handle,
      catalogRevision,
    };
    return this.handoffRequest;
  }

  public clearHandoffRequest(requestId: string): void {
    if (this.handoffRequest?.requestId === requestId) this.handoffRequest = undefined;
  }

  public async command(command: VoiceOwnershipCommand): Promise<VoiceOwnershipAcknowledgement> {
    const generation = this.generation;
    const previous = this.lastAcknowledgement;
    if (previous?.commandId === command.commandId) {
      return previous.action === command.action
        ? previous
        : this.ack(command, false, 'Voice ownership command id was reused.');
    }
    if (command.action === 'catalog') {
      this.targets = command.targets ?? [];
      this.catalogRevision = command.catalogRevision;
      return this.ack(command, true);
    }
    const binding = this.binding;
    const controller = binding?.controller;
    if (controller === undefined || binding === undefined)
      return this.ack(command, false, 'Voice runtime is unavailable.');
    const staged =
      command.handoffId === undefined
        ? undefined
        : {
            handoffId: command.handoffId,
            controllerId: command.controllerId!,
            leaseId: command.leaseId!,
            revision: command.revision!,
          };
    if (staged !== undefined && (staged.leaseId !== binding.leaseId || staged.revision !== binding.revision))
      return this.ack(command, false, 'Voice target incarnation changed.');
    if (command.action === 'deactivate' && staged !== undefined && this.handoffRequest?.requestId !== staged.handoffId)
      return this.ack(command, false, 'Voice handoff was cancelled.');
    try {
      if (command.action === 'prepare') {
        if (!binding.eligible || controller.state !== 'disabled')
          return this.ack(command, false, 'Voice target is not eligible for preparation.');
        if (
          this.prepared !== undefined &&
          (this.prepared.handoffId !== staged!.handoffId || this.prepared.controllerId !== staged!.controllerId)
        )
          return this.ack(command, false, 'Voice target is reserved by another controller.');
        this.prepared = staged;
        return this.ack(command, true);
      }
      if (command.action === 'readiness') {
        const ready = this.samePreparation(staged) && isOwnershipActive(controller.state);
        return this.ack(command, ready, ready ? undefined : 'Voice media is not ready.');
      }
      if (command.action === 'fence') {
        if (!this.samePreparation(staged)) return this.ack(command, true);
        this.prepared = undefined;
        if (controller.state !== 'disabled') await controller.deactivateVoice();
        return this.ack(command, !isOwnershipActive(controller.state));
      }
      if (command.action === 'activate') {
        this.activationRequest = undefined;
        if (staged !== undefined && !this.samePreparation(staged))
          return this.ack(command, false, 'Voice target preparation is stale.');
        if (staged === undefined && this.prepared !== undefined)
          return this.ack(command, false, 'Voice target is reserved by another controller.');
        if (!isOwnershipActive(controller.state)) await controller.activateVoice();
        if (generation !== this.generation) {
          await controller.deactivateVoice();
          return this.ack(command, false, 'Voice activation was cancelled.');
        }
        if (!isOwnershipActive(controller.state))
          return this.ack(command, false, controller.activationError ?? 'Autonomous voice did not activate.');
      } else {
        if (staged) this.activationRequest = undefined;
        else this.cancelPending();
        await controller.deactivateVoice(staged ? 'handoff' : 'stop');
        if (staged && generation !== this.generation) return this.ack(command, false, 'Voice handoff was cancelled.');
        if (staged) {
          this.handoffRequest = undefined;
          this.prepared = undefined;
        }
        if (isOwnershipActive(controller.state))
          return this.ack(command, false, 'Autonomous voice did not deactivate.');
      }
      return this.ack(command, true);
    } catch (error) {
      return this.ack(
        command,
        false,
        error instanceof Error ? error.message.slice(0, 300) : 'Voice ownership command failed.',
      );
    }
  }

  private samePreparation(
    staged: { handoffId: string; controllerId: string; leaseId: string; revision: number } | undefined,
  ): boolean {
    return (
      staged !== undefined &&
      this.prepared?.handoffId === staged.handoffId &&
      this.prepared.controllerId === staged.controllerId &&
      this.prepared.leaseId === staged.leaseId &&
      this.prepared.revision === staged.revision
    );
  }

  private ack(command: VoiceOwnershipCommand, ok: boolean, error?: string): VoiceOwnershipAcknowledgement {
    const acknowledgement: VoiceOwnershipAcknowledgement = {
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      commandId: command.commandId,
      action: command.action,
      ok,
      active: isOwnershipActive(this.binding?.controller.state ?? 'disabled'),
      ...(error === undefined ? {} : { error }),
    };
    this.lastAcknowledgement = acknowledgement;
    return acknowledgement;
  }
}

export interface VoiceOwnershipSessionHost {
  syncOwnership(snapshot: VoiceOwnershipSessionSnapshot): Promise<VoiceOwnershipCommand | undefined>;
}

export class SessionVoiceOwnershipBridge {
  private timer: TimerHandle | undefined;
  private operation: Promise<void> | undefined;
  private stopped = true;

  public constructor(
    private readonly ownership: SessionVoiceOwnership,
    private readonly host: VoiceOwnershipSessionHost,
    private readonly clock: Pick<IClock, 'setTimeout' | 'clear'>,
    private readonly intervalMs = 250,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly deferHandoff: () => boolean = () => false,
  ) {}

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clear(this.timer);
    this.timer = undefined;
  }

  public synchronize(): Promise<void> {
    if (this.operation !== undefined) return this.operation;
    const operation = this.performSync().finally(() => {
      this.operation = undefined;
    });
    this.operation = operation;
    return operation;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer !== undefined) this.clock.clear(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.synchronize()
        .catch((error: unknown) => this.onError(error))
        .finally(() => this.schedule(this.intervalMs));
    }, delay);
  }

  private syncSnapshot(): VoiceOwnershipSessionSnapshot {
    const snapshot = this.ownership.snapshot();
    return this.deferHandoff() ? { ...snapshot, handoff: undefined } : snapshot;
  }

  private async performSync(): Promise<void> {
    let command = await this.host.syncOwnership(this.syncSnapshot());
    for (let count = 0; command !== undefined && count < 8; count += 1) {
      await this.ownership.command(command);
      command = await this.host.syncOwnership(this.syncSnapshot());
    }
    if (command !== undefined) throw new Error('Voice ownership command synchronization limit exceeded.');
  }
}

export const sessionVoiceOwnership = new SessionVoiceOwnership();

export function registerSessionVoiceOwnership(input: {
  label: string | (() => string);
  eligible: boolean;
  controller: SessionVoiceOwnershipController;
}): () => void {
  return sessionVoiceOwnership.register(input);
}

export function voiceOwnershipLabel(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/u, '');
  const leaf = normalized.split(/[\\/]/u).at(-1);
  return (leaf || 'Voice session').slice(0, 80);
}
