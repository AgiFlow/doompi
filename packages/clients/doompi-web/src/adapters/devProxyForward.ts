import http from 'node:http';
import { Readable } from 'node:stream';
import { DEV_PROXY_PREFIX } from '../types/devProxy.ts';
import { loopbackFor, type LoopbackAddress } from './loopbackAddress.ts';

/**
 * One HTTP request forwarded to a local dev server, the way nginx would.
 *
 * Three rewrites are not optional, and each one is a bug report waiting to
 * happen if it is skipped:
 *
 * - `Host` becomes the upstream's own address. Vite's `server.allowedHosts`
 *   and Next's dev-origin check refuse a request whose Host they do not
 *   recognize, so forwarding the cockpit's public hostname makes the dev
 *   server answer with a block page rather than the app.
 * - A root-relative `Location` gains the prefix, or the first redirect walks
 *   the browser out of the proxy and into the cockpit.
 * - `Set-Cookie` with `Path=/` is narrowed to the prefix, or the dev app's
 *   session cookie is sent on every cockpit request for the rest of the day.
 *
 * The cockpit's own cookies are removed on the way out. nginx would forward
 * them, but `__Host-doompi_device` is a bearer credential for the cockpit and
 * the dev server has no use for it. Handing it to an unaudited dev dependency,
 * or into its request log, is a leak with no upside.
 */

/** Headers that describe one hop and must not be copied onto the next. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade']);
/** Set from the target rather than copied, so the browser's value never reaches the upstream. */
const REPLACED = new Set(['host']);
/** Cookies belonging to the cockpit rather than to the proxied application. */
const COCKPIT_COOKIE_MARKER = 'doompi';
const BAD_GATEWAY = 502;
const NO_BODY_STATUSES = new Set([204, 304]);

export interface ForwardInput {
  /** The registered target's name, which is also its path segment. */
  name: string;
  port: number;
  /** Path and query exactly as the browser sent them, prefix included. */
  upstreamPath: string;
  method: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  /** The scheme the browser used, which is https whenever a tunnel is in front. */
  forwardedProto: string;
  /** The Host the browser addressed, for an app that builds absolute URLs. */
  forwardedHost: string | undefined;
  signal?: AbortSignal;
}

/** An IPv6 literal needs brackets before it can be a Host header value. */
function hostHeader(host: LoopbackAddress, port: number): string {
  return host.includes(':') ? `[${host}]:${String(port)}` : `${host}:${String(port)}`;
}

/** Drops the cockpit's cookies and keeps the application's own. */
function filterCookies(raw: string): string | undefined {
  const kept = raw
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '' && !pair.slice(0, pair.indexOf('=')).toLowerCase().includes(COCKPIT_COOKIE_MARKER));
  return kept.length === 0 ? undefined : kept.join('; ');
}

function outgoingHeaders(input: ForwardInput, host: LoopbackAddress): Record<string, string> {
  const out: Record<string, string> = {};
  input.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (HOP_BY_HOP.has(normalized) || REPLACED.has(normalized)) return;
    if (normalized === 'cookie') {
      const kept = filterCookies(value);
      if (kept !== undefined) out.cookie = kept;
      return;
    }
    out[key] = value;
  });
  out.host = hostHeader(host, input.port);
  out['x-forwarded-proto'] = input.forwardedProto;
  if (input.forwardedHost !== undefined) out['x-forwarded-host'] = input.forwardedHost;
  // Read by frameworks that can self-configure their base path. Vite and Next
  // ignore it and need their own `base`/`basePath`, which is documented.
  out['x-forwarded-prefix'] = `${DEV_PROXY_PREFIX}${input.name}`;
  return out;
}

/** Prefixes a root-relative redirect so it stays inside the proxied target. */
function rewriteLocation(value: string, name: string): string {
  const mount = `${DEV_PROXY_PREFIX}${name}`;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith(`${mount}/`)) return value;
  return `${mount}${value}`;
}

/**
 * Narrows a cookie's Path to the proxied mount.
 *
 * A dev app setting `Path=/` means it on its own origin, where it is the only
 * tenant. Here it is not, so the attribute is rewritten rather than honoured.
 * A cookie with no Path at all already defaults to the request's directory,
 * which is inside the mount, so it is left alone.
 */
function rewriteSetCookie(value: string, name: string): string {
  const mount = `${DEV_PROXY_PREFIX}${name}/`;
  return value.replaceAll(/;\s*path=([^;]*)/giu, (_match, current: string) => {
    const trimmed = current.trim();
    if (trimmed.startsWith(mount)) return `; Path=${trimmed}`;
    const suffix = trimmed === '/' || trimmed === '' ? '' : trimmed.replace(/^\//u, '');
    return `; Path=${mount}${suffix}`;
  });
}

function responseHeaders(incoming: http.IncomingMessage, name: string): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    const normalized = key.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(normalized)) continue;
    if (normalized === 'set-cookie') {
      // The only header that legitimately repeats, so it is appended rather
      // than set; joining several cookies into one value discards all but one.
      for (const cookie of Array.isArray(value) ? value : [value]) {
        headers.append('set-cookie', rewriteSetCookie(cookie, name));
      }
      continue;
    }
    const single = Array.isArray(value) ? value.join(', ') : value;
    headers.set(key, normalized === 'location' ? rewriteLocation(single, name) : single);
  }
  return headers;
}

/**
 * Forwards one request and returns the upstream's answer.
 *
 * Both bodies stream. A dev server sends multi-megabyte source maps and
 * receives file uploads, and buffering either would hold the whole thing in
 * memory for no benefit.
 */
export async function forwardToDevServer(input: ForwardInput): Promise<Response> {
  const host = await loopbackFor(input.port);
  return new Promise<Response>((resolve, reject) => {
    const request = http.request(
      {
        host,
        port: input.port,
        path: input.upstreamPath,
        method: input.method,
        headers: outgoingHeaders(input, host),
        signal: input.signal,
      },
      (incoming) => {
        const status = incoming.statusCode ?? BAD_GATEWAY;
        // 204 and 304 carry no body, and constructing one with a stream throws.
        const body = NO_BODY_STATUSES.has(status) ? null : (Readable.toWeb(incoming) as ReadableStream);
        resolve(new Response(body, { status, headers: responseHeaders(incoming, input.name) }));
      },
    );
    request.once('error', reject);
    if (input.body === null) {
      request.end();
      return;
    }
    Readable.fromWeb(input.body as Parameters<typeof Readable.fromWeb>[0])
      .on('error', reject)
      .pipe(request);
  });
}
