import type { AutoCaptureActivationState, AutoCaptureUi } from '../types/index.ts';
import {
  VOICE_OWNERSHIP_PROTOCOL_VERSION,
  type VoiceOwnershipAcknowledgement,
  type VoiceOwnershipCommand,
  type VoiceOwnershipRegistration,
  type VoiceOwnershipTransferRequest,
  type VoiceOwnershipView,
} from '../types/voiceOwnership.ts';

export interface SessionVoiceOwnershipController {
  state: AutoCaptureActivationState;
  prepareVoiceTransfer(): Promise<void>;
  quiesceVoiceTransfer(): Promise<void>;
  activateVoiceTransfer(): Promise<void>;
  abortVoiceTransfer(): Promise<void>;
  resumeVoiceTransfer(): Promise<void>;
}

interface RuntimeBinding {
  leaseId: string;
  revision: number;
  active: boolean;
  label: string;
  eligible: boolean;
  requiresBrowserBind: boolean;
  controller: SessionVoiceOwnershipController;
}

export class SessionVoiceOwnership {
  private binding: RuntimeBinding | undefined;
  private view: VoiceOwnershipView = {
    version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
    epoch: 'uninitialized',
    generation: 0,
    revision: 0,
    owner: false,
    transaction: false,
    targets: [],
  };
  private request: VoiceOwnershipTransferRequest | undefined;
  private lastAcknowledgement: VoiceOwnershipAcknowledgement | undefined;
  private readonly retiredEpochs = new Set<string>();

  public register(input: Omit<RuntimeBinding, 'leaseId' | 'revision' | 'active'>): () => void {
    const binding: RuntimeBinding = {
      ...input,
      leaseId: globalThis.crypto.randomUUID(),
      revision: 1,
      active: input.controller.state === 'active',
    };
    this.binding = binding;
    return () => {
      if (this.binding === binding) this.binding = undefined;
    };
  }

  public registration(): VoiceOwnershipRegistration | undefined {
    const binding = this.binding;
    if (binding === undefined) return undefined;
    const active = binding.controller.state === 'active';
    if (active !== binding.active) {
      binding.active = active;
      binding.revision += 1;
    }
    return {
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      leaseId: binding.leaseId,
      revision: binding.revision,
      label: binding.label,
      eligible: binding.eligible,
      active,
      requiresBrowserBind: binding.requiresBrowserBind,
    };
  }

  public snapshot(): {
    registration?: VoiceOwnershipRegistration;
    view: VoiceOwnershipView;
    request?: VoiceOwnershipTransferRequest;
    acknowledgement?: VoiceOwnershipAcknowledgement;
  } {
    const registration = this.registration();
    return {
      ...(registration === undefined ? {} : { registration }),
      view: this.view,
      ...(this.request === undefined ? {} : { request: this.request }),
      ...(this.lastAcknowledgement === undefined ? {} : { acknowledgement: this.lastAcknowledgement }),
    };
  }

  public transfer(handle: string): VoiceOwnershipTransferRequest | undefined {
    if (!this.view.owner || this.view.transaction || !this.view.targets.some((target) => target.handle === handle))
      return undefined;
    this.request = { version: VOICE_OWNERSHIP_PROTOCOL_VERSION, requestId: globalThis.crypto.randomUUID(), handle };
    return this.request;
  }

  public clearRequest(requestId: string): void {
    if (this.request?.requestId === requestId) this.request = undefined;
  }

  public async command(command: VoiceOwnershipCommand): Promise<VoiceOwnershipAcknowledgement> {
    const previous = this.lastAcknowledgement;
    if (
      previous &&
      previous.epoch === command.epoch &&
      previous.generation === command.generation &&
      previous.revision === command.revision &&
      previous.phase === command.phase
    )
      return previous;
    if (!this.acceptEpoch(command.epoch)) return this.ack(command, false, 'Stale voice ownership epoch.');
    if (
      command.generation < this.view.generation ||
      (command.generation === this.view.generation && command.revision < this.view.revision)
    ) {
      return this.ack(command, false, 'Stale voice ownership command.');
    }
    if (command.catalog) {
      this.view = command.catalog;
      if (command.catalog.transaction) this.request = undefined;
    }
    const controller = this.binding?.controller;
    if (controller === undefined) return this.ack(command, false, 'Voice runtime is unavailable.');
    try {
      if (command.phase === 'prepare') await controller.prepareVoiceTransfer();
      else if (command.phase === 'quiesce') await controller.quiesceVoiceTransfer();
      else if (command.phase === 'activate') await controller.activateVoiceTransfer();
      else if (command.phase === 'abort') await controller.abortVoiceTransfer();
      else if (command.phase === 'resume') await controller.resumeVoiceTransfer();
      const listening =
        command.phase === 'activate' || command.phase === 'resume' ? controller.state === 'active' : undefined;
      if ((command.phase === 'activate' || command.phase === 'resume') && !listening)
        return this.ack(command, false, 'Fresh voice capture is not listening.');
      return this.ack(command, true, undefined, listening);
    } catch (error) {
      return this.ack(
        command,
        false,
        error instanceof Error ? error.message.slice(0, 300) : 'Voice ownership command failed.',
      );
    }
  }

  private ack(
    command: VoiceOwnershipCommand,
    ok: boolean,
    error?: string,
    listening?: boolean,
  ): VoiceOwnershipAcknowledgement {
    const acknowledgement: VoiceOwnershipAcknowledgement = {
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      epoch: command.epoch,
      generation: command.generation,
      revision: command.revision,
      phase: command.phase,
      ok,
      ...(listening === undefined ? {} : { listening }),
      ...(error === undefined ? {} : { error }),
    };
    this.lastAcknowledgement = acknowledgement;
    return acknowledgement;
  }

  private acceptEpoch(epoch: string): boolean {
    if (epoch === this.view.epoch) return true;
    if (this.retiredEpochs.has(epoch)) return false;
    if (this.view.epoch !== 'uninitialized') this.retiredEpochs.add(this.view.epoch);
    this.view = {
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      epoch,
      generation: 0,
      revision: 0,
      owner: false,
      transaction: false,
      targets: [],
    };
    this.request = undefined;
    this.lastAcknowledgement = undefined;
    return true;
  }
}

export const sessionVoiceOwnership = new SessionVoiceOwnership();

export function registerSessionVoiceOwnership(input: {
  label: string;
  eligible: boolean;
  requiresBrowserBind: boolean;
  controller: SessionVoiceOwnershipController;
}): () => void {
  return sessionVoiceOwnership.register(input);
}

export function voiceOwnershipLabel(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/u, '');
  const leaf = normalized.split(/[\\/]/u).at(-1);
  return (leaf || 'Voice session').slice(0, 80);
}

export type { AutoCaptureUi };
