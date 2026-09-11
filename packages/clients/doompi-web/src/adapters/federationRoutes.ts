import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { projectAgentCatalog } from '../services/agentCatalog.ts';
import {
  parseFederationPeer,
  FEDERATION_MAX_BODY_BYTES,
  FEDERATION_TRANSPORT_ROUTE,
} from '../services/federationPolicy.ts';
import { AGENT_CATALOG_ROUTE, FEDERATION_IDENTITY_ROUTE, FEDERATION_PEERS_ROUTE } from '../types/agentCatalog.ts';
import type { SessionRecord } from '../types/registry.ts';
import type { FederationStore } from './federationStore.ts';
import type { FederationTransport } from './federationTransport.ts';
import type { createFederationDirectory } from './federationDirectory.ts';
export interface FederationRoutesOptions {
  store: FederationStore;
  records(): readonly SessionRecord[];
  transport?: FederationTransport;
  directory?: ReturnType<typeof createFederationDirectory>;
  /** The existing guard establishes locality, never a request header. */
  isLocal(context: Context): boolean;
  onNotice(message: string): void;
}

/** These are host administration routes, not a peer-authentication bypass around the device guard. */
export function registerFederationRoutes(app: Hono, options: FederationRoutesOptions): void {
  app.get(AGENT_CATALOG_ROUTE, (context) => {
    context.header('Cache-Control', 'no-store');
    return context.json(projectAgentCatalog(options.store.identity().hubId, options.records()));
  });
  app.post(FEDERATION_TRANSPORT_ROUTE, bodyLimit({ maxSize: FEDERATION_MAX_BODY_BYTES }), async (context) => {
    if (options.transport === undefined) return context.json({ error: 'Federation transport is unavailable.' }, 404);
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'The federation transport body must be JSON.' }, 400);
    }
    const result = await options.transport.handle(body, undefined, context.req.raw.signal);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
    });
  });
  for (const route of [
    FEDERATION_IDENTITY_ROUTE,
    FEDERATION_PEERS_ROUTE,
    `${FEDERATION_PEERS_ROUTE}/*`,
    '/api/federation/agents',
  ]) {
    app.use(route, async (context, next) => {
      if (!options.isLocal(context)) return context.json({ error: 'Peer enrollment is host-local only.' }, 403);
      context.header('Cache-Control', 'no-store');
      return next();
    });
  }
  app.get('/api/federation/agents', async (context) => {
    if (!options.directory) return context.json({ error: 'Federation is disabled.' }, 404);
    await options.directory.refresh();
    return context.json({ agents: options.directory.entries() });
  });
  app.get(FEDERATION_IDENTITY_ROUTE, (context) => context.json(options.store.identity()));
  app.get(FEDERATION_PEERS_ROUTE, (context) => context.json({ peers: options.store.peers() }));
  app.post(FEDERATION_PEERS_ROUTE, bodyLimit({ maxSize: 160 * 1024 }), async (context) => {
    let peer;
    let expectedFingerprint: string | undefined;
    try {
      const body: unknown = await context.req.json();
      peer = parseFederationPeer(body);
      const expected = (body as Record<string, unknown>).expectedFingerprint;
      if (expected !== undefined && (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected))) {
        return context.json({ error: 'Invalid prior fingerprint.' }, 400);
      }
      expectedFingerprint = expected;
    } catch {
      return context.json(
        {
          error:
            'Invalid peer enrollment. Supply public identity, confirmed fingerprint, origin, name and explicit agent IDs.',
        },
        400,
      );
    }
    try {
      const saved = options.store.enroll(peer, expectedFingerprint);
      options.transport?.closePeer(saved.hubId);
      options.directory?.invalidate(saved.hubId);
      return context.json({ peer: saved }, 201);
    } catch (error) {
      options.onNotice(`peer enrollment refused: ${error instanceof Error ? error.message : String(error)}`);
      return context.json(
        { error: 'Peer enrollment was not saved. Check host diagnostics and the current peer fingerprint.' },
        409,
      );
    }
  });
  app.delete(`${FEDERATION_PEERS_ROUTE}/:hubId`, (context) => {
    try {
      const removed = options.store.revoke(context.req.param('hubId'));
      options.transport?.closePeer(context.req.param('hubId'));
      options.directory?.invalidate(context.req.param('hubId'));
      return context.json({ removed }, removed ? 200 : 404);
    } catch (error) {
      options.onNotice(`peer revocation failed: ${error instanceof Error ? error.message : String(error)}`);
      return context.json(
        { error: 'Revocation was not saved. Check host diagnostics; do not assume the peer was revoked.' },
        503,
      );
    }
  });
}
