/**
 * Who may do what, on which listener.
 *
 * The cockpit runs one Hono app behind two sockets: a loopback listener that is
 * open to whoever already has an account on the machine, and a tunnel listener
 * that faces the public internet. Every decision here answers one question
 * about one request, with no I/O, so the whole trust boundary is readable in a
 * single sitting and testable without a server.
 */

import {
  PAIRING_CLAIM_ROUTE,
  PAIRING_PAGE_ROUTE,
  PAIRING_STATUS_ROUTE,
  PASSKEY_AUTH_BEGIN_ROUTE,
  PASSKEY_AUTH_FINISH_ROUTE,
  WEB_DEV_SERVER_PORT,
} from '../types/remoteAccess.ts';

const METHOD_GET = 'GET';
const METHOD_HEAD = 'HEAD';
const METHOD_POST = 'POST';
/** Cloudflare's edge speaks to us on 443, so the Host it forwards may or may not carry the port. */
const HTTPS_DEFAULT_PORT = '443';

export type GuardListener = 'local' | 'tunnel';

export type OriginVerdict = 'allow' | 'bad-origin' | 'bad-host' | 'not-ready';

export interface OriginPolicy {
  origins: ReadonlySet<string>;
  hosts: ReadonlySet<string>;
}

export interface OriginVerdictInput {
  listener: GuardListener;
  method: string;
  isUpgrade: boolean;
  origin: string | undefined;
  host: string | undefined;
  local: OriginPolicy;
  /** Undefined until the tunnel reports its hostname; until then nothing on that listener is served. */
  tunnel: OriginPolicy | undefined;
}

/**
 * Which socket a request arrived on.
 *
 * Phrased as allow-only-if-provably-local on purpose. A missing env, an
 * unreadable port, or a socket torn down mid-request all resolve to 'tunnel'
 * and therefore require a credential. The mirror-image phrasing
 * (`port === tunnelPort`) fails open on every one of those.
 */
export function listenerOf(socketLocalPort: number | undefined, loopbackPort: number | undefined): GuardListener {
  if (loopbackPort === undefined || socketLocalPort === undefined) return 'tunnel';
  return socketLocalPort === loopbackPort ? 'local' : 'tunnel';
}

/**
 * The exact routes the tunnel listener answers without a session.
 *
 * Matched by string equality, because an allowlist is only as good as its
 * narrowest form. No prefix, no wildcard, no path parameter: the pairing status
 * endpoint takes its id in the query string precisely so this list never needs
 * one. A contract test pins the length, so an addition cannot arrive without a
 * reviewer noticing.
 *
 * The two passkey sign-in routes are here of necessity: proving a registered
 * passkey is how a returning device obtains a session, so requiring a session
 * to reach them would mean a device could never use its passkey and would need
 * a fresh QR every time. Neither is a hole. The first hands out a challenge,
 * which is public by design, and the second only succeeds for a caller holding
 * a registered credential's private key, which is the definition of
 * authenticating rather than a way around it.
 */
export const PUBLIC_PAIRING_ROUTES: readonly { method: string; path: string }[] = [
  { method: METHOD_GET, path: PAIRING_PAGE_ROUTE },
  { method: METHOD_POST, path: PAIRING_CLAIM_ROUTE },
  { method: METHOD_GET, path: PAIRING_STATUS_ROUTE },
  { method: METHOD_POST, path: PASSKEY_AUTH_BEGIN_ROUTE },
  { method: METHOD_POST, path: PASSKEY_AUTH_FINISH_ROUTE },
];

/**
 * Whether the tunnel listener may answer this request unauthenticated.
 *
 * `path` must be the value the router matched on, which for Hono is
 * `c.req.path`. That value is percent-decoded, so `/%70air` reaches the `/pair`
 * handler; comparing against a separately parsed pathname would let the guard
 * and the router disagree about the same request, which is how an allowlist
 * turns into a bypass.
 */
export function isPublicPairingRoute(method: string, path: string): boolean {
  const wanted = method.toUpperCase();
  return PUBLIC_PAIRING_ROUTES.some((route) => route.method === wanted && route.path === path);
}

/**
 * Reads the operator's extra-origin allowlist.
 *
 * The escape hatch for a dev setup this package cannot guess: a second dev
 * server port, a reverse proxy, a `.local` hostname. Comma separated, blanks
 * dropped, so an empty or unset variable adds nothing.
 */
export function allowedOriginsFromEnv(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** Normalizes to scheme://host[:port], lowercased. Undefined for anything unparseable, `null` included. */
function normalizeOrigin(raw: string): string | undefined {
  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    // An Origin header that is not a URL is either the opaque `null` or a
    // forgery; neither is on any allowlist, so refusing it is the answer.
    return undefined;
  }
}

function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * What the loopback listener accepts.
 *
 * The port is the one the socket actually bound, not a constant, because the
 * hub takes `--port` and the e2e fixture reserves a random free one. The vite
 * dev server is allowed unconditionally so the documented two-terminal plugin
 * loop keeps working; anything that can bind that port already runs as this
 * user, so the marginal risk is close to nothing.
 */
export function localOriginPolicy(port: number, extraOrigins: readonly string[] = []): OriginPolicy {
  const hosts = new Set<string>();
  const origins = new Set<string>();
  // The dev server's own port belongs here too: vite proxies /api to the hub
  // without `changeOrigin`, so the browser's Host and Origin arrive unchanged
  // and both name 7434 rather than the hub's port.
  for (const listenPort of [port, WEB_DEV_SERVER_PORT]) {
    for (const name of ['127.0.0.1', 'localhost', '[::1]']) {
      const host = `${name}:${String(listenPort)}`;
      hosts.add(host);
      origins.add(`http://${host}`);
    }
  }
  for (const extra of extraOrigins) {
    const normalized = normalizeOrigin(extra);
    if (normalized !== undefined) origins.add(normalized);
  }
  return { origins, hosts };
}

/** What the tunnel listener accepts: its own origin and nothing else. */
export function tunnelOriginPolicy(publicOrigin: string, extraHosts: readonly string[] = []): OriginPolicy {
  const normalized = normalizeOrigin(publicOrigin);
  if (normalized === undefined) throw new Error(`The tunnel origin "${publicOrigin}" is not a URL.`);
  const host = new URL(normalized).host;
  const hosts = new Set([host, `${host}:${HTTPS_DEFAULT_PORT}`]);
  for (const extra of extraHosts) hosts.add(normalizeHost(extra));
  return { origins: new Set([normalized]), hosts };
}

/** A request with a side effect: anything that is not a plain read, plus every socket upgrade. */
function isMutating(method: string, isUpgrade: boolean): boolean {
  if (isUpgrade) return true;
  const wanted = method.toUpperCase();
  return wanted !== METHOD_GET && wanted !== METHOD_HEAD;
}

/**
 * Whether the request's Origin and Host are ones this listener answers to.
 *
 * The loopback listener is lenient about a missing Origin and strict about one
 * that is present. That asymmetry is deliberate: a browser always sends Origin
 * on a socket handshake and on a cross-origin mutation, which is the attack
 * this closes, while curl, the health probe, and the test harness send none and
 * would break for no security gain. It buys nothing against a local program,
 * which can send whatever it likes, and is not meant to.
 *
 * The tunnel listener requires Origin on anything with a side effect and
 * tolerates its absence only on a plain read, because a top-level navigation
 * (following the scanned link) legitimately sends none.
 *
 * Host is checked on both. On the loopback listener that is the DNS-rebinding
 * defence for a well-known port, and it is the only check a socket upgrade gets
 * at all, since the upgrade path never reaches the node-server host parsing.
 */
export function originVerdict(input: OriginVerdictInput): OriginVerdict {
  const policy = input.listener === 'local' ? input.local : input.tunnel;
  // Before the tunnel names itself there is no legitimate traffic to serve and
  // no origin to compare against, so the listener answers nothing at all.
  if (policy === undefined) return 'not-ready';

  if (input.host === undefined || !policy.hosts.has(normalizeHost(input.host))) return 'bad-host';

  if (input.origin === undefined) {
    if (input.listener === 'local') return 'allow';
    return isMutating(input.method, input.isUpgrade) ? 'bad-origin' : 'allow';
  }

  const origin = normalizeOrigin(input.origin);
  if (origin === undefined || !policy.origins.has(origin)) return 'bad-origin';
  return 'allow';
}
