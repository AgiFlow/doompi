/**
 * The typed call surface a cockpit plugin reaches its own API through.
 *
 * A route is declared once as data, and the build supplies the two facts the
 * declaration deliberately omits: which scopes the package mounts at, and under
 * which base path. So a page names a route and a session, never a URL.
 *
 * The shape is dictated by the transport rather than by taste. Over a tunnel
 * every request is resealed and relayed, and the relay honours only a method, a
 * set of headers and a buffered body against a root-relative target. Anything
 * this surface accepted beyond that would be silently discarded at exactly the
 * moment it mattered, so it accepts nothing beyond that.
 */

import { type ApiParams, type ApiQuery, type ApiScopeAddress, pluginApiUrl } from '../apiPaths';

/** Scope names a package API can mount at. */
export type ApiScopeName = ApiScopeAddress['scope'];

/** Methods a declared route may use. */
export type ApiRouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

declare const RESPONSE_TYPE: unique symbol;

/** Carries a route's response type through the declaration. Erased at runtime. */
export interface ApiResponseOf<T> {
  readonly [RESPONSE_TYPE]: T;
}

/** Names the type a route answers with. Returns nothing; only its type is read. */
export function apiResponse<T>(): ApiResponseOf<T> {
  return undefined as unknown as ApiResponseOf<T>;
}

/**
 * One route, as the package declares it.
 *
 * No scope and no base path: both are mount identity, the build reads them off
 * the folder tree, and restating them here is how they came to disagree in the
 * first place.
 */
export interface ApiRouteSpec<T = void> {
  readonly method: ApiRouteMethod;
  /** Below the mount, leading slash. Exactly '/' addresses the mount itself. */
  readonly path: string;
  /** Query parameter names this route reads, for documentation and review. */
  readonly query?: readonly string[];
  /** A host-owned route: it hangs off the scope root rather than under /plugins/. */
  readonly host?: true;
  /**
   * Answers `text/event-stream`.
   *
   * A streaming route gets a URL and no call method. Its consumer is the
   * browser's own `EventSource`, which does not go through the sealed
   * transport, and a relayed request buffers the whole response before
   * returning, so calling one over a tunnel would never return at all.
   */
  readonly stream?: true;
  readonly response?: ApiResponseOf<T>;
}

export type ApiRoutes = Readonly<Record<string, ApiRouteSpec<unknown>>>;

type ResponseOf<TSpec> = TSpec extends { readonly response: ApiResponseOf<infer T> } ? T : void;

/**
 * What a call may carry.
 *
 * No `cache`, `credentials`, `redirect` or `mode`. The sealed transport copies
 * only the method, the headers and the body, so those four would be discarded
 * on every remote session and honoured on no one's.
 *
 * `signal` is here because it is the one of the five that is not always a lie.
 * On loopback the transport is a plain `fetch` pass-through and cancellation
 * works, which callers already rely on to drop a superseded refresh. Over a
 * tunnel the request is resealed and relayed, and the signal goes no further
 * than this process: the call still settles, so a caller that treats an abort
 * as "no answer is coming" stays correct, but the work at the far end is not
 * stopped. Refusing the field outright would have regressed every caller that
 * cancels today, which is a worse trade than describing the limit.
 */
export interface ApiCallInit {
  /** Values for the route's `:name` path segments. */
  readonly params?: ApiParams;
  readonly query?: ApiQuery;
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON-encoded unless it is already a string, Blob, buffer or URLSearchParams. */
  readonly body?: unknown;
  /** Honoured on loopback; dropped when the session is remote. */
  readonly signal?: AbortSignal;
}

/**
 * What a route answered.
 *
 * `status` and the raw `response` are always present on an answered call,
 * because status and headers carry protocol state across this codebase: a 409
 * returns the hash the file actually has, a 204 plus a header says a recording
 * is sealed, and the file route reports a digest. A client that returned only a
 * parsed body would lose all three.
 *
 * `status: 0` with no `response` is the one case the transport never answered.
 * A relay failure arrives as a synthetic 502 and is reported as 502, because
 * this layer cannot tell it from the real thing.
 */
export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T; readonly response: Response }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly data: unknown;
      readonly response?: Response;
    };

/** Issues a request. The same shape as `fetch`, so the sealed transport and the step-up wrapper both fit. */
export type ApiTransport = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiMethod<T> {
  (init?: ApiCallInit): Promise<ApiResult<T>>;
  /** The absolute URL, for an `EventSource`, an `<img src>`, or a download. */
  url(init?: Pick<ApiCallInit, 'query' | 'params'>): string;
  readonly spec: ApiRouteSpec<unknown>;
}

/** A streaming route: addressable, not callable. */
export interface ApiStreamMethod {
  url(init?: Pick<ApiCallInit, 'query' | 'params'>): string;
  readonly spec: ApiRouteSpec<unknown>;
}

export type ApiScopeClient<TRoutes extends ApiRoutes> = {
  readonly [K in keyof TRoutes]: TRoutes[K] extends { readonly stream: true }
    ? ApiStreamMethod
    : ApiMethod<ResponseOf<TRoutes[K]>>;
};

interface ApiScopeAccessors<TRoutes extends ApiRoutes> {
  readonly global: ApiScopeClient<TRoutes>;
  readonly workspace: (workspaceId: string) => ApiScopeClient<TRoutes>;
  readonly session: (sessionId: string) => ApiScopeClient<TRoutes>;
}

/**
 * The client, carrying an accessor only for the scopes the package mounts at.
 *
 * A package serving sessions has `session` and nothing else, so addressing it
 * globally is a missing property rather than a 404 discovered at runtime. This
 * is the whole of the scope guarantee, and it costs no test.
 */
export type ApiClient<TScopes extends ApiScopeName, TRoutes extends ApiRoutes> = Pick<
  ApiScopeAccessors<TRoutes>,
  TScopes
>;

/** Identity with inference, so a route table keeps its literal types. */
export function defineApiRoutes<const TRoutes extends ApiRoutes>(routes: TRoutes): TRoutes {
  return routes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The body a route answered, or undefined when it sent none or sent non-JSON. */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The message a route reported, or an empty string.
 *
 * Empty rather than invented: callers own the words their users read, and a
 * generic sentence from here would appear in a dozen packages that each already
 * have their own.
 */
function errorOf(data: unknown): string {
  return isRecord(data) && typeof data.error === 'string' ? data.error : '';
}

/**
 * What the sealed relay can carry verbatim.
 *
 * Named here rather than borrowed from `BodyInit`, which the node build has no
 * lib for, and which is anyway wider than the truth: `FormData` and a
 * `ReadableStream` are both refused when a session is remote.
 */
export type ApiRequestBody = string | Blob | ArrayBuffer | ArrayBufferView | URLSearchParams;

/** Anything the sealed transport can carry verbatim; everything else becomes JSON. */
function encodeBody(body: unknown): { body?: ApiRequestBody; contentType?: string } {
  if (body === undefined) return {};
  if (
    typeof body === 'string' ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof URLSearchParams
  ) {
    return { body };
  }
  return { body: JSON.stringify(body), contentType: 'application/json' };
}

export interface ApiClientOptions<TScopes extends ApiScopeName> {
  /** Scopes the package's routed api/ tree actually mounts at. The build supplies these. */
  readonly scopes: readonly TScopes[];
  /** The mount segment. The build reads it off the api/<base-path>/ folder. */
  readonly basePath: string;
  readonly transport: ApiTransport;
  /** Resolves which workspace owns a session; the host binds it from its own summaries. */
  readonly sessionAddress: (sessionId: string) => ApiScopeAddress;
}

/**
 * One route, as the page calls it.
 *
 * A streaming route is returned as a plain object with no call signature, not
 * merely typed as one. The type stops an author; the missing function stops a
 * cast, a JavaScript caller, and a generic helper that iterates the client.
 * Calling one over a tunnel would buffer forever rather than fail, and that is
 * too quiet a way to lose an afternoon.
 */
function methodFor(
  spec: ApiRouteSpec<unknown>,
  address: ApiScopeAddress,
  options: ApiClientOptions<ApiScopeName>,
): ApiMethod<unknown> | ApiStreamMethod {
  const basePath = spec.host === true ? undefined : options.basePath;
  const url = (init?: Pick<ApiCallInit, 'query' | 'params'>): string =>
    pluginApiUrl(address, basePath, spec.path, init?.query, init?.params);

  const call = async (init?: ApiCallInit): Promise<ApiResult<unknown>> => {
    const encoded = encodeBody(init?.body);
    const headers = {
      ...(encoded.contentType === undefined ? {} : { 'content-type': encoded.contentType }),
      ...init?.headers,
    };
    let response: Response;
    try {
      response = await options.transport(url(init), {
        method: spec.method,
        ...(init?.signal === undefined ? {} : { signal: init.signal }),
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        // Cast because the node build's `BodyInit` enumerates concrete typed
        // arrays rather than accepting `ArrayBufferView`. Every value reaching
        // here is one fetch already carries; the two libs disagree about the
        // type, not the runtime.
        ...(encoded.body === undefined ? {} : { body: encoded.body as RequestInit['body'] }),
      });
    } catch {
      return { ok: false, status: 0, error: '', data: undefined };
    }
    const data = await readBody(response);
    if (!response.ok) return { ok: false, status: response.status, error: errorOf(data), data, response };
    return { ok: true, status: response.status, data, response };
  };

  if (spec.stream === true) return { url, spec };
  return Object.assign(call, { url, spec });
}

function scopeClient<TRoutes extends ApiRoutes>(
  routes: TRoutes,
  address: ApiScopeAddress,
  options: ApiClientOptions<ApiScopeName>,
): ApiScopeClient<TRoutes> {
  const client: Record<string, ApiMethod<unknown> | ApiStreamMethod> = {};
  for (const [key, spec] of Object.entries(routes)) client[key] = methodFor(spec, address, options);
  return client as ApiScopeClient<TRoutes>;
}

/**
 * Binds a route table to one package's mount.
 *
 * Only the scopes named in `options.scopes` get an accessor, so the returned
 * value describes exactly what this package serves and nothing else.
 */
export function createApiClient<const TScopes extends ApiScopeName, const TRoutes extends ApiRoutes>(
  routes: TRoutes,
  options: ApiClientOptions<TScopes>,
): ApiClient<TScopes, TRoutes> {
  const wide = options as ApiClientOptions<ApiScopeName>;
  const accessors: { -readonly [K in keyof ApiScopeAccessors<TRoutes>]?: ApiScopeAccessors<TRoutes>[K] } = {};
  for (const scope of options.scopes) {
    if (scope === 'global') accessors.global = scopeClient(routes, { scope: 'global' }, wide);
    if (scope === 'workspace') {
      accessors.workspace = (workspaceId: string) => scopeClient(routes, { scope: 'workspace', workspaceId }, wide);
    }
    if (scope === 'session') {
      accessors.session = (sessionId: string) => scopeClient(routes, wide.sessionAddress(sessionId), wide);
    }
  }
  return accessors as ApiClient<TScopes, TRoutes>;
}
