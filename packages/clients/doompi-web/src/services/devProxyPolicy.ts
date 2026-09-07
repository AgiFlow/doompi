/**
 * What the dev proxy will forward, and where.
 *
 * Pure, with no I/O, so the whole decision surface of a feature that reaches
 * loopback services can be read in one sitting and tested without a server.
 *
 * The upstream host is not a parameter anywhere in this module, and a target
 * is a port and nothing else. Accepting a hostname would mean resolving one,
 * and a resolver turns a fixed destination into an attacker-chosen one through
 * DNS rebinding, decimal and octal address spellings, and IPv4-mapped IPv6
 * forms. Refusing the parameter forecloses that family rather than filtering
 * it. Which of the two loopback literals actually answers is settled in
 * `loopbackAddress.ts`, from the port alone.
 */

import { DEV_PROXY_PREFIX } from '../types/devProxy.ts';

const MAX_NAME_LENGTH = 32;
/**
 * Lowercase, digits and dashes, opening on an alphanumeric.
 *
 * The name is a path segment and it is also what the developer types into
 * `base: '/devproxy/<name>/'`, so it stays in the character set that needs no
 * escaping in either place.
 */
const TARGET_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const MIN_PORT = 1;
const MAX_PORT = 65_535;

export type NameVerdict = { ok: true; name: string } | { ok: false; reason: string };

export type PortVerdict = { ok: true; port: number } | { ok: false; reason: string };

export type ProxyPathVerdict =
  | { kind: 'match'; name: string; /** The path unchanged, prefix included. */ upstreamPath: string }
  | { kind: 'redirect'; location: string }
  | { kind: 'reject'; reason: string };

export function validateTargetName(raw: unknown): NameVerdict {
  if (typeof raw !== 'string') return { ok: false, reason: 'A target name must be text.' };
  const name = raw.trim().toLowerCase();
  if (name === '') return { ok: false, reason: 'A target needs a name.' };
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: `A target name is at most ${String(MAX_NAME_LENGTH)} characters.` };
  }
  if (!TARGET_NAME.test(name)) {
    return {
      ok: false,
      reason: 'A target name uses lowercase letters, digits and dashes, starting with a letter or digit.',
    };
  }
  return { ok: true, name };
}

/**
 * Whether this port may be proxied.
 *
 * `reserved` is read fresh by the caller on every attempt rather than captured
 * once, because the cockpit's own ports are only known after it binds and the
 * tunnel port changes when remote access is toggled. A cached list would go
 * stale in exactly the direction that matters, letting the proxy point at the
 * cockpit itself.
 */
export function validateTargetPort(raw: unknown, reserved: readonly (number | undefined)[]): PortVerdict {
  const port = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(port)) return { ok: false, reason: 'A port must be a whole number.' };
  if (port < MIN_PORT || port > MAX_PORT) {
    return { ok: false, reason: `A port is between ${String(MIN_PORT)} and ${String(MAX_PORT)}.` };
  }
  if (reserved.includes(port)) return { ok: false, reason: 'That port belongs to the cockpit itself.' };
  return { ok: true, port };
}

/**
 * Whether a path segment tries to climb out of the prefix.
 *
 * Checked before and after percent-decoding. A proxy that only checked the raw
 * form would forward `%2e%2e`, and an upstream that decodes before resolving
 * would then walk out of the tree the operator meant to expose.
 */
function escapesPrefix(upstreamPath: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(upstreamPath);
  } catch {
    // A malformed percent sequence is not a path this proxy needs to serve.
    return true;
  }
  for (const candidate of [upstreamPath, decoded]) {
    for (const segment of candidate.split('/')) {
      if (segment === '.' || segment === '..') return true;
    }
  }
  return false;
}

/**
 * Whether this path is one the dev proxy owns.
 *
 * The remote guard and the proxy handler must agree about this, and they do not
 * see the same string: Hono's router hands the guard a raw slice of the request
 * line, while the handler reads `new URL(...).pathname`, which resolves `..`
 * before anyone looks at it. So `/devproxy/x/../../api/health` can be a proxy
 * path to one and an API path to the other, and a guard that answered on the
 * prefix alone would grant an `/api/` request the direct, unsealed treatment.
 *
 * Refusing every dot segment removes the disagreement instead of trying to
 * predict it. A legitimate asset URL has no reason to carry one.
 */
export function isDevProxyPath(path: string): boolean {
  if (!path.startsWith(DEV_PROXY_PREFIX)) return false;
  return !escapesPrefix(path.slice(DEV_PROXY_PREFIX.length));
}
/**
 * Identifies the target a proxied request belongs to.
 *
 * `upstreamPath` is the request path unchanged, prefix included. That is the
 * whole trick, and getting it wrong costs a redirect loop: the target is
 * configured with `base: '/devproxy/<name>/'`, so it believes it is serving
 * there and redirects anything at `/` back to its base. Stripping the prefix
 * would hand it `/`, take its redirect, and go round again. nginx draws the
 * same distinction between `proxy_pass http://host/` and `proxy_pass
 * http://host`; this is the second one.
 *
 * Reads the raw, still-encoded pathname. Hono routes and the remote guard both
 * work on the decoded value, so a request that only becomes `/devproxy/...`
 * after decoding would reach this handler, and passing the encoded form
 * through untouched is what makes a file named `a b.png` load.
 */
export function parseProxyPath(rawPathname: string): ProxyPathVerdict {
  if (!rawPathname.startsWith(DEV_PROXY_PREFIX)) return { kind: 'reject', reason: 'Not a proxied path.' };
  const rest = rawPathname.slice(DEV_PROXY_PREFIX.length);
  const boundary = rest.indexOf('/');

  if (boundary === -1) {
    const verdict = validateTargetName(rest);
    if (!verdict.ok) return { kind: 'reject', reason: verdict.reason };
    // A dev server serving at its own root needs the trailing slash, or every
    // relative URL on the page resolves one level too high. nginx answers the
    // same way rather than guessing.
    return { kind: 'redirect', location: `${DEV_PROXY_PREFIX}${verdict.name}/` };
  }

  const verdict = validateTargetName(rest.slice(0, boundary));
  if (!verdict.ok) return { kind: 'reject', reason: verdict.reason };
  if (escapesPrefix(rest.slice(boundary))) {
    return { kind: 'reject', reason: 'That path leaves the proxied target.' };
  }
  return { kind: 'match', name: verdict.name, upstreamPath: rawPathname };
}
