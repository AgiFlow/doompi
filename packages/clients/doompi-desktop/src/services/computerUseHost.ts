import type {
  ComputerUseBackend,
  ComputerUseDesktopRequest,
  ComputerUseDesktopResponse,
} from '../types/computerUse.ts';
import { COMPUTER_USE_IPC_RESPONSE, COMPUTER_USE_IPC_VERSION } from '../types/computerUse.ts';

const DEFAULT_DURATION_SECONDS = 300;
const MAX_DURATION_SECONDS = 1800;
const MAX_CONFIRMATION_AGE_MS = 2 * 60 * 1000;
const MAX_USED_CONFIRMATIONS = 1024;
export interface LocalActivationConfirmation {
  readonly applicationName: string;
  readonly windowTitle: string;
  readonly durationSeconds: number;
}

type ValidatedActivation = {
  readonly requestId: string;
  readonly callerLocality: 'local' | 'remote';
  readonly confirmation: LocalActivationConfirmation;
};

type ActiveGrant = {
  readonly sessionId: string;
  readonly grantId: string;
  readonly runId: string;
  readonly expiresAt: number;
  nextSequence: number;
};

export interface ComputerUseHostOptions {
  readonly backend: ComputerUseBackend;
  readonly hostGeneration: string;
  readonly now: () => number;
  readonly newId: () => string;
  readonly confirmLocalActivation?: (confirmation: LocalActivationConfirmation) => Promise<boolean>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function durationOf(payload: unknown): number {
  const duration = record(payload)?.durationSeconds ?? DEFAULT_DURATION_SECONDS;
  if (!Number.isInteger(duration) || (duration as number) < 1 || (duration as number) > MAX_DURATION_SECONDS) {
    throw new Error(`durationSeconds must be between 1 and ${String(MAX_DURATION_SECONDS)}.`);
  }
  return duration as number;
}

function grantIdOf(payload: unknown): string | undefined {
  const grantId = record(payload)?.grantId;
  return typeof grantId === 'string' && grantId !== '' ? grantId : undefined;
}

function sequenceOf(payload: unknown): number {
  const sequence = record(payload)?.sequence;
  if (!Number.isInteger(sequence) || (sequence as number) < 1)
    throw new Error('A positive action sequence is required.');
  return sequence as number;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum)
    throw new Error(`${name} must be a non-empty string no longer than ${String(maximum)} characters.`);
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label = 'action'): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(`The ${label} contains unsupported fields.`);
}

function actionOf(payload: unknown): Record<string, unknown> {
  const action = record(record(payload)?.action);
  if (action === undefined) throw new Error('A semantic action is required.');
  const kind = action.kind;
  boundedString(action.snapshotId, 'snapshotId', 256);
  boundedString(action.elementRef, 'elementRef', 256);
  if (kind === 'press') {
    exactKeys(action, ['kind', 'snapshotId', 'elementRef']);
    return action;
  }
  if (kind === 'set_value') {
    exactKeys(action, ['kind', 'snapshotId', 'elementRef', 'value']);
    if (typeof action.value !== 'string' || action.value.length > 16_384) throw new Error('value is too long.');
    return action;
  }
  if (kind === 'scroll') {
    exactKeys(action, ['kind', 'snapshotId', 'elementRef', 'direction', 'amount']);
    if (!['up', 'down', 'left', 'right'].includes(action.direction as string))
      throw new Error('A supported semantic scroll direction is required.');
    if (action.amount !== 'line' && action.amount !== 'page')
      throw new Error('A supported semantic scroll amount is required.');
    return action;
  }
  throw new Error('Only press, set_value, and scroll actions are supported.');
}
function activationRequest(payload: unknown, now: number): ValidatedActivation {
  const activation = record(payload);
  if (activation === undefined) throw new Error('A frozen activation confirmation is required.');
  exactKeys(
    activation,
    ['requestId', 'target', 'durationSeconds', 'createdAt', 'confirmationExpiresAt', 'caller'],
    'activation',
  );
  const requestId = boundedString(activation.requestId, 'requestId', 128);
  durationOf(activation);
  if (!Number.isInteger(activation.createdAt) || !Number.isInteger(activation.confirmationExpiresAt))
    throw new Error('Activation confirmation timestamps are required.');
  const createdAt = activation.createdAt as number;
  const confirmationExpiresAt = activation.confirmationExpiresAt as number;
  if (
    createdAt > now + 5_000 ||
    confirmationExpiresAt <= now ||
    confirmationExpiresAt <= createdAt ||
    confirmationExpiresAt - createdAt > MAX_CONFIRMATION_AGE_MS
  )
    throw new Error('The activation confirmation is stale or invalid.');

  const target = record(activation.target);
  if (target === undefined) throw new Error('A verified application window target is required.');
  exactKeys(target, ['bundleId', 'applicationName', 'processId', 'windowId', 'windowTitle'], 'target');
  boundedString(target.bundleId, 'bundleId', 512);
  boundedString(target.applicationName, 'applicationName', 256);
  boundedString(target.windowId, 'windowId', 256);
  boundedString(target.windowTitle, 'windowTitle', 1024);
  if (!Number.isInteger(target.processId) || (target.processId as number) < 1)
    throw new Error('A positive target processId is required.');

  const caller = record(activation.caller);
  if (caller === undefined) throw new Error('Trusted activation caller metadata is required.');
  if (caller.locality === 'local') {
    exactKeys(caller, ['locality', 'stepUp'], 'caller');
    if (caller.stepUp !== 'not-required') throw new Error('Local caller metadata is invalid.');
  } else if (caller.locality === 'remote') {
    exactKeys(caller, ['locality', 'deviceId', 'stepUp'], 'caller');
    boundedString(caller.deviceId, 'deviceId', 256);
    if (caller.stepUp !== 'verified' && caller.stepUp !== 'unavailable')
      throw new Error('Remote activation requires trusted step-up metadata.');
  } else {
    throw new Error('Trusted activation caller metadata is required.');
  }
  return {
    requestId,
    callerLocality: caller.locality as 'local' | 'remote',
    confirmation: {
      applicationName: target.applicationName as string,
      windowTitle: target.windowTitle as string,
      durationSeconds: durationOf(activation),
    },
  };
}

export class ComputerUseHost {
  readonly #backend: ComputerUseBackend;
  readonly #hostGeneration: string;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #confirmLocalActivation: ((confirmation: LocalActivationConfirmation) => Promise<boolean>) | undefined;
  #active: ActiveGrant | undefined;
  #queue: Promise<void> = Promise.resolve();
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #usedConfirmations = new Set<string>();
  readonly #confirmationOrder: string[] = [];
  #revoked = false;
  #revocationGeneration = 0;

  constructor(options: ComputerUseHostOptions) {
    this.#backend = options.backend;
    this.#hostGeneration = options.hostGeneration;
    this.#now = options.now;
    this.#newId = options.newId;
    this.#confirmLocalActivation = options.confirmLocalActivation;
  }

  async handle(request: ComputerUseDesktopRequest, signal?: AbortSignal): Promise<ComputerUseDesktopResponse> {
    return await new Promise((resolve) => {
      this.#queue = this.#queue.then(async () => resolve(await this.#handle(request, signal)));
    });
  }

  async stopActive(reason = 'desktop_emergency_stop'): Promise<boolean> {
    const operation = this.#queue.then(async () => {
      this.#clearExpiryTimer();
      const active = this.#active;
      this.#active = undefined;
      if (active !== undefined) await this.#backend.stop({ ...active, reason });
      return active !== undefined;
    });
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  async revoke(reason: string): Promise<void> {
    this.#revoked = true;
    this.#revocationGeneration += 1;
    this.#clearExpiryTimer();
    const active = this.#active;
    this.#active = undefined;
    if (active !== undefined) await this.#backend.stop({ ...active, reason });
  }

  async #handle(request: ComputerUseDesktopRequest, signal?: AbortSignal): Promise<ComputerUseDesktopResponse> {
    try {
      if (this.#revoked) return this.#failure(request, 'desktop_unavailable', 'The Desktop capability is unavailable.');
      if (signal?.aborted === true) return this.#failure(request, 'request_cancelled', 'The request was cancelled.');
      await this.#expireIfNeeded();
      switch (request.operation) {
        case 'status':
          return this.#success(request, {
            available: true,
            busy: this.#active !== undefined,
            ownedBySession: this.#active?.sessionId === request.sessionId,
            expiresAt: this.#active?.expiresAt,
            backend: await this.#backend.status(),
          });
        case 'targets':
          return this.#success(request, await this.#backend.targets());
        case 'activate':
          return await this.#activate(request, signal);
        case 'observe':
          return await this.#observe(request, signal);
        case 'act':
          return await this.#act(request, signal);
        case 'stop':
          return await this.#stop(request);
      }
    } catch (error) {
      return this.#failure(request, 'invalid_request', error instanceof Error ? error.message : String(error));
    }
  }

  async #activate(request: ComputerUseDesktopRequest, signal?: AbortSignal): Promise<ComputerUseDesktopResponse> {
    if (this.#active !== undefined) {
      return this.#failure(request, 'busy_in_another_session', 'Computer use is active in another session.');
    }
    const now = this.#now();
    const revocationGeneration = this.#revocationGeneration;
    const activation = activationRequest(request.payload, now);
    if (this.#usedConfirmations.has(activation.requestId))
      return this.#failure(request, 'stale_request', 'The activation confirmation was already used.');
    this.#rememberConfirmation(activation.requestId);
    if (activation.callerLocality === 'local') {
      if (this.#confirmLocalActivation === undefined)
        return this.#failure(request, 'desktop_unavailable', 'Native Desktop confirmation is unavailable.');
      if (!(await this.#confirmLocalActivation(activation.confirmation)))
        return this.#failure(request, 'confirmation_denied', 'Native Desktop confirmation was denied.');
    }
    const durationSeconds = activation.confirmation.durationSeconds;
    const grant: ActiveGrant = {
      sessionId: request.sessionId,
      grantId: this.#newId(),
      runId: this.#newId(),
      expiresAt: now + durationSeconds * 1000,
      nextSequence: 1,
    };
    const result = await this.#backend.activate({ ...grant, payload: request.payload, signal });
    if (signal?.aborted === true || this.#revoked || revocationGeneration !== this.#revocationGeneration) {
      await this.#backend.stop({ ...grant, reason: 'request_cancelled' });
      return this.#failure(request, 'request_cancelled', 'The activation request was cancelled.');
    }
    this.#active = grant;
    this.#scheduleExpiry(grant);
    return this.#success(request, { ...grant, hostGeneration: this.#hostGeneration, result });
  }

  #rememberConfirmation(requestId: string): void {
    this.#usedConfirmations.add(requestId);
    this.#confirmationOrder.push(requestId);
    if (this.#confirmationOrder.length <= MAX_USED_CONFIRMATIONS) return;
    const oldest = this.#confirmationOrder.shift();
    if (oldest !== undefined) this.#usedConfirmations.delete(oldest);
  }
  async #observe(request: ComputerUseDesktopRequest, signal?: AbortSignal): Promise<ComputerUseDesktopResponse> {
    const active = this.#authorized(request);
    return this.#success(
      request,
      await this.#backend.observe({
        sessionId: active.sessionId,
        grantId: active.grantId,
        payload: request.payload,
        signal,
      }),
    );
  }

  async #act(request: ComputerUseDesktopRequest, signal?: AbortSignal): Promise<ComputerUseDesktopResponse> {
    const active = this.#authorized(request);
    const sequence = sequenceOf(request.payload);
    if (sequence !== active.nextSequence) {
      return this.#failure(request, 'stale_request', 'The action sequence is stale.');
    }
    const action = actionOf(request.payload);
    active.nextSequence += 1;
    return this.#success(
      request,
      await this.#backend.act({
        sessionId: active.sessionId,
        grantId: active.grantId,
        sequence,
        payload: action,
        signal,
      }),
    );
  }

  async #stop(request: ComputerUseDesktopRequest): Promise<ComputerUseDesktopResponse> {
    const active = this.#authorized(request);
    this.#clearExpiryTimer();
    this.#active = undefined;
    await this.#backend.stop({ sessionId: active.sessionId, grantId: active.grantId, reason: 'requested' });
    return this.#success(request, { stopped: true });
  }

  #authorized(request: ComputerUseDesktopRequest): ActiveGrant {
    const active = this.#active;
    if (
      active === undefined ||
      active.sessionId !== request.sessionId ||
      grantIdOf(request.payload) !== active.grantId
    ) {
      throw new Error('The computer-use grant is unavailable for this session.');
    }
    return active;
  }

  async #expireIfNeeded(): Promise<void> {
    const active = this.#active;
    if (active === undefined || active.expiresAt > this.#now()) return;
    this.#clearExpiryTimer();
    this.#active = undefined;
    await this.#backend.stop({ sessionId: active.sessionId, grantId: active.grantId, reason: 'expired' });
  }

  #scheduleExpiry(grant: ActiveGrant): void {
    this.#clearExpiryTimer();
    const delay = Math.max(0, grant.expiresAt - this.#now());
    this.#expiryTimer = setTimeout(() => {
      this.#queue = this.#queue.then(async () => this.#expireIfNeeded()).catch(() => undefined);
    }, delay);
    this.#expiryTimer.unref?.();
  }

  #clearExpiryTimer(): void {
    if (this.#expiryTimer === undefined) return;
    clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
  }

  #success(request: ComputerUseDesktopRequest, result: unknown): ComputerUseDesktopResponse {
    return {
      type: COMPUTER_USE_IPC_RESPONSE,
      version: COMPUTER_USE_IPC_VERSION,
      requestId: request.requestId,
      hostGeneration: this.#hostGeneration,
      ok: true,
      result,
    };
  }

  #failure(request: ComputerUseDesktopRequest, code: string, error: string): ComputerUseDesktopResponse {
    return {
      type: COMPUTER_USE_IPC_RESPONSE,
      version: COMPUTER_USE_IPC_VERSION,
      requestId: request.requestId,
      hostGeneration: this.#hostGeneration,
      ok: false,
      code,
      error,
    };
  }
}
