import type { Context, Hono } from 'hono';

import { DEV_PROXY_PREFIX, DEV_PROXY_TARGETS_ROUTE } from '../constants/remote';
import { parseProxyPath, validateTargetName, validateTargetPort } from '../services/devProxyPolicy';
import type { DevProxyStore } from '../services/devProxyStore';
import type { GuardListener } from '../services/remoteGuardPolicy';
import type { DevProxyTarget } from '../types/remote';
import { forwardToDevServer } from './devProxyForward';

/**
 * The dev proxy's control plane and its HTTP forwarding route.
 *
 * Registering a target is refused anywhere but the host, and that refusal is the entire consent
 * model: putting a local port on the public internet is decided by someone sitting at the machine.
 * A passkey gesture cannot carry it, because a quick tunnel's rotating hostname has no relying party.
 * Using a registered target is then open to any paired device, which is what makes the feature
 * usable away from the desk; a stolen phone reaches only the ports its owner chose to name.
 */

const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const CREATED = 201;
const NO_CONTENT = 204;
const MOVED_PERMANENTLY = 301;
const BAD_GATEWAY = 502;
const CONNECTION_REFUSED = 'ECONNREFUSED';

export interface DevProxyRoutesOptions {
  store: DevProxyStore;
  listenerOf: (context: Context) => GuardListener;
  /** Ports the cockpit itself holds, read per call so a toggled tunnel is never stale. */
  reservedPorts: () => readonly (number | undefined)[];
  onNotice: (message: string) => void;
}

interface TargetRequestBody {
  name?: unknown;
  port?: unknown;
}

/** The scheme the browser used, trusting the edge's header only for its own hop. */
function forwardedProto(context: Context, listener: GuardListener): string {
  const declared = context.req.header('x-forwarded-proto');
  if (declared === 'https' || declared === 'http') return declared;
  return listener === 'local' ? 'http' : 'https';
}

function describeUpstreamFailure(error: unknown, target: DevProxyTarget): string {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === CONNECTION_REFUSED) {
    return `Nothing is answering on port ${String(target.port)}. Is "${target.name}" running?`;
  }
  return `The dev server for "${target.name}" did not answer: ${error instanceof Error ? error.message : String(error)}`;
}

export function registerDevProxyRoutes(app: Hono, options: DevProxyRoutesOptions): void {
  const { store } = options;
  const isLocal = (context: Context): boolean => options.listenerOf(context) === 'local';

  app.get(DEV_PROXY_TARGETS_ROUTE, (context) =>
    context.json({ targets: store.targets(), canRegister: isLocal(context) }),
  );

  app.post(DEV_PROXY_TARGETS_ROUTE, async (context) => {
    if (!isLocal(context)) {
      return context.json(
        { error: 'A dev proxy target can only be added on the host, not through the tunnel.' },
        FORBIDDEN,
      );
    }
    let body: TargetRequestBody;
    try {
      body = (await context.req.json()) as TargetRequestBody;
    } catch {
      return context.json({ error: 'Expected a JSON body with a name and a port.' }, BAD_REQUEST);
    }
    const name = validateTargetName(body.name);
    if (!name.ok) return context.json({ error: name.reason }, BAD_REQUEST);
    const port = validateTargetPort(body.port, options.reservedPorts());
    if (!port.ok) return context.json({ error: port.reason }, BAD_REQUEST);

    const target: DevProxyTarget = { name: name.name, port: port.port, createdAt: Date.now() };
    store.save(target);
    options.onNotice(`dev proxy target "${target.name}" now serves port ${String(target.port)}`);
    return context.json({ target }, CREATED);
  });

  app.delete(`${DEV_PROXY_TARGETS_ROUTE}/:name`, (context) => {
    if (!isLocal(context)) {
      return context.json({ error: 'A dev proxy target can only be removed on the host.' }, FORBIDDEN);
    }
    const name = validateTargetName(context.req.param('name'));
    if (!name.ok) return context.json({ error: name.reason }, BAD_REQUEST);
    if (!store.remove(name.name)) return context.json({ error: 'No such dev proxy target.' }, NOT_FOUND);
    options.onNotice(`dev proxy target "${name.name}" removed`);
    return context.body(null, NO_CONTENT);
  });

  app.all(`${DEV_PROXY_PREFIX}*`, async (context) => {
    const url = new URL(context.req.url);
    const parsed = parseProxyPath(url.pathname);
    if (parsed.kind === 'reject') return context.text(parsed.reason, BAD_REQUEST);
    if (parsed.kind === 'redirect') return context.redirect(parsed.location, MOVED_PERMANENTLY);

    const target = store.find(parsed.name);
    if (target === undefined) return context.text(`No dev proxy target named "${parsed.name}".`, NOT_FOUND);

    try {
      return await forwardToDevServer({
        name: target.name,
        port: target.port,
        upstreamPath: `${parsed.upstreamPath}${url.search}`,
        method: context.req.method,
        headers: context.req.raw.headers,
        body: context.req.raw.body,
        forwardedProto: forwardedProto(context, options.listenerOf(context)),
        forwardedHost: context.req.header('host'),
        signal: context.req.raw.signal,
      });
    } catch (error) {
      const message = describeUpstreamFailure(error, target);
      options.onNotice(message);
      return context.text(message, BAD_GATEWAY);
    }
  });
}
