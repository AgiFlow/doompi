import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { ResolvedCredential } from '../services/brokerRoutes.ts';

/** Headers a provider SDK may carry its credential in. */
const CREDENTIAL_HEADERS = ['x-api-key', 'authorization', 'x-goog-api-key'] as const;
/** Query parameter some Google clients use instead of a header. */
const CREDENTIAL_QUERY = 'key';
const BEARER_PREFIX = 'bearer ';
/** Connection-scoped headers that must not cross to the upstream request. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);
const PATH_PATTERN = /^\/([^/?]+)(.*)$/;

export interface BrokerServerOptions {
  /** Providers this session may reach, keyed by Pi provider name. */
  credentials: ReadonlyMap<string, ResolvedCredential>;
  /** Secret the container presents in place of a real credential. */
  token: string;
  /** Receives one line per rejected request, for host-side visibility. */
  onDenied?: (reason: string) => void;
  /** Seam for tests; defaults to the real https transport. */
  requestUpstream?: typeof https.request;
}

function matchesToken(candidate: string, token: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function credentialValue(headerValue: string): string {
  return headerValue.toLowerCase().startsWith(BEARER_PREFIX) ? headerValue.slice(BEARER_PREFIX.length) : headerValue;
}

function withCredential(headerValue: string, realKey: string): string {
  return headerValue.toLowerCase().startsWith(BEARER_PREFIX) ? `Bearer ${realKey}` : realKey;
}

/**
 * Rewrites the request's credential, proving the caller holds the session token.
 *
 * Which header carries the key differs per provider SDK, so every candidate is
 * checked rather than assumed. Returns undefined when nothing presented the
 * token, which is what makes an unauthenticated caller indistinguishable from a
 * misrouted one.
 */
function swapCredential(
  headers: http.IncomingHttpHeaders,
  search: URLSearchParams,
  token: string,
  realKey: string,
): http.OutgoingHttpHeaders | undefined {
  const forwarded: http.OutgoingHttpHeaders = {};
  let authenticated = false;

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    const single = Array.isArray(value) ? value[0] : value;
    if ((CREDENTIAL_HEADERS as readonly string[]).includes(name) && single !== undefined) {
      if (!matchesToken(credentialValue(single), token)) return undefined;
      forwarded[name] = withCredential(single, realKey);
      authenticated = true;
      continue;
    }
    forwarded[name] = value;
  }

  const queryKey = search.get(CREDENTIAL_QUERY);
  if (queryKey !== null) {
    if (!matchesToken(queryKey, token)) return undefined;
    search.set(CREDENTIAL_QUERY, realKey);
    authenticated = true;
  }

  return authenticated ? forwarded : undefined;
}

function reject(response: http.ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { type: 'doompi_broker', message } }));
}

/**
 * Terminates provider calls from a sandboxed session on the host.
 *
 * The container never holds a real credential: it presents the session token,
 * and only a request that proves possession of it is forwarded upstream with
 * the host's key attached. Bodies stream in both directions so token-by-token
 * responses are not buffered.
 */
export function createBrokerServer(options: BrokerServerOptions): http.Server {
  const requestUpstream = options.requestUpstream ?? https.request;

  return http.createServer((request, response) => {
    const match = PATH_PATTERN.exec(request.url ?? '');
    const provider = match?.[1];
    const credential = provider ? options.credentials.get(provider) : undefined;
    if (!match || !credential) {
      options.onDenied?.(`unroutable provider path ${request.url ?? ''}`);
      reject(response, 404, 'Unknown provider for this sandbox session.');
      return;
    }

    const target = new URL(`${credential.route.upstream}${match[2] || ''}`);
    const headers = swapCredential(request.headers, target.searchParams, options.token, credential.value);
    if (!headers) {
      options.onDenied?.(`missing or invalid session token for ${credential.route.provider}`);
      reject(response, 401, 'This sandbox session did not present its broker token.');
      return;
    }

    const upstream = requestUpstream(
      target,
      { method: request.method, headers: { ...headers, host: target.host } },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', (error: Error) => {
      options.onDenied?.(`upstream ${credential.route.provider} failed: ${error.message}`);
      if (!response.headersSent) reject(response, 502, 'The provider could not be reached from the host.');
      else response.destroy();
    });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
}
