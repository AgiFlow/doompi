import { Client } from '@earendil-works/pi-client';
import { SessionNotFoundError } from '@earendil-works/pi-server';
import { parsePeerAgentCatalog } from '../services/agentCatalog.ts';
import type { AgentCatalogEntry, FederationPeer } from '../types/agentCatalog.ts';
import type { SessionSummary } from '../types/hub.ts';
import type { FederationStore } from './federationStore.ts';
import { connectFederationPeer } from './federationTransport.ts';
import { createFederationClientTransport } from './federationProtocol.ts';
import type { PiHubServiceOptions } from './piHubService.ts';

const CATALOG_TTL_MS = 30_000;
const DISCOVERY_CONCURRENCY = 4;

export function federatedSessionId(entry: Pick<AgentCatalogEntry, 'hubId' | 'agentId'>): string {
  return `peer:${entry.hubId}:${entry.agentId}`;
}

/** Only explicitly enrolled hubs are contacted. Their catalogs never enter the local registry. */
export function createFederationDirectory(options: {
  store: FederationStore;
  onNotice(message: string): void;
  onChanged?(): void;
}) {
  const catalogs = new Map<string, { peer: FederationPeer; expiresAt: number; agents: AgentCatalogEntry[] }>();
  const clients = new Map<Client, string>();
  const refreshControllers = new Map<string, AbortController>();
  let refreshing: Promise<void> | undefined;
  let refreshController: AbortController | undefined;
  let closed = false;
  const notify = (message: string): void => {
    try {
      options.onNotice(message);
    } catch {
      // Diagnostics must not prevent directory cleanup.
    }
  };
  const changed = (): void => {
    try {
      options.onChanged?.();
    } catch (error) {
      notify(`federation directory update failed: ${String(error)}`);
    }
  };
  const fingerprint = (peer: FederationPeer) =>
    JSON.stringify([peer.fingerprint, peer.origin, [...peer.agentIds].sort()]);
  const entries = (): AgentCatalogEntry[] => {
    if (closed) return [];
    return [...catalogs.values()].flatMap((catalog) => {
      const current = options.store.peer(catalog.peer.hubId);
      return current && fingerprint(current) === fingerprint(catalog.peer) && catalog.expiresAt > Date.now()
        ? catalog.agents
        : [];
    });
  };
  const invalidate = (hubId: string) => {
    catalogs.delete(hubId);
    refreshControllers.get(hubId)?.abort(new Error('Federation peer was invalidated.'));
    changed();
    for (const [client, id] of clients)
      if (id === hubId) {
        clients.delete(client);
        void client.dispose().catch((error: unknown) => notify(`peer client cleanup: ${String(error)}`));
      }
  };
  const refresh = (): Promise<void> => {
    if (closed) return Promise.reject(new Error('Federation directory is closed.'));
    if (refreshing) return refreshing;
    const currentRefresh = new AbortController();
    refreshController = currentRefresh;
    refreshing = (async () => {
      const peers = options.store.peers();
      for (const id of catalogs.keys()) if (!peers.some((peer) => peer.hubId === id)) invalidate(id);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, peers.length) }, async () => {
          for (;;) {
            const peer = peers[next++];
            if (!peer || closed || currentRefresh.signal.aborted) return;
            const peerRefresh = new AbortController();
            refreshControllers.set(peer.hubId, peerRefresh);
            let connection;
            try {
              const signal = AbortSignal.any([currentRefresh.signal, peerRefresh.signal]);
              connection = await connectFederationPeer({ store: options.store, peer, signal });
              const catalog = parsePeerAgentCatalog(await connection.catalog(), peer.hubId);
              await connection.disconnect();
              const current = options.store.peer(peer.hubId);
              if (!closed && !signal.aborted && current && fingerprint(current) === fingerprint(peer))
                catalogs.set(peer.hubId, { peer, expiresAt: Date.now() + CATALOG_TTL_MS, agents: catalog.agents });
            } catch (error) {
              if (!closed && !currentRefresh.signal.aborted && !peerRefresh.signal.aborted) {
                invalidate(peer.hubId);
                notify(`peer ${peer.hubId} discovery failed: ${String(error)}`);
              }
            } finally {
              if (refreshControllers.get(peer.hubId) === peerRefresh) refreshControllers.delete(peer.hubId);
              connection?.close();
              peerRefresh.abort();
            }
          }
        }),
      );
    })().finally(() => {
      if (refreshController === currentRefresh) refreshController = undefined;
      refreshing = undefined;
      changed();
    });
    return refreshing;
  };
  const find = (id: string) => {
    const entry = entries().find((agent) => federatedSessionId(agent) === id);
    if (!entry) throw new SessionNotFoundError('Remote agent is not in the current enrolled-peer catalog.');
    return entry;
  };
  const remote: NonNullable<PiHubServiceOptions['remote']> = {
    async resolve(id) {
      if (!entries().some((entry) => federatedSessionId(entry) === id)) await refresh();
      const entry = find(id);
      return { id, cwd: '', createdAt: Date.parse(entry.createdAt), storageVersion: 1 };
    },
    async connect(id) {
      const entry = find(id);
      const peer = options.store.peer(entry.hubId);
      if (!peer) throw new SessionNotFoundError('Peer is no longer enrolled.');
      const serverId = peer.hubId;
      const client = new Client({
        serverId,
        transportFactory: createFederationClientTransport({ store: options.store, peer }),
        onListenerError: (error) => notify(`peer ${peer.hubId} listener: ${error.message}`),
      });
      clients.set(client, peer.hubId);
      client.onConnectionStateChange((change) => {
        if (change.state === 'disconnected') clients.delete(client);
      });
      return { client, serverId, sessionId: entry.agentId };
    },
  };
  const timer = setInterval(() => {
    void refresh().catch((error: unknown) => notify(`peer discovery: ${String(error)}`));
  }, CATALOG_TTL_MS / 2);
  timer.unref();
  return {
    entries,
    summaries: (): SessionSummary[] =>
      entries().map((entry) => ({
        id: federatedSessionId(entry),
        name: `${options.store.peer(entry.hubId)?.name ?? entry.hubId}: ${entry.name}`,
        cwd: '',
        socketPath: '',
        createdAt: entry.createdAt,
        updatedAt: entry.createdAt,
        phase: 'idle',
        phaseSince: entry.createdAt,
        attach: 'connecting',
        pendingMessageCount: 0,
        everPrompted: true,
        awaitingInput: false,
      })),
    refresh,
    remote,
    invalidate,
    close() {
      closed = true;
      clearInterval(timer);
      refreshController?.abort(new Error('Federation directory is closed.'));
      for (const controller of refreshControllers.values())
        controller.abort(new Error('Federation directory is closed.'));
      for (const id of [...catalogs.keys(), ...clients.values()]) invalidate(id);
    },
  };
}
