import { randomBytes } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { sanitizeUserAgent } from '../services/deviceSessions.ts';
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
  REMOTE_API_ROUTE,
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
/** Cloudflare's edge address. Display only; see the sanitizer for why. */
const EDGE_IP_HEADER = 'cf-connecting-ip';
/** Fallback wait before a remote-initiated shutdown, when the raw response is not reachable. */
const RESPONSE_FLUSH_GRACE_MS = 250;

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

  app.get(PAIRING_PAGE_ROUTE, (context) => {
    const nonce = randomBytes(NONCE_BYTES).toString('base64');
    return context.body(pairingPageHtml({ nonce }), 200, pairingPageHeaders(nonce));
  });

  app.post(PAIRING_CLAIM_ROUTE, async (context) => {
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
    return context.json({ status: 'approved' });
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
    if (minted === undefined) return context.json({ error: 'Remote access is not on.' }, CONFLICT);
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

  // Passkeys. Registration is local-only: enrolling a credential is granting
  // access, and a device that can grant access can make its own permanent.
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

  app.post(`${REMOTE_API_ROUTE}/passkeys/register/begin`, async (context) => {
    const refused = localOnly(context);
    if (refused) return refused;
    const options_ = await remote.passkeys().beginRegistration(labelFrom(context));
    if (options_ === undefined) return context.json({ error: remote.passkeys().support() }, CONFLICT);
    return context.json({ options: options_ });
  });

  app.post(`${REMOTE_API_ROUTE}/passkeys/register/finish`, async (context) => {
    const refused = localOnly(context);
    if (refused) return refused;
    const body = await readJson(context);
    if (body === undefined) return context.json({ error: 'The request body must be JSON.' }, BAD_REQUEST);
    const outcome = await remote.passkeys().finishRegistration(body.response, labelFrom(context));
    if (!outcome.ok) return context.json({ error: outcome.error }, BAD_REQUEST);
    return context.json({ id: outcome.id });
  });

  // Sign-in is reachable unauthenticated on purpose: proving a registered
  // passkey is how a returning device gets a session without another QR.
  app.post(PASSKEY_AUTH_BEGIN_ROUTE, async (context) => {
    const options_ = await remote.passkeys().beginAuthentication();
    if (options_ === undefined) return context.json({ error: 'Passkeys are unavailable.' }, CONFLICT);
    return context.json({ options: options_ });
  });

  app.post(PASSKEY_AUTH_FINISH_ROUTE, async (context) => {
    const body = await readJson(context);
    if (body === undefined) return context.json({ error: 'The request body must be JSON.' }, BAD_REQUEST);
    const outcome = await remote.passkeys().finishAuthentication(body.response);
    if (!outcome.ok) return context.json({ error: outcome.error }, UNAUTHORIZED);
    const session = remote.sessionForPasskey(outcome.credential.label);
    setCookie(context, DEVICE_COOKIE, session.token, {
      prefix: 'host',
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: session.maxAgeSeconds,
    });
    return context.json({ ok: true });
  });

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
    const options_ = await remote.passkeys().beginStepUp(body.action);
    if (options_ === undefined) return context.json({ error: 'Passkeys are unavailable.' }, CONFLICT);
    return context.json({ options: options_ });
  });

  /**
   * Completes the sealed channel for the calling device.
   *
   * Unsealed by necessity: this is the request that establishes sealing. It
   * carries only a public key, which is safe for the relay to see, and it is
   * useless without the host key the device read off the QR.
   */
  app.post(`${REMOTE_API_ROUTE}/channel`, async (context) => {
    const device = remote.authorize(getCookie(context, DEVICE_COOKIE, 'host'));
    if (device === undefined) return context.json({ error: 'This device is not paired.' }, UNAUTHORIZED);
    const body = await readJson(context);
    if (body === undefined || typeof body.clientPublicKey !== 'string') {
      return context.json({ error: 'A clientPublicKey string is required.' }, BAD_REQUEST);
    }
    if (!remote.openChannel(device, body.clientPublicKey)) {
      return context.json({ error: 'That key did not complete a channel.' }, BAD_REQUEST);
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
