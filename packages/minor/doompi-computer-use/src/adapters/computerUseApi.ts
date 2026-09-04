import { randomUUID } from 'node:crypto';
import {
  doomApiCallerFrom,
  type DoomApi,
  type DoomApiContext,
  type DoomApiHandler,
} from '@agimon-ai/doompi-extension-contracts/package-api';
import {
  API_BASE_PATH,
  COMPUTER_USE_CONFIRMATION_WINDOW_MS,
  COMPUTER_USE_MAX_DURATION_MS,
  COMPUTER_USE_ROUTES,
  COMPUTER_USE_WAKE_LIMIT,
  type ComputerUseActivationRequest,
  type ComputerUseArtifactView,
  type ComputerUseBrokerRequest,
  type ComputerUseSessionView,
} from '../types/computerUseApi.ts';

interface PendingRequest {
  readonly request: ComputerUseBrokerRequest;
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
  if (value.kind === 'press') return allowed(['kind', 'snapshotId', 'elementRef']);
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
  return {
    artifactId: input.artifactId,
    status: input.status,
    ...(downloadUrl === undefined ? {} : { downloadUrl }),
    ...(previewUrl === undefined ? {} : { previewUrl }),
    ...(typeof input.actionCount === 'number' ? { actionCount: input.actionCount } : {}),
    ...(typeof input.completedAt === 'string' ? { completedAt: input.completedAt } : {}),
  };
}

export interface ComputerUseApiOptions {
  readonly sessionId?: string;
  readonly internalToken?: string;
  readonly hubToken?: string;
}

export class ComputerUseRequestBroker implements DoomApiHandler {
  private readonly sessionId: string;
  private readonly internalToken?: string;
  private readonly hubToken?: string;
  private revision = 0;
  private wake = 0;
  private phase: ComputerUseSessionView['phase'] = 'inactive';
  private activation?: ComputerUseActivationRequest;
  private grantId?: string;
  private expiresAt?: number;
  private actionSequence = 0;
  private failure?: ComputerUseSessionView['failure'];
  private artifact?: ComputerUseArtifactView;
  private pending?: PendingRequest;
  private closed = false;

  public constructor(options: ComputerUseApiOptions) {
    this.sessionId = options.sessionId ?? 'unknown';
    this.internalToken = options.internalToken;
    this.hubToken = options.hubToken;
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

  private changed(): void {
    this.revision += 1;
    this.wake = (this.wake + 1) % COMPUTER_USE_WAKE_LIMIT;
  }

  private authorized(request: Request, token: string | undefined): boolean {
    return token !== undefined && request.headers.get('authorization') === `Bearer ${token}`;
  }

  private async requestActivation(request: Request): Promise<Response> {
    const caller = doomApiCallerFrom(request.headers);
    if (caller === undefined || (caller.locality === 'remote' && caller.stepUp === 'not-required'))
      return jsonError('Not found.', 404);
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

  private async enqueue(operation: ComputerUseBrokerRequest['operation'], payload?: unknown): Promise<Response> {
    if (this.phase !== 'active' || this.grantId === undefined) return jsonError('Computer use is not active.', 409);
    if (this.pending !== undefined) return jsonError('Another computer-use request is live.', 409);
    const sequence = operation === 'act' ? ++this.actionSequence : undefined;
    const request: ComputerUseBrokerRequest = {
      id: randomUUID(),
      operation,
      grantId: this.grantId,
      ...(sequence === undefined ? {} : { sequence }),
      ...(payload === undefined ? {} : { payload }),
    };
    const completion = new Promise<unknown>((resolve, reject) => {
      this.pending = { request, resolve, reject };
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
    if (request.method === 'POST' && path === COMPUTER_USE_ROUTES.activate) return this.requestActivation(request);
    const agent = path.startsWith('/agent/');
    const hub = path.startsWith('/hub/');
    if ((agent && !this.authorized(request, this.internalToken)) || (hub && !this.authorized(request, this.hubToken)))
      return jsonError('Not found.', 404);

    if (request.method === 'GET' && (path === COMPUTER_USE_ROUTES.agentState || path === COMPUTER_USE_ROUTES.hubState))
      return Response.json(this.state());
    if (request.method === 'POST' && path === COMPUTER_USE_ROUTES.agentObserve) return this.enqueue('observe');
    if (request.method === 'POST' && path === COMPUTER_USE_ROUTES.agentAction) {
      const action = await body(request);
      if (!semanticAction(action)) return jsonError('A valid semantic action is required.', 400);
      return this.enqueue('act', action);
    }
    if (request.method === 'POST' && path === COMPUTER_USE_ROUTES.agentStop) {
      if (this.phase !== 'active') return jsonError('Computer use is not active.', 409);
      this.phase = 'stopping';
      this.changed();
      return Response.json(this.state(), { status: 202 });
    }
    if (request.method === 'GET' && path === COMPUTER_USE_ROUTES.hubActivation) {
      if (this.activation === undefined || this.phase !== 'awaiting_confirmation') return Response.json(null);
      this.phase = 'activating';
      this.changed();
      return Response.json(this.activation);
    }
    if (request.method === 'GET' && path === COMPUTER_USE_ROUTES.hubAuthorization)
      return Response.json(this.grantId === undefined ? null : { grantId: this.grantId, expiresAt: this.expiresAt });
    if (request.method === 'GET' && path === COMPUTER_USE_ROUTES.hubNext)
      return Response.json(this.pending?.request ?? null);
    if (request.method === 'POST' && path === COMPUTER_USE_ROUTES.hubComplete) {
      const input = await body(request);
      const id = typeof input.id === 'string' ? input.id : undefined;
      if (this.pending === undefined || this.pending.request.id !== id) return jsonError('The request is stale.', 409);
      const pending = this.pending;
      this.pending = undefined;
      this.changed();
      if (typeof input.error === 'string') pending.reject(new Error(input.error));
      else pending.resolve(input.result);
      return Response.json(this.state());
    }
    if (request.method === 'POST' && path === COMPUTER_USE_ROUTES.hubStop) {
      const input = await body(request);
      if (this.phase === 'activating') {
        if (typeof input.error === 'string') {
          this.phase = 'failed';
          this.failure = { code: 'desktop_unavailable', message: input.error.slice(0, 512) };
          this.activation = undefined;
        } else {
          const host = record(input.host);
          if (typeof host?.grantId !== 'string' || !Number.isFinite(host.expiresAt))
            return jsonError('Desktop did not issue a complete grant.', 502);
          this.grantId = host.grantId;
          this.expiresAt = host.expiresAt as number;
          this.actionSequence = 0;
          this.phase = 'active';
        }
      } else {
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
    this.closed = true;
    this.pending?.reject(new Error('Computer-use broker closed.'));
    this.pending = undefined;
    this.grantId = undefined;
    this.expiresAt = undefined;
  }
}

export function createComputerUseApi(options: ComputerUseApiOptions = {}): ComputerUseRequestBroker {
  return new ComputerUseRequestBroker(options);
}

export const api: DoomApi = {
  basePath: API_BASE_PATH,
  start(context: DoomApiContext): DoomApiHandler {
    return createComputerUseApi({
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.internalToken === undefined ? {} : { internalToken: context.internalToken }),
      ...(context.hubToken === undefined ? {} : { hubToken: context.hubToken }),
    });
  },
};
