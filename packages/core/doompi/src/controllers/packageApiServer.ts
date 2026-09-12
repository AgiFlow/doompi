import {
  DOOM_API_ROUTE_PREFIX,
  type DoomApi,
  type DoomApiContext,
} from '@agimon-ai/doompi-extension-contracts/package-api';
import type { DoomDirectEventBus, DoomHubSessionService } from '@agimon-ai/doompi-extension-contracts/hub-channel';
import {
  createDoomServerHost,
  type CreateDoomServerHostOptions,
  type DoomServerFacet,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import {
  installServerFacets,
  type LoadedServerFacet,
  type InstalledServerFacets,
  type InstallServerFacetsOptions,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { DoomTraceContext } from '@agimon-ai/doompi-telemetry';
import { validatedTraceContext } from '../services/traceContext';
import { observe, type ServerTelemetry } from '../services/serverTelemetry';

/**
 * A body that keeps streaming well after its headers went out is worth its own span. A fast
 * one is not: the request span already carries the duration and outcome, so emitting a second
 * span per call made package API traffic 99.65% of all spans recorded in a two hour sample.
 */
export const COMPLETION_SPAN_MIN_DURATION_MS = 1000;

export interface PackageApiServerOptions {
  sessionId: string;
  workspaceId?: string;
  workspaceRoot?: string;
  homeDirectory?: string;
  mountChannel?: CreateDoomServerHostOptions['mountChannel'];
  cwd: string;
  /** Admitted environment for APIs serving this session. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Lifecycle-owned direct events shared with the hub. */
  readonly directEvents: DoomDirectEventBus;
  internalToken?: string;
  hubToken?: string;
  sessionService?: DoomHubSessionService;
  apis: readonly DoomApi[];
  /** Server facets to install; each registers its own APIs through the host. */
  facets?: readonly (DoomServerFacet | LoadedServerFacet)[];
  prepareFacets?: InstallServerFacetsOptions['prepare'];
  activateFacets?: (installed: InstalledServerFacets) => Promise<void>;
  canDispatch?: () => boolean;
  telemetry?: ServerTelemetry;
  onNotice: (message: string) => void;
}

export interface PackageApiServer {
  /** Dispatches an already-authenticated request without crossing a transport boundary. */
  readonly request: (request: Request) => Promise<Response>;
  close(): Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function responseWithCompletion(response: Response, complete: () => void): Response {
  if (response.body === null) {
    complete();
    return response;
  }
  const reader = response.body.getReader();
  let completed = false;
  const finish = (): void => {
    if (completed) return;
    completed = true;
    complete();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finish();
          controller.close();
        } else controller.enqueue(result.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
  return new Response(body, response);
}

/** Installs session facets and dispatches authenticated package API calls in-process. */
export async function serveSessionApis(options: PackageApiServerOptions): Promise<PackageApiServer> {
  if (options.environment === undefined)
    throw new Error('Session package API server requires an admitted environment.');
  if (options.directEvents === undefined) throw new Error('Session package API server requires direct events.');
  const facets = options.facets ?? [];
  if (options.apis.length === 0 && facets.length === 0 && !options.prepareFacets) {
    return {
      request: async () => Response.json({ error: 'No package APIs are mounted.' }, { status: 404 }),
      close: () => Promise.resolve(),
    };
  }

  const context: DoomApiContext = {
    scope: 'session',
    sessionId: options.sessionId,
    workspaceId: options.workspaceId,
    workspaceRoot: options.workspaceRoot,
    homeDirectory: options.homeDirectory,
    cwd: options.cwd,
    environment: options.environment,
    directEvents: options.directEvents,
    ...(options.internalToken === undefined ? {} : { internalToken: options.internalToken }),
    ...(options.hubToken === undefined ? {} : { hubToken: options.hubToken }),
    ...(options.sessionService === undefined ? {} : { sessionService: options.sessionService }),
    onNotice: options.onNotice,
  };
  const host = createDoomServerHost({ scope: 'session', context, mountChannel: options.mountChannel });
  for (const api of options.apis) host.registerApi(api);
  let installed: InstalledServerFacets;
  try {
    installed = await installServerFacets({ host, facets, onNotice: options.onNotice, prepare: options.prepareFacets });
    try {
      await options.activateFacets?.(installed);
    } catch (error) {
      await installed.dispose();
      throw error;
    }
  } catch (error) {
    host.dispose();
    throw error;
  }
  if (host.mounted().length === 0 && !options.prepareFacets) {
    await installed.dispose();
    host.dispose();
    return {
      request: async () => Response.json({ error: 'No package APIs are mounted.' }, { status: 404 }),
      close: () => Promise.resolve(),
    };
  }

  const dispatch = async (request: Request): Promise<Response> => {
    if (options.canDispatch?.() === false)
      return Response.json({ error: 'Session selection is not ready.' }, { status: 503 });
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${DOOM_API_ROUTE_PREFIX}/`))
      return Response.json({ error: 'Not found.' }, { status: 404 });
    const rest = url.pathname.slice(DOOM_API_ROUTE_PREFIX.length + 1);
    const slash = rest.indexOf('/');
    const basePath = slash === -1 ? rest : rest.slice(0, slash);
    const handler = host.handlerFor(basePath);
    if (handler === undefined)
      return Response.json({ error: `No API '${basePath}' in this session.` }, { status: 404 });
    url.pathname = slash === -1 ? '/' : rest.slice(slash);
    const startedAt = performance.now();
    const parent = validatedTraceContext(request.headers.get('traceparent'));
    let childContext: DoomTraceContext | undefined;
    let response: Response;
    try {
      const invoke = async (context?: DoomTraceContext): Promise<Response> => {
        if (options.canDispatch?.() === false || host.handlerFor(basePath) !== handler) {
          return Response.json({ error: 'Session selection changed before dispatch.' }, { status: 503 });
        }
        childContext = context;
        return handler.fetch(new Request(url, request));
      };
      response = options.telemetry
        ? await options.telemetry.runInSpan(
            'doompi_server.package_api.request',
            { api: basePath, method: request.method },
            invoke,
            parent,
          )
        : await invoke();
    } catch (error) {
      options.onNotice(`package API '${basePath}' failed on ${url.pathname} (${describeError(error)})`);
      response = Response.json({ error: `The '${basePath}' API failed.` }, { status: 500 });
    }
    return responseWithCompletion(response, () => {
      if (!options.telemetry) return;
      const durationMs = Math.round(performance.now() - startedAt);
      // Keep this span only where it says something the request span cannot: a failing status,
      // or a body that took real time to flush after the headers were sent.
      if (response.status < 400 && durationMs < COMPLETION_SPAN_MIN_DURATION_MS) return;
      observe(
        options.telemetry.runInSpan(
          'doompi_server.package_api.complete',
          {
            api: basePath,
            method: request.method,
            status_code: response.status,
            duration_ms: durationMs,
          },
          async () => undefined,
          childContext ?? parent,
        ),
        options.onNotice,
      );
    });
  };
  let closePromise: Promise<void> | undefined;

  return {
    request: dispatch,
    close: () => {
      closePromise ??= (async () => {
        await installed.dispose();
        host.dispose();
      })();
      return closePromise;
    },
  };
}
