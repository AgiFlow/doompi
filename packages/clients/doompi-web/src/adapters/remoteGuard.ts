import type { Context, MiddlewareHandler } from 'hono';
import { stepUpActionFor, type StepUpAction } from '../services/webauthnPolicy.ts';
import { STEP_UP_HEADER } from '../types/remoteAccess.ts';
import {
  type GuardListener,
  type OriginPolicy,
  isPublicPairingRoute,
  listenerOf,
  localOriginPolicy,
  originVerdict,
} from '../services/remoteGuardPolicy.ts';

/** What `@hono/node-server` and `@hono/node-ws` both put in the Hono env. */
interface NodeBindings {
  incoming?: { socket?: { localPort?: number } };
}

const WEBSOCKET_UPGRADE = 'websocket';
const FORBIDDEN = 403;
const UNAUTHORIZED = 401;

const REFUSAL: Readonly<Record<string, string>> = {
  'bad-origin': 'That origin may not reach this cockpit.',
  'bad-host': 'That host may not reach this cockpit.',
  'not-ready': 'Remote access is not accepting requests yet.',
};

/** Decides whether a request on the tunnel listener carries a live session. */
export type RemoteAuthorizer = (context: Context) => boolean;

export interface RemoteGuardOptions {
  /** The loopback listener's bound port. Undefined until it binds, which fails closed. */
  loopbackPort: () => number | undefined;
  /** The tunnel listener's origin policy, or undefined while remote access is off. */
  tunnelPolicy: () => OriginPolicy | undefined;
  /** Absent while remote access is off, in which case nothing on the tunnel listener is served. */
  authorize?: RemoteAuthorizer;
  /** Additional origins the operator has allowed, from DOOMPI_WEB_ALLOW_ORIGIN. */
  extraOrigins?: readonly string[];
  /**
   * Verifies a fresh gesture for one action. Absent, or answering false to
   * `required`, leaves the session cookie as the only check.
   */
  stepUp?: {
    required: (action: StepUpAction) => boolean;
    verify: (action: StepUpAction, assertion: unknown) => Promise<boolean>;
  };
}

export interface RemoteGuard {
  middleware: MiddlewareHandler;
  /** Which listener a request arrived on, for the socket factories to tag their connection. */
  listenerOf(context: Context): GuardListener;
}

function socketPortOf(context: Context): number | undefined {
  const env = context.env as NodeBindings | undefined;
  return env?.incoming?.socket?.localPort;
}

/** The assertion rides base64url-encoded, because a WebAuthn response is JSON with binary in it. */
function decodeAssertion(raw: string | undefined): unknown {
  if (raw === undefined || raw === '') return undefined;
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    // A malformed header is a failed gesture, not a server error.
    return undefined;
  }
}

function isUpgradeRequest(context: Context): boolean {
  return context.req.header('upgrade')?.toLowerCase() === WEBSOCKET_UPGRADE;
}

/**
 * The first middleware every request meets, on both listeners.
 *
 * Registering it before any route is the whole security property: Hono composes
 * matching handlers in registration order, so a middleware added after a
 * terminating handler never runs for that path.
 *
 * It runs on socket upgrades too. `@hono/node-ws` routes the upgrade through
 * `app.request(...)` and only completes the handshake when the matched handler
 * was `upgradeWebSocket`, so returning an ordinary response here refuses the
 * upgrade rather than merely answering it.
 */
export function createRemoteGuard(options: RemoteGuardOptions): RemoteGuard {
  const extraOrigins = options.extraOrigins ?? [];
  // The allowlist depends on the port actually bound, which the e2e fixture and
  // `--port 0` both make dynamic, so it is derived once the port is known and
  // then reused rather than rebuilt per request.
  let cached: { port: number; policy: OriginPolicy } | undefined;
  const localPolicyFor = (port: number): OriginPolicy => {
    if (cached?.port !== port) cached = { port, policy: localOriginPolicy(port, extraOrigins) };
    return cached.policy;
  };

  const listenerFor = (context: Context): GuardListener => listenerOf(socketPortOf(context), options.loopbackPort());

  const middleware: MiddlewareHandler = async (context, next) => {
    const listener = listenerFor(context);
    const loopbackPort = options.loopbackPort();
    const verdict = originVerdict({
      listener,
      method: context.req.method,
      isUpgrade: isUpgradeRequest(context),
      origin: context.req.header('origin'),
      // Never the parsed URL: on an upgrade `@hono/node-ws` builds it against
      // a hardcoded http://localhost, so the parsed host is always a lie.
      host: context.req.header('host'),
      local: localPolicyFor(loopbackPort ?? 0),
      tunnel: options.tunnelPolicy(),
    });
    if (verdict !== 'allow') return context.text(REFUSAL[verdict], FORBIDDEN);

    if (listener === 'local') return next();

    // `c.req.path` is the percent-decoded value Hono routed on. Comparing
    // anything else would let the guard and the router disagree about which
    // handler a request reaches.
    if (isPublicPairingRoute(context.req.method, context.req.path)) return next();

    if (options.authorize?.(context) !== true) {
      return context.json({ error: 'This device is not paired.' }, UNAUTHORIZED);
    }

    // A live session is not enough to redirect the machine's model traffic or
    // to start an agent in a directory of the caller's choosing. Both are
    // escalation paths out of "drive the agent" and into "own the machine".
    const action = stepUpActionFor(context.req.method, context.req.path);
    if (action !== undefined && options.stepUp?.required(action) === true) {
      const assertion = decodeAssertion(context.req.header(STEP_UP_HEADER));
      if (assertion === undefined || !(await options.stepUp.verify(action, assertion))) {
        return context.json({ error: 'This action needs a fresh passkey gesture.', action }, UNAUTHORIZED);
      }
    }
    return next();
  };

  return { middleware, listenerOf: listenerFor };
}
