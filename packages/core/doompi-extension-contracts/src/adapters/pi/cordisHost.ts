import { Context, type Fiber } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from '@earendil-works/pi-coding-agent';
import { DOOM_CONTEXT_CONTRIBUTIONS_SERVICE } from '../../schemas/contextContributions.ts';
import { DOOM_TOOL_OVERRIDES_SERVICE } from '../../schemas/toolOverrides.ts';
import { createDoomContextContributionsService } from '../../services/contextContributions.ts';
import { createDoomToolOverridesService } from '../../services/toolOverrides.ts';

export const DOOM_CORDIS_HOST_ABI_VERSION = 1 as const;
export const DOOM_CORDIS_HOST_QUERY_CHANNEL = 'doom:cordis:host:v1:query';
export const DOOM_CORDIS_HOST_REQUIRED_ENV = 'DOOMPI_CORDIS_HOST_REQUIRED';
export const DOOM_CORDIS_RUNTIME_SERVICE = 'doom/runtime';
export const DOOM_CORDIS_SESSION_SERVICE = 'doom/session';

const ENABLED_FLAG = '1';
const HOST_PROTOCOL = 'doom.cordis.host';
const DEFAULT_HOST_SOURCE = '@agimon-ai/doompi/cordis-host';

export type DoomCordisHostMode = 'composed' | 'standalone';

export interface DoomCordisRuntimeService {
  readonly abiVersion: typeof DOOM_CORDIS_HOST_ABI_VERSION;
  readonly hostId: string;
  readonly generation: string;
  readonly mode: DoomCordisHostMode;
}

export interface DoomCordisSessionService {
  readonly sessionId: string;
  readonly generation: string;
  readonly reason: SessionStartEvent['reason'];
  readonly context: ExtensionContext;
}

export interface DoomCordisHostConnection {
  readonly root: Context;
  readonly runtime: DoomCordisRuntimeService;
  /** Releases this consumer's lease. It never disposes a composed host. */
  dispose(): Promise<void>;
}

export interface DoomCordisHostController {
  readonly root: Context;
  readonly runtime: DoomCordisRuntimeService;
  /** Recursively disposes the session and application plugin tree. */
  shutdown(): Promise<void>;
}

export interface ConnectDoomCordisHostOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Host/finalizer entries disable fallback so a malformed composition fails closed. */
  readonly allowStandalone?: boolean;
}

export interface InstallDoomCordisHostOptions {
  readonly mode: DoomCordisHostMode;
  readonly source?: string;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/runtime': DoomCordisRuntimeService;
    'doom/session': DoomCordisSessionService;
  }
}

interface HostQuery {
  readonly protocol: typeof HOST_PROTOCOL;
  readonly abiVersion: typeof DOOM_CORDIS_HOST_ABI_VERSION;
  readonly kind: 'query';
  readonly requestId: string;
  readonly source: string;
  readonly accept: (response: unknown) => void;
}

interface HostResponder {
  readonly protocol: typeof HOST_PROTOCOL;
  readonly abiVersion: typeof DOOM_CORDIS_HOST_ABI_VERSION;
  readonly hostId: string;
  readonly root: Context;
  readonly runtime: DoomCordisRuntimeService;
  readonly ready: Promise<void>;
  acquire(): DoomCordisHostConnection;
  shutdown(): Promise<void>;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function asHostQuery(value: unknown): HostQuery | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.protocol !== HOST_PROTOCOL ||
    value.abiVersion !== DOOM_CORDIS_HOST_ABI_VERSION ||
    value.kind !== 'query' ||
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    typeof value.source !== 'string' ||
    value.source.length === 0 ||
    typeof value.accept !== 'function'
  ) {
    return undefined;
  }
  return value as unknown as HostQuery;
}

function asHostResponder(value: unknown): HostResponder {
  if (!isRecord(value)) throw new Error('The Doom Cordis host returned an invalid discovery response.');
  if (value.protocol !== HOST_PROTOCOL) {
    throw new Error('The Doom Cordis host returned an invalid protocol identifier.');
  }
  if (value.abiVersion !== DOOM_CORDIS_HOST_ABI_VERSION) {
    throw new Error(
      `The Doom Cordis host ABI is incompatible: expected ${String(DOOM_CORDIS_HOST_ABI_VERSION)}, received ${String(value.abiVersion)}.`,
    );
  }
  if (typeof value.hostId !== 'string' || value.hostId.length === 0) {
    throw new Error('The Doom Cordis host returned an invalid host identifier.');
  }
  if (!Context.is(value.root)) {
    throw new Error('The Doom Cordis host returned a value that is not a Cordis Context.');
  }
  if (
    !isRecord(value.runtime) ||
    value.runtime.abiVersion !== DOOM_CORDIS_HOST_ABI_VERSION ||
    value.runtime.hostId !== value.hostId ||
    typeof value.acquire !== 'function' ||
    typeof value.shutdown !== 'function' ||
    !isRecord(value.ready) ||
    typeof value.ready.then !== 'function'
  ) {
    throw new Error('The Doom Cordis host returned incomplete runtime metadata.');
  }
  return value as unknown as HostResponder;
}

function discoverHosts(pi: Pick<ExtensionAPI, 'events'>, source: string): HostResponder[] {
  const responses: HostResponder[] = [];
  const request: HostQuery = {
    protocol: HOST_PROTOCOL,
    abiVersion: DOOM_CORDIS_HOST_ABI_VERSION,
    kind: 'query',
    requestId: `${source}:${crypto.randomUUID()}`,
    source,
    accept(response) {
      responses.push(asHostResponder(response));
    },
  };
  pi.events.emit(DOOM_CORDIS_HOST_QUERY_CHANNEL, request);
  return responses;
}

function exactlyOneHost(responses: readonly HostResponder[], source: string): HostResponder | undefined {
  if (responses.length <= 1) return responses[0];
  const hostIds = responses.map(({ hostId }) => hostId).join(', ');
  throw new Error(`Multiple Doom Cordis hosts answered ${source}: ${hostIds}.`);
}

function runtimeProvider(ctx: Context, service: DoomCordisRuntimeService): void {
  ctx.provide(DOOM_CORDIS_RUNTIME_SERVICE, service);
  ctx.provide(DOOM_TOOL_OVERRIDES_SERVICE, createDoomToolOverridesService(service.generation));
}

function sessionProvider(ctx: Context, service: DoomCordisSessionService): void {
  ctx.provide(DOOM_CORDIS_SESSION_SERVICE, service);
  ctx.provide(DOOM_CONTEXT_CONTRIBUTIONS_SERVICE, createDoomContextContributionsService(service.generation));
}

/**
 * Installs the sole Cordis application root for one Pi extension runner.
 *
 * The versioned EventBus query is intentional: Pi may hand independently
 * loaded factories different ExtensionAPI wrapper objects, while their event
 * buses still address the same runner.
 */
export async function installDoomCordisHost(
  pi: ExtensionAPI,
  options: InstallDoomCordisHostOptions,
): Promise<DoomCordisHostController> {
  const source = options.source ?? DEFAULT_HOST_SOURCE;
  const existing = exactlyOneHost(discoverHosts(pi, source), source);
  if (existing) throw new Error(`A Doom Cordis host is already installed: ${existing.hostId}.`);

  // This is the one intentional Context constructor for DoomPi extension code.
  const root = new Context();
  const runtime: DoomCordisRuntimeService = Object.freeze({
    abiVersion: DOOM_CORDIS_HOST_ABI_VERSION,
    hostId: `doom-cordis:${crypto.randomUUID()}`,
    generation: `doom-runtime:${crypto.randomUUID()}`,
    mode: options.mode,
  });
  const runtimeFiber = root.plugin(runtimeProvider, runtime);
  const ready = runtimeFiber.await().then(() => undefined);
  let sessionFiber: Fiber | undefined;
  let sessionGeneration = 0;
  let sessionQueue = Promise.resolve();
  let leaseCount = 0;
  let shutdownPromise: Promise<void> | undefined;
  let responder: HostResponder;
  let disposeQuerySubscription = (): void => undefined;

  const controller: DoomCordisHostController = {
    root,
    runtime,
    shutdown() {
      shutdownPromise ??= (async () => {
        disposeQuerySubscription();
        await ready.catch(() => undefined);
        await sessionQueue.catch(() => undefined);
        await sessionFiber?.dispose();
        sessionFiber = undefined;
        await root.fiber.dispose();
      })();
      return shutdownPromise;
    },
  };

  responder = {
    protocol: HOST_PROTOCOL,
    abiVersion: DOOM_CORDIS_HOST_ABI_VERSION,
    hostId: runtime.hostId,
    root,
    runtime,
    ready,
    acquire() {
      if (shutdownPromise) throw new Error(`The Doom Cordis host is shutting down: ${runtime.hostId}.`);
      leaseCount += 1;
      let released = false;
      return {
        root,
        runtime,
        async dispose() {
          if (released) return;
          released = true;
          leaseCount -= 1;
          if (options.mode === 'standalone' && leaseCount === 0) await controller.shutdown();
        },
      };
    },
    shutdown: () => controller.shutdown(),
  };
  try {
    disposeQuerySubscription = pi.events.on(DOOM_CORDIS_HOST_QUERY_CHANNEL, (value) => {
      const query = asHostQuery(value);
      if (query) query.accept(responder);
    });
    pi.on('session_start', (event, context) => {
      sessionQueue = sessionQueue
        .catch(() => undefined)
        .then(async () => {
          // Pi owns its listener table and can retain this callback across a
          // replacement. A start delivered after finalization belongs to the
          // stale graph and must not revive or fail the next one.
          if (shutdownPromise) return;
          await sessionFiber?.dispose();
          sessionGeneration += 1;
          const service: DoomCordisSessionService = Object.freeze({
            sessionId: context.sessionManager.getSessionId(),
            generation: `${runtime.generation}:${String(sessionGeneration)}`,
            reason: event.reason,
            context,
          });
          sessionFiber = root.plugin(sessionProvider, service);
          await sessionFiber.await();
        });
      return sessionQueue;
    });
    if (options.mode === 'standalone') {
      pi.on('session_shutdown', () => {
        disposeQuerySubscription();
      });
    }
    await ready;
  } catch (error) {
    await controller.shutdown();
    throw error;
  }
  return controller;
}

/** Resolves the composed host, or installs one shared standalone fallback. */
export async function connectDoomCordisHost(
  pi: ExtensionAPI,
  source: string,
  options: ConnectDoomCordisHostOptions = {},
): Promise<DoomCordisHostConnection> {
  let responder = exactlyOneHost(discoverHosts(pi, source), source);
  if (!responder) {
    const environment = options.environment ?? process.env;
    const fallbackAllowed = options.allowStandalone ?? environment[DOOM_CORDIS_HOST_REQUIRED_ENV] !== ENABLED_FLAG;
    if (!fallbackAllowed) {
      throw new Error('The composed Doom Cordis host is unavailable. Ensure cordisHost is the first extension.');
    }
    await installDoomCordisHost(pi, { mode: 'standalone', source: `${source}:standalone-host` });
    responder = exactlyOneHost(discoverHosts(pi, source), source);
  }
  if (!responder) throw new Error('The Doom Cordis standalone host could not be installed.');
  await responder.ready;
  return responder.acquire();
}

/** Ends the host discovered on this runner. Repeated finalization is a no-op. */
export async function finalizeDoomCordisHost(pi: Pick<ExtensionAPI, 'events'>, source: string): Promise<void> {
  const responder = exactlyOneHost(discoverHosts(pi, source), source);
  await responder?.shutdown();
}
