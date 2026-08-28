import type { Context, MiddlewareHandler } from 'hono';
import { stepUpActionFor, type StepUpAction } from '../services/webauthnPolicy.ts';
import {
  PROTOCOL_SOCKET_ROUTE,
  REMOTE_CHANNEL_ROUTE,
  REMOTE_HTTP_ROUTE,
  SESSION_SOCKET_ROUTE,
  STEP_UP_HEADER,
  type RemoteChannelScope,
} from '../types/remoteAccess.ts';
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

/** Resolves the paired device carried by a tunnel request. */
export type RemoteAuthorizer = (context: Context) => string | undefined;

export interface RemoteGuardOptions {
  /** The loopback listener's bound port. Undefined until it binds, which fails closed. */
  loopbackPort: () => number | undefined;
  /** The tunnel listener's origin policy, or undefined while remote access is off. */
  tunnelPolicy: () => OriginPolicy | undefined;
  /** Absent while remote access is off, in which case nothing on the tunnel listener is served. */
  authorize?: RemoteAuthorizer;
  /** Identifies an already authenticated request created inside the sealed HTTP gateway. */
  trustedDevice?: RemoteAuthorizer;
  /** A remote socket is admitted only after its purpose-bound channel exists. */
  channelReady?: (deviceId: string, scope: RemoteChannelScope) => boolean;
  /** Additional origins the operator has allowed, from DOOMPI_WEB_ALLOW_ORIGIN. */
  extraOrigins?: readonly string[];
  /**
   * Verifies a fresh gesture for one action. Absent, or answering false to
   * `required`, leaves the session cookie as the only check.
   */
  stepUp?: {
    required: (action: StepUpAction) => boolean;
    verify: (context: Context, action: StepUpAction, assertion: unknown) => Promise<boolean>;
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

function socketChannelScope(path: string, isUpgrade: boolean): RemoteChannelScope | undefined {
  if (!isUpgrade) return undefined;
  if (path === SESSION_SOCKET_ROUTE) return 'session';
  if (path === PROTOCOL_SOCKET_ROUTE) return 'protocol';
  return undefined;
}

function isDirectTunnelRoute(method: string, path: string, isUpgrade: boolean): boolean {
  if (isUpgrade) return path === SESSION_SOCKET_ROUTE || path === PROTOCOL_SOCKET_ROUTE;
  const normalizedMethod = method.toUpperCase();
  if ((normalizedMethod === 'GET' || normalizedMethod === 'HEAD') && !path.startsWith('/api/')) return true;
  return normalizedMethod === 'POST' && (path === REMOTE_CHANNEL_ROUTE || path === REMOTE_HTTP_ROUTE);
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

    const trustedDeviceId = options.trustedDevice?.(context);
    if (
      trustedDeviceId === undefined &&
      !isDirectTunnelRoute(context.req.method, context.req.path, isUpgradeRequest(context))
    ) {
      return context.json({ error: 'Remote HTTP requests must use the sealed gateway.' }, UNAUTHORIZED);
    }

    const deviceId = trustedDeviceId ?? options.authorize?.(context);
    if (deviceId === undefined) {
      return context.json({ error: 'This device is not paired.' }, UNAUTHORIZED);
    }
    const channelScope = socketChannelScope(context.req.path, isUpgradeRequest(context));
    if (channelScope !== undefined && options.channelReady?.(deviceId, channelScope) !== true) {
      return context.json({ error: 'This device has no sealed channel for that socket.' }, UNAUTHORIZED);
    }

    // A live session is not enough to redirect the machine's model traffic or
    // to start an agent in a directory of the caller's choosing. Both are
    // escalation paths out of "drive the agent" and into "own the machine".
    const action = stepUpActionFor(context.req.method, context.req.path);
    if (action !== undefined && options.stepUp?.required(action) === true) {
      const assertion = decodeAssertion(context.req.header(STEP_UP_HEADER));
      if (assertion === undefined || !(await options.stepUp.verify(context, action, assertion))) {
        return context.json({ error: 'This action needs a fresh passkey gesture.', action }, UNAUTHORIZED);
      }
    }
    return next();
  };

  return { middleware, listenerOf: listenerFor };
}
