import { randomUUID } from 'node:crypto';

import type { DoomComputerUseSessionAccess, DoomDirectEventBus } from '@agimon-ai/doompi-core/hubChannel';
import { type DoomApi, type DoomApiContext, type DoomApiHandler } from '@agimon-ai/doompi-core/packageApi';

import routes from '../../types/apiRoutes';
import type { ComputerUseAction, ComputerUseObservation } from '../../types/computerUse';
import {
  API_BASE_PATH,
  computerUseChannelType,
  COMPUTER_USE_CONFIRMATION_WINDOW_MS,
  COMPUTER_USE_MAX_DURATION_MS,
  COMPUTER_USE_WAKE_LIMIT,
  type ComputerUseActivationRequest,
  type ComputerUseArtifactView,
  type ComputerUseBrokerRequest,
  type ComputerUseSessionView,
} from '../../types/computerUseApi';
import type { ComputerUseSessionClient } from '../sessionApiClient';

interface PendingRequest {
  readonly request: ComputerUseBrokerRequest;
  readonly dispose: () => void;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    return record(await request.json()) ?? {};
  } catch {
    return {};
  }
}

function semanticAction(value: Record<string, unknown>): boolean {
  const base =
    typeof value.snapshotId === 'string' &&
    value.snapshotId.length > 0 &&
    typeof value.elementRef === 'string' &&
    value.elementRef.length > 0;
  if (!base) return false;
  const allowed = (keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
  if (value.kind === 'press' || value.kind === 'focus') return allowed(['kind', 'snapshotId', 'elementRef']);
  if (value.kind === 'set_value')
    return typeof value.value === 'string' && allowed(['kind', 'snapshotId', 'elementRef', 'value']);
  if (value.kind === 'scroll')
    return (
      ['up', 'down', 'left', 'right'].includes(value.direction as string) &&
      (value.amount === 'line' || value.amount === 'page') &&
      allowed(['kind', 'snapshotId', 'elementRef', 'direction', 'amount'])
    );
  return false;
}
function artifactView(value: unknown): ComputerUseArtifactView | undefined {
  const input = record(value);
  if (typeof input?.artifactId !== 'string' || (input.status !== 'ready' && input.status !== 'failed'))
    return undefined;
  const safeUrl = (candidate: unknown) =>
    typeof candidate === 'string' && candidate.startsWith('/api/') ? candidate : undefined;
  const downloadUrl = safeUrl(input.downloadUrl);
  const previewUrl = safeUrl(input.previewUrl);
  const artifactFailure = record(input.failure);
  const safeFailure =
    typeof artifactFailure?.code === 'string' && typeof artifactFailure.message === 'string'
      ? { code: artifactFailure.code.slice(0, 128), message: artifactFailure.message.slice(0, 512) }
      : undefined;
  return {
    artifactId: input.artifactId,
    status: input.status,
    ...(downloadUrl === undefined ? {} : { downloadUrl }),
    ...(previewUrl === undefined ? {} : { previewUrl }),
    ...(typeof input.actionCount === 'number' ? { actionCount: input.actionCount } : {}),
    ...(typeof input.completedAt === 'string' ? { completedAt: input.completedAt } : {}),
    ...(safeFailure === undefined ? {} : { failure: safeFailure }),
  };
}

export interface ComputerUseApiOptions {
  readonly sessionId?: string;
  readonly internalToken?: string;
  readonly hubToken?: string;
  readonly directEvents: DoomDirectEventBus;
  readonly requestTimeoutMs?: number;
  readonly desktop?: DoomComputerUseSessionAccess;
  readonly beforeActivate?: () => Promise<void>;
}

export class ComputerUseRequestBroker implements DoomApiHandler {
  private readonly sessionId: string;
  private readonly internalToken?: string;
  private readonly hubToken?: string;
  private readonly directEvents: DoomDirectEventBus;
  private readonly requestTimeoutMs: number;
  private revision = 0;
  private wake = 0;
  private phase: ComputerUseSessionView['phase'] = 'inactive';
  private activation?: ComputerUseActivationRequest;
  private grantId?: string;
  private expiresAt?: number;
  private actionSequence = 0;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private failure?: ComputerUseSessionView['failure'];
  private artifact?: ComputerUseArtifactView;
  private pending?: PendingRequest;
  private closed = false;
  private readonly desktop?: DoomComputerUseSessionAccess;
  private readonly beforeActivate?: () => Promise<void>;
  private readonly listeners = new Set<(state: ComputerUseSessionView) => void>();
  private readonly unsubscribeDesktop?: () => void;

  private static readonly DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
  public constructor(options: ComputerUseApiOptions) {
    this.sessionId = options.sessionId ?? 'unknown';
    this.internalToken = options.internalToken;
    this.hubToken = options.hubToken;
    this.directEvents = options.directEvents;
    this.requestTimeoutMs = options.requestTimeoutMs ?? ComputerUseRequestBroker.DEFAULT_REQUEST_TIMEOUT_MS;
    this.desktop = options.desktop;
    this.beforeActivate = options.beforeActivate;
    this.unsubscribeDesktop = options.desktop?.subscribe(() => {
      clearTimeout(this.expiryTimer);
      if (!options.desktop?.available) {
        this.rejectPending('Desktop disconnected.');
        this.phase = 'failed';
        this.grantId = undefined;
        this.failure = { code: 'desktop_unavailable', message: 'Desktop disconnected.' };
      } else if (this.phase !== 'inactive' && this.phase !== 'failed') {
        this.phase = 'stopping';
        this.rejectPending('Control was stopped by Desktop.');
      }
      this.changed();
    });
  }

  public state(): ComputerUseSessionView {
    return Object.freeze({
      sessionId: this.sessionId,
      revision: this.revision,
      wake: this.wake,
      phase: this.phase,
      ...(this.activation === undefined
        ? {}
        : {
            requestId: this.activation.requestId,
            target: this.activation.target,
            durationMs: this.activation.durationSeconds * 1_000,
          }),
      ...(this.expiresAt === undefined ? {} : { expiresAt: this.expiresAt }),
      ...(this.failure === undefined ? {} : { failure: this.failure }),
      ...(this.artifact === undefined ? {} : { artifact: this.artifact }),
    });
  }

  /** Tools and the API share this broker. No socket, credential discovery, or second state store. */
  public sessionClient(): ComputerUseSessionClient {
    const result = async <T>(response: Response): Promise<T> => {
      const value = (await response.json()) as T & { error?: string };
      if (!response.ok) throw new Error(value.error ?? `Computer-use request failed (${response.status}).`);
      return value;
    };
    const requireDesktop = (): void => {
      if (this.closed || !this.desktop?.available || this.desktop.enabled === false)
        throw new Error('Desktop computer use is unavailable.');
    };
    return {
      state: async () => this.state(),
      subscribeStatus: (listener) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
      observe: async (signal, options = {}) => {
        requireDesktop();
        return result<ComputerUseObservation>(await this.enqueue('observe', options, signal));
      },
      act: async (action: ComputerUseAction, signal) => {
        requireDesktop();
        if (!semanticAction(action as unknown as Record<string, unknown>))
          throw new Error('A valid semantic action is required.');
        return result(await this.enqueue('act', action, signal));
      },
      stop: async (signal) => {
        signal?.throwIfAborted();
        if (this.phase !== 'inactive' && this.phase !== 'failed') {
          this.phase = 'stopping';
          this.rejectPending('Computer use was stopped.');
          this.changed();
        }
        return this.state();
      },
    };
  }
  private changed(): void {
    this.revision += 1;
    this.wake = (this.wake + 1) % COMPUTER_USE_WAKE_LIMIT;
    const state = this.state();
    for (const listener of this.listeners) listener(state);
    this.directEvents.publish(computerUseChannelType, this.sessionId, state);
  }

  private authorized(request: Request, token: string | undefined): boolean {
    return token !== undefined && request.headers.get('authorization') === `Bearer ${token}`;
  }

  private async requestActivation(request: Request): Promise<Response> {
    if (!this.desktop?.available || !this.desktop.authorize(request.headers)) return jsonError('Not found.', 404);
    if (this.desktop.enabled === false) return jsonError('Enable computer use in global Desktop settings first.', 409);
    // Only the owning native renderer can reach this point. Remote/browser caller stamps cannot grant access.
    const caller = { locality: 'local', stepUp: 'not-required' } as const;
    if (this.phase !== 'inactive' && this.phase !== 'failed') return jsonError('Computer use is already busy.', 409);
    const input = await body(request);
    const target = record(input.target);
    const durationMs = input.durationMs;
    if (target === undefined || typeof target.windowId !== 'string' || typeof target.bundleId !== 'string')
      return jsonError('A Desktop target is required.', 400);
    if (
      typeof durationMs !== 'number' ||
      !Number.isInteger(durationMs) ||
      durationMs < 1_000 ||
      durationMs > COMPUTER_USE_MAX_DURATION_MS
    )
      return jsonError('The requested duration is invalid.', 400);
    this.desktop.claim();
    try {
      await this.beforeActivate?.();
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : String(error), 409);
    }
    if (this.closed || !this.desktop.available || (this.phase !== 'inactive' && this.phase !== 'failed')) {
      return jsonError('Computer use is unavailable or already busy.', 409);
    }
    const createdAt = Date.now();
    this.activation = Object.freeze({
      requestId: randomUUID(),
      target: Object.freeze({ ...target }),
      durationSeconds: durationMs / 1_000,
      createdAt,
      confirmationExpiresAt: createdAt + COMPUTER_USE_CONFIRMATION_WINDOW_MS,
      caller: Object.freeze({ ...caller }),
    });
    this.phase = 'awaiting_confirmation';
    this.failure = undefined;
    this.artifact = undefined;
    this.changed();
    return Response.json(this.state(), { status: 202 });
  }

  private rejectPending(message: string): void {
    const pending = this.pending;
    if (pending === undefined) return;
    this.pending = undefined;
    pending.dispose();
    pending.reject(new Error(message));
  }

  private stopAfterUncertainRequest(message: string): void {
    if (this.phase === 'active') {
      this.phase = 'stopping';
      this.changed();
    }
    this.rejectPending(message);
  }

  private async enqueue(
    operation: ComputerUseBrokerRequest['operation'],
    payload?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (this.phase !== 'active' || this.grantId === undefined) return jsonError('Computer use is not active.', 409);
    if (this.pending !== undefined) return jsonError('Another computer-use request is live.', 409);
    if (signal?.aborted === true) return jsonError('The computer-use request was cancelled.', 499);
    const sequence = operation === 'act' ? ++this.actionSequence : undefined;
    const request: ComputerUseBrokerRequest = {
      id: randomUUID(),
      operation,
      grantId: this.grantId,
      ...(sequence === undefined ? {} : { sequence }),
      ...(payload === undefined ? {} : { payload }),
    };
    const completion = new Promise<unknown>((resolve, reject) => {
      const onAbort = () => this.stopAfterUncertainRequest('The computer-use request was cancelled.');
      const timer = setTimeout(
        () => this.stopAfterUncertainRequest('The computer-use request timed out.'),
        this.requestTimeoutMs,
      );
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending = {
        request,
        resolve,
        reject,
        dispose: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      };
    });
    this.changed();
    try {
      return Response.json(await completion);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : String(error), 502);
    }
  }

  public async fetch(request: Request): Promise<Response> {
    if (this.closed) return jsonError('Computer-use broker is closed.', 503);
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === routes.activate.path) return this.requestActivation(request);
    const agent = path.startsWith('/agent/');
    const hub = path.startsWith('/hub/');
    if ((agent && !this.authorized(request, this.internalToken)) || (hub && !this.authorized(request, this.hubToken)))
      return jsonError('Not found.', 404);

    if (request.method === 'GET' && (path === routes.agentState.path || path === routes.hubState.path))
      return Response.json(this.state());
    if (request.method === 'POST' && path === routes.agentObserve.path)
      return this.enqueue('observe', undefined, request.signal);
    if (request.method === 'POST' && path === routes.agentAction.path) {
      const action = await body(request);
      if (!semanticAction(action)) return jsonError('A valid semantic action is required.', 400);
      return this.enqueue('act', action, request.signal);
    }
    if (request.method === 'POST' && path === routes.agentStop.path) {
      if (this.phase !== 'active') return jsonError('Computer use is not active.', 409);
      this.phase = 'stopping';
      this.rejectPending('The computer-use request was stopped.');
      this.changed();
      return Response.json(this.state(), { status: 202 });
    }
    if (request.method === 'GET' && path === routes.hubActivation.path) {
      if (this.activation === undefined || this.phase !== 'awaiting_confirmation') return Response.json(null);
      this.phase = 'activating';
      this.changed();
      return Response.json(this.activation);
    }
    if (request.method === 'GET' && path === routes.hubAuthorization.path)
      return Response.json(this.grantId === undefined ? null : { grantId: this.grantId, expiresAt: this.expiresAt });
    if (request.method === 'GET' && path === routes.hubNext.path) return Response.json(this.pending?.request ?? null);
    if (request.method === 'POST' && path === routes.hubComplete.path) {
      const input = await body(request);
      const id = typeof input.id === 'string' ? input.id : undefined;
      if (this.pending === undefined || this.pending.request.id !== id) return jsonError('The request is stale.', 409);
      const pending = this.pending;
      this.pending = undefined;
      pending.dispose();
      if (typeof input.error === 'string') {
        this.phase = 'stopping';
        pending.reject(new Error(input.error));
      } else pending.resolve(input.result);
      this.changed();
      return Response.json(this.state());
    }
    if (request.method === 'POST' && path === routes.hubStop.path) {
      const input = await body(request);
      if (this.phase === 'activating') {
        if (typeof input.error === 'string') {
          this.phase = 'failed';
          this.failure = { code: 'desktop_unavailable', message: input.error.slice(0, 512) };
          this.activation = undefined;
        } else {
          const host = record(input.host);
          if (
            typeof host?.grantId !== 'string' ||
            !Number.isFinite(host.expiresAt) ||
            (host.expiresAt as number) <= Date.now()
          )
            return jsonError('Desktop did not issue a complete grant.', 502);
          this.grantId = host.grantId;
          this.expiresAt = host.expiresAt as number;
          this.actionSequence = 0;
          this.phase = 'active';
          clearTimeout(this.expiryTimer);
          this.expiryTimer = setTimeout(
            () => {
              if (this.closed || this.phase !== 'active') return;
              this.phase = 'stopping';
              this.rejectPending('The computer-use grant expired.');
              this.changed();
            },
            Math.max(0, this.expiresAt - Date.now()),
          );
          this.expiryTimer.unref?.();
        }
      } else {
        clearTimeout(this.expiryTimer);
        this.rejectPending('The computer-use session stopped.');
        this.phase = 'inactive';
        this.grantId = undefined;
        this.expiresAt = undefined;
        this.activation = undefined;
        this.artifact = artifactView(input.artifact);
      }
      this.changed();
      return Response.json(this.state());
    }
    return jsonError('Not found.', 404);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.expiryTimer);
    this.unsubscribeDesktop?.();
    this.listeners.clear();
    this.rejectPending('Computer-use broker closed.');
    this.grantId = undefined;
    this.expiresAt = undefined;
  }
}

export function createComputerUseApi(options: ComputerUseApiOptions): ComputerUseRequestBroker {
  return new ComputerUseRequestBroker(options);
}

export const api: DoomApi = {
  basePath: API_BASE_PATH,
  start(context: DoomApiContext): DoomApiHandler {
    if (context.directEvents === undefined) throw new Error('Computer-use API requires the session direct event bus.');
    return createComputerUseApi({
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.internalToken === undefined ? {} : { internalToken: context.internalToken }),
      ...(context.hubToken === undefined ? {} : { hubToken: context.hubToken }),
      directEvents: context.directEvents,
      desktop: context.computerUse,
    });
  },
};
