import { randomBytes } from 'node:crypto';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { timeout } from 'hono/timeout';
import { sanitizeEdgeIp, sanitizeUserAgent } from '../services/deviceSessions.ts';
import { pairingPageHeaders, pairingPageHtml } from '../services/pairingPage.ts';
import type { GuardListener } from '../services/remoteGuardPolicy.ts';
import { isStepUpAction } from '../services/webauthnPolicy.ts';
import {
  DEVICE_COOKIE,
  PAIRING_CLAIM_ROUTE,
  PAIRING_PAGE_ROUTE,
  PAIRING_STATUS_QUERY,
  PAIRING_STATUS_ROUTE,
  PASSKEY_AUTH_BEGIN_ROUTE,
  PASSKEY_AUTH_FINISH_ROUTE,
  PASSKEY_REGISTER_BEGIN_ROUTE,
  PASSKEY_REGISTER_FINISH_ROUTE,
  REMOTE_API_ROUTE,
  REMOTE_CHANNEL_ROUTE,
  type RemoteChannelScope,
} from '../types/remoteAccess.ts';
import type { RemoteAccess } from './remoteAccess.ts';

const NONCE_BYTES = 16;
const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const CONFLICT = 409;
const GONE = 410;
const TOO_MANY = 429;
const BAD_GATEWAY = 502;
const UNAUTHORIZED = 401;
const ACCEPTED = 202;
const CREATED = 201;
/** Trusted Cloudflare client address, used for display and public abuse throttling only. */
const EDGE_IP_HEADER = 'cf-connecting-ip';
const PAYLOAD_TOO_LARGE = 413;
const REQUEST_TIMEOUT = 408;
const PUBLIC_REQUEST_CONCURRENCY = 8;
const PUBLIC_REQUEST_TIMEOUT_MS = 5000;
const PAIRING_BODY_BYTES = 2 * 1024;
const CHANNEL_BODY_BYTES = 4 * 1024;
const PASSKEY_BEGIN_BODY_BYTES = 256;
const PASSKEY_FINISH_BODY_BYTES = 64 * 1024;
const CEREMONY_CALLER_COOKIE = 'doompi_ceremony_caller';
const CEREMONY_CALLER_TOKEN = /^[A-Za-z0-9_-]{22}$/u;
const CEREMONY_CALLER_MAX_AGE_SECONDS = 10 * 60;
const PUBLIC_BEGIN_LIMIT = 10;
const PUBLIC_BEGIN_WINDOW_MS = 60_000;
const PUBLIC_BEGIN_SOURCE_LIMIT = 1024;
/** Fallback wait before a remote-initiated shutdown, when the raw response is not reachable. */
const RESPONSE_FLUSH_GRACE_MS = 250;
const CHANNEL_SCOPES: ReadonlySet<RemoteChannelScope> = new Set(['session', 'protocol', 'http']);

interface NodeRequestBindings {
  incoming?: { socket?: { remoteAddress?: string } };
  sealedDeviceId?: string;
}

function isChannelScope(value: unknown): value is RemoteChannelScope {
  return typeof value === 'string' && CHANNEL_SCOPES.has(value as RemoteChannelScope);
}

export interface RemoteRoutesOptions {
  remote: RemoteAccess;
  /** Which listener a request arrived on, so control-plane routes can stay local. */
  listenerOf: (context: Context) => GuardListener;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(context: Context): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await context.req.json();
    return isRecord(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs an action once this response has reached the wire.
 *
 * Both callers tear down the listener carrying their own response, and the
 * difference between a confirmed answer and a socket error the caller cannot
 * distinguish from a failure is doing it in this order.
 */
function afterResponse(context: Context, action: () => void): void {
  const outgoing = (context.env as { outgoing?: { once: (event: string, listener: () => void) => void } }).outgoing;
  if (outgoing === undefined) {
    setTimeout(action, RESPONSE_FLUSH_GRACE_MS);
    return;
  }
  outgoing.once('finish', action);
}

/** What the credential is called in the device list; the user agent is the only hint available. */
function labelFrom(context: Context): string {
  return sanitizeUserAgent(context.req.header('user-agent'));
}

/**
 * Cloudflare's normalized client address on the tunnel listener, with the
 * actual socket peer as the fallback for local and direct requests.
 *
 * A local process can forge the Cloudflare header, but local processes are
 * already outside this internet-client throttle boundary. Cloudflare is the
 * trusted proxy and overwrites this header for public requests.
 */
function sourceAddressOf(context: Context, listener: GuardListener): string | undefined {
  const socketPeer = (context.env as NodeRequestBindings | undefined)?.incoming?.socket?.remoteAddress;
  if (listener !== 'tunnel') return socketPeer;
  const edgeAddress = sanitizeEdgeIp(context.req.header(EDGE_IP_HEADER));
  return edgeAddress === 'unknown' ? socketPeer : `cloudflare:${edgeAddress}`;
}

function limitedJsonBody(maxSize: number): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: (context) => context.json({ error: 'The request body is too large.' }, PAYLOAD_TOO_LARGE),
  });
}

function createPublicRequestBudget(isLocal: (context: Context) => boolean): MiddlewareHandler {
  let active = 0;
  return async (context, next) => {
    if (isLocal(context)) return next();
    if (active >= PUBLIC_REQUEST_CONCURRENCY) {
      context.header('Retry-After', '1');
      return context.json({ error: 'Too many public requests are already in progress.' }, TOO_MANY);
    }
    active += 1;
    try {
      await next();
    } finally {
      active -= 1;
    }
  };
}

function createPublicBeginLimit(): (source: string) => boolean {
  const windows = new Map<string, { count: number; startedAt: number }>();
  return (source) => {
    const at = Date.now();
    let window = windows.get(source);
    if (window === undefined || at - window.startedAt >= PUBLIC_BEGIN_WINDOW_MS) {
      if (window === undefined && windows.size >= PUBLIC_BEGIN_SOURCE_LIMIT) {
        const oldest = windows.keys().next().value as string | undefined;
        if (oldest !== undefined) windows.delete(oldest);
      }
      window = { count: 0, startedAt: at };
      windows.delete(source);
      windows.set(source, window);
    }
    if (window.count >= PUBLIC_BEGIN_LIMIT) return false;
    window.count += 1;
    return true;
  };
}

/**
 * Registers the pairing surface and the remote-access control plane.
 *
 * Split by who may reach them, not by shape. The three pairing routes are the
 * only unauthenticated ones on the tunnel listener, so each is small, constant,
 * and echoes nothing from its request. The control plane is mostly local-only:
 * minting a code, approving, denying, and changing settings all stay at the
 * machine, because a device that can do them can make its own access permanent.
 * Turning remote access off and revoking a credential are allowed remotely, on
 * the grounds that a panic button is worth more from the phone than the desk.
 */
export function registerRemoteRoutes(app: Hono, options: RemoteRoutesOptions): void {
  const { remote } = options;
  const isLocal = (context: Context): boolean => options.listenerOf(context) === 'local';
  const localOnly = (context: Context): Response | undefined =>
    isLocal(context) ? undefined : context.json({ error: 'This action is only available on the host.' }, FORBIDDEN);
  const publicBudget = createPublicRequestBudget(isLocal);
  const publicBeginAllowed = createPublicBeginLimit();
  const publicDeadline = timeout(
    PUBLIC_REQUEST_TIMEOUT_MS,
    () =>
      new HTTPException(REQUEST_TIMEOUT, {
        res: Response.json({ error: 'The public request timed out.' }, { status: REQUEST_TIMEOUT }),
      }),
  );
  const authenticatedCeremonyCaller = (context: Context): string => {
    const trusted = (context.env as NodeRequestBindings | undefined)?.sealedDeviceId;
    const deviceId = trusted ?? remote.authorize(getCookie(context, DEVICE_COOKIE, 'host'));
    return deviceId === undefined ? 'local' : `device:${deviceId}`;
  };
  const registrationCaller = (context: Context): string | undefined => {
    const caller = authenticatedCeremonyCaller(context);
    return isLocal(context) || caller !== 'local' ? caller : undefined;
  };
  const publicCeremonyCaller = (context: Context, create: boolean): string | undefined => {
    let token = getCookie(context, CEREMONY_CALLER_COOKIE, 'host');
    if (token !== undefined && !CEREMONY_CALLER_TOKEN.test(token)) token = undefined;
    if (token === undefined && create) token = randomBytes(16).toString('base64url');
    if (token !== undefined && create) {
      setCookie(context, CEREMONY_CALLER_COOKIE, token, {
        prefix: 'host',
        httpOnly: true,
        sameSite: 'Strict',
        maxAge: CEREMONY_CALLER_MAX_AGE_SECONDS,
      });
    }
    return token === undefined ? undefined : `public:${token}`;
  };
  app.get(PAIRING_PAGE_ROUTE, (context) => {
    const nonce = randomBytes(NONCE_BYTES).toString('base64');
    const localTrust = options.listenerOf(context) === 'local' ? remote.bundleTrust() : undefined;
    return context.body(
      pairingPageHtml({ nonce, ...(localTrust === undefined ? {} : { localTrust }) }),
      200,
      pairingPageHeaders(nonce),
    );
  });

  app.post(PAIRING_CLAIM_ROUTE, publicBudget, publicDeadline, limitedJsonBody(PAIRING_BODY_BYTES), async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'The request body must be JSON.' }, BAD_REQUEST);
    }
    if (!isRecord(body) || typeof body.code !== 'string' || body.code === '') {
      return context.json({ error: 'A code string is required.' }, BAD_REQUEST);
    }
    const outcome = remote.claim({
      code: body.code,
      userAgent: context.req.header('user-agent'),
      edgeIp: context.req.header(EDGE_IP_HEADER),
      sourceAddress: sourceAddressOf(context, options.listenerOf(context)),
    });
    if (outcome.ok) return context.json({ requestId: outcome.requestId, status: 'pending' }, ACCEPTED);
    if (outcome.code === 'unknown_code') return context.json({ error: 'That code is not valid.' }, GONE);
    return context.json({ error: 'Too many attempts.' }, TOO_MANY);
  });

  app.get(PAIRING_STATUS_ROUTE, (context) => {
    const requestId = context.req.query(PAIRING_STATUS_QUERY);
    if (requestId === undefined) return context.json({ error: 'A request id is required.' }, BAD_REQUEST);
    const status = remote.pairingStatus(requestId);
    if (status === undefined) return context.json({ error: 'No such pairing request.' }, NOT_FOUND);
    if (status !== 'approved') return context.json({ status });
    const redeemed = remote.redeem(requestId);
    if (redeemed === undefined) return context.json({ status: 'consumed' });
    // Secure is a constant, never derived. cloudflared terminates TLS at the
    // edge and forwards plaintext, so the request scheme here is http and
    // x-forwarded-proto is attacker-controllable; hono's host prefix hardcodes
    // Secure, Path=/ and no Domain, and throws if they are contradicted.
    setCookie(context, DEVICE_COOKIE, redeemed.token, {
      prefix: 'host',
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: redeemed.maxAgeSeconds,
    });
    return context.json({
      status: 'approved',
      bundleTrust: remote.bundleTrust(),
      hostPublicKey: remote.channelPublicKey(),
    });
  });

  app.get(REMOTE_API_ROUTE, (context) => {
    // So a remote caller's own row can be marked "this device" and it cannot
    // revoke itself by accident while hunting for a stale one.
    const self = remote.authorize(getCookie(context, DEVICE_COOKIE, 'host'));
    return context.json({ state: remote.state(self, isLocal(context)) });
  });

  app.post(`${REMOTE_API_ROUTE}/enable`, async (context) => {
    const refused = localOnly(context);
    if (refused) return refused;
    const outcome = await remote.enable();
    if (!outcome.ok) return context.json({ error: outcome.error }, BAD_GATEWAY);
    // A contained cockpit answers here and moves afterwards, so the browser
    // learns the handover started before the server it asked goes away.
    if (remote.handoverPending()) {
      afterResponse(context, () => {
        remote.commitHandover();
      });
      return context.json({ state: remote.state(undefined, true), handingOver: true }, ACCEPTED);
    }
    return context.json({ state: remote.state(undefined, true) });
  });

  // Deliberately reachable from a paired device: this is the panic button.
  app.post(`${REMOTE_API_ROUTE}/disable`, async (context) => {
    if (isLocal(context)) {
      await remote.disable();
      return context.json({ state: remote.state(undefined, true) });
    }
    // Switching off from the phone tears down the listener carrying this very
    // response.
    afterResponse(context, () => void remote.disable());
    return context.json({ status: 'closing' }, ACCEPTED);
  });

  app.post(`${REMOTE_API_ROUTE}/codes`, (context) => {
    const refused = localOnly(context);
    if (refused) return refused;
    const minted = remote.mintPairing();
    if (minted === undefined)
      return context.json({ error: 'Remote access or signed bundle publication is unavailable.' }, CONFLICT);
    return context.json(minted, CREATED);
  });

  app.post(`${REMOTE_API_ROUTE}/pairing/:id/approve`, (context) => {
    const refused = localOnly(context);
    if (refused) return refused;
    const outcome = remote.approve(context.req.param('id'));
    if (outcome === 'approved') return context.json({ state: remote.state(undefined, true) });
    if (outcome === 'unknown') return context.json({ error: 'No such pairing request.' }, NOT_FOUND);
    return context.json({ error: `That request is ${outcome}.` }, CONFLICT);
  });

  app.post(`${REMOTE_API_ROUTE}/pairing/:id/deny`, (context) => {
    const refused = localOnly(context);
    if (refused) return refused;
    const outcome = remote.deny(context.req.param('id'));
    if (outcome === 'denied') return context.json({ state: remote.state(undefined, true) });
    if (outcome === 'unknown') return context.json({ error: 'No such pairing request.' }, NOT_FOUND);
    return context.json({ error: 'That request is already settled.' }, CONFLICT);
  });

  app.delete(`${REMOTE_API_ROUTE}/devices/:id`, (context) => {
    if (!remote.revokeDevice(context.req.param('id'))) {
      return context.json({ error: 'No such device.' }, NOT_FOUND);
    }
    return context.json({ state: remote.state(undefined, isLocal(context)) });
  });

  // Registration is direct so the approved phone can enrol before opening the
  // cockpit. On the tunnel listener, the device cookie remains mandatory.
  app.get(`${REMOTE_API_ROUTE}/passkeys`, (context) => {
    const passkeys = remote.passkeys();
    return context.json({
      support: passkeys.support(),
      credentials: passkeys.list().map(({ id, label, createdAt, lastUsedAt }) => ({
        id,
        label,
        createdAt: new Date(createdAt).toISOString(),
        lastUsedAt: new Date(lastUsedAt).toISOString(),
      })),
    });
  });

  app.post(
    PASSKEY_REGISTER_BEGIN_ROUTE,
    publicBudget,
    publicDeadline,
    limitedJsonBody(PASSKEY_BEGIN_BODY_BYTES),
    async (context) => {
      const caller = registrationCaller(context);
      if (caller === undefined) return context.json({ error: 'This device is not paired.' }, UNAUTHORIZED);
      const begun = await remote.passkeys().beginRegistration(caller, labelFrom(context));
      if (begun === undefined) return context.json({ error: remote.passkeys().support() }, CONFLICT);
      return context.json(begun);
    },
  );

  app.post(
    PASSKEY_REGISTER_FINISH_ROUTE,
    publicBudget,
    publicDeadline,
    limitedJsonBody(PASSKEY_FINISH_BODY_BYTES),
    async (context) => {
      const caller = registrationCaller(context);
      if (caller === undefined) return context.json({ error: 'This device is not paired.' }, UNAUTHORIZED);
      const body = await readJson(context);
      if (body === undefined || typeof body.ceremonyId !== 'string' || !('response' in body)) {
        return context.json({ error: 'A ceremonyId and response are required.' }, BAD_REQUEST);
      }
      const outcome = await remote
        .passkeys()
        .finishRegistration(body.ceremonyId, caller, body.response, labelFrom(context));
      if (!outcome.ok) return context.json({ error: outcome.error }, BAD_REQUEST);
      return context.json({ id: outcome.id });
    },
  );

  // Sign-in is reachable unauthenticated on purpose: proving a registered
  // passkey is how a returning device gets a session without another QR.
  app.post(
    PASSKEY_AUTH_BEGIN_ROUTE,
    publicBudget,
    publicDeadline,
    limitedJsonBody(PASSKEY_BEGIN_BODY_BYTES),
    async (context) => {
      const listener = options.listenerOf(context);
      const source = sourceAddressOf(context, listener) ?? 'unknown';
      if (listener === 'tunnel' && !publicBeginAllowed(source)) {
        context.header('Retry-After', '60');
        return context.json({ error: 'Too many passkey sign-in attempts. Try again shortly.' }, TOO_MANY);
      }
      const caller = publicCeremonyCaller(context, true);
      if (caller === undefined) return context.json({ error: 'Could not start this sign-in.' }, CONFLICT);
      const begun = await remote.passkeys().beginAuthentication(caller);
      if (begun === undefined) return context.json({ error: 'Passkeys are unavailable.' }, CONFLICT);
      return context.json(begun);
    },
  );

  app.post(
    PASSKEY_AUTH_FINISH_ROUTE,
    publicBudget,
    publicDeadline,
    limitedJsonBody(PASSKEY_FINISH_BODY_BYTES),
    async (context) => {
      const body = await readJson(context);
      if (body === undefined || typeof body.ceremonyId !== 'string' || !('response' in body)) {
        return context.json({ error: 'A ceremonyId and response are required.' }, BAD_REQUEST);
      }
      const caller = publicCeremonyCaller(context, false);
      if (caller === undefined)
        return context.json({ error: 'That sign-in was not started by this browser.' }, UNAUTHORIZED);
      const outcome = await remote.passkeys().finishAuthentication(body.ceremonyId, caller, body.response);
      if (!outcome.ok) return context.json({ error: outcome.error }, UNAUTHORIZED);
      const hostPublicKey = remote.channelPublicKey();
      if (hostPublicKey === undefined) return context.json({ error: 'Sealed channels are unavailable.' }, CONFLICT);
      const session = remote.sessionForPasskey(outcome.credential.label);
      setCookie(context, DEVICE_COOKIE, session.token, {
        prefix: 'host',
        httpOnly: true,
        sameSite: 'Lax',
        maxAge: session.maxAgeSeconds,
      });
      return context.json({ ok: true, hostPublicKey });
    },
  );

  app.delete(`${REMOTE_API_ROUTE}/passkeys/:id`, (context) => {
    const refused = localOnly(context);
    if (refused) return refused;
    if (!remote.passkeys().forget(context.req.param('id'))) {
      return context.json({ error: 'No such passkey.' }, NOT_FOUND);
    }
    return context.json({ ok: true });
  });

  /** A challenge bound to one action, so it cannot be replayed to authorise another. */
  app.post(`${REMOTE_API_ROUTE}/challenge`, async (context) => {
    const body = await readJson(context);
    if (body === undefined || !isStepUpAction(body.action)) {
      return context.json({ error: 'A known action is required.' }, BAD_REQUEST);
    }
    const begun = await remote.passkeys().beginStepUp(authenticatedCeremonyCaller(context), body.action);
    if (begun === undefined) return context.json({ error: 'Passkeys are unavailable.' }, CONFLICT);
    return context.json(begun);
  });

  /**
   * Completes the sealed channel for the calling device.
   *
   * Unsealed by necessity: this is the request that establishes sealing. It
   * carries only a public key, which is safe for the relay to see, and needs the
   * host key delivered by an approved QR or successful passkey sign-in.
   */
  app.post(REMOTE_CHANNEL_ROUTE, limitedJsonBody(CHANNEL_BODY_BYTES), async (context) => {
    const device = remote.authorize(getCookie(context, DEVICE_COOKIE, 'host'));
    if (device === undefined) return context.json({ error: 'This device is not paired.' }, UNAUTHORIZED);
    const body = await readJson(context);
    if (body === undefined || typeof body.clientPublicKey !== 'string' || !isChannelScope(body.scope)) {
      return context.json({ error: 'A clientPublicKey and known scope are required.' }, BAD_REQUEST);
    }
    if (!remote.openChannel(device, body.scope, body.clientPublicKey)) {
      return context.json({ error: 'That key did not complete a fresh channel.' }, BAD_REQUEST);
    }
    return context.json({ ok: true });
  });

  app.put(`${REMOTE_API_ROUTE}/settings`, async (context) => {
    const refused = localOnly(context);
    if (refused) return refused;
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'The request body must be JSON.' }, BAD_REQUEST);
    }
    if (!isRecord(body)) return context.json({ error: 'The settings must be an object.' }, BAD_REQUEST);
    const settings = remote.updateSettings(body);
    return context.json({ settings });
  });
}
