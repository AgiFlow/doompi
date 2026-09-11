import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@earendil-works/pi-client';
import { WebSocketServer } from 'ws';
import { WSContext } from 'hono/ws';
import { DoomSessionManagementService } from '@agimon-ai/doompi-extension-contracts/session-protocol';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createFederationStore } from '../../src/adapters/federationStore.ts';
import { connectFederationPeer, createFederationTransport } from '../../src/adapters/federationTransport.ts';
import {
  createFederationHubService,
  createFederationProtocol,
  createFederationClientTransport,
} from '../../src/adapters/federationProtocol.ts';
import { parsePeerAgentCatalog } from '../../src/services/agentCatalog.ts';
import type { SessionRecord } from '../../src/types/registry.ts';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
const store = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-protocol-'));
  directories.push(directory);
  return createFederationStore(directory);
};

describe('federation protocol admission', () => {
  it('promotes once, seals both directions, restricts agents, and invalidates on revocation', async () => {
    const local = store();
    const remote = store();
    const peer = { ...remote.identity(), name: 'remote', origin: 'https://peer.example', agentIds: [] };
    local.enroll(peer);
    remote.enroll({ ...local.identity(), name: 'local', origin: 'https://local.example', agentIds: ['agent'] });
    const records: SessionRecord[] = [
      {
        version: 1,
        id: 'agent',
        name: 'agent',
        cwd: '/private/project',
        socketPath: '/private/socket',
        tokenFile: '/private/token',
        pid: 1,
        createdAt: '2026-09-10T00:00:00Z',
      },
    ];
    const server = createFederationTransport({ store: remote, records: () => records });
    const client = await connectFederationPeer({
      store: local,
      peer,
      fetch: async (_url, init) => {
        const result = await server.handle(JSON.parse(init?.body as string));
        return new Response(JSON.stringify(result.body), { status: result.status });
      },
    });
    const promoted = await client.promote();
    const close = vi.fn();
    const admission = await server.promote(promoted.hello, close);
    await expect(server.promote(promoted.hello, close)).rejects.toThrow('Federation session is already promoted.');
    const bytes = new TextEncoder().encode('protocol bytes');
    expect(() => admission.assertAgent('not-granted')).toThrow('not granted');
    const host = createFederationHubService(admission, () => records, vi.fn());
    await expect(host.resolveSession('not-granted', BACKGROUND_CONTEXT)).rejects.toThrow('not granted');
    await expect(host.resolveSession('agent', BACKGROUND_CONTEXT)).resolves.toMatchObject({ id: 'agent' });
    expect(admission.stream.open(promoted.stream.seal(bytes))).toEqual(bytes);
    expect(promoted.stream.open(admission.stream.seal(bytes))).toEqual(bytes);
    await expect(client.catalog()).rejects.toThrow('closed');
    remote.revoke(local.identity().hubId);
    expect(() => admission.stream.seal(bytes)).toThrow('authorization');
    expect(close).toHaveBeenCalledOnce();
    server.close();
    client.close();
  });

  it('evicts an unauthenticated protocol promotion attempt', async () => {
    const local = store();
    const remote = store();
    const peer = { ...remote.identity(), name: 'remote', origin: 'https://peer.example', agentIds: ['agent'] };
    local.enroll(peer);
    remote.enroll({ ...local.identity(), name: 'local', origin: 'https://local.example', agentIds: ['agent'] });
    const server = createFederationTransport({ store: remote, records: () => [] });
    const client = await connectFederationPeer({
      store: local,
      peer,
      fetch: async (_url, init) => {
        const result = await server.handle(JSON.parse(init?.body as string));
        return new Response(JSON.stringify(result.body), { status: result.status });
      },
    });
    const promoted = await client.promote();
    await expect(server.promote({ ...promoted.hello, envelope: {} }, vi.fn())).rejects.toThrow('proof');
    await expect(server.promote(promoted.hello, vi.fn())).rejects.toThrow('Federation session is not active.');
    server.close();
    client.close();
  });

  it('rejects transitive catalogs and strips machine-local metadata', () => {
    const hubId = store().identity().hubId;
    const catalog = {
      version: 1,
      hubId,
      cwd: '/secret',
      agents: [
        {
          version: 1,
          hubId,
          agentId: 'a',
          name: 'Agent',
          project: 'project',
          status: 'live',
          createdAt: '2026-09-10T00:00:00Z',
          pid: 7,
          tokenFile: '/secret/token',
        },
      ],
    };
    expect(JSON.stringify(parsePeerAgentCatalog(catalog, hubId))).not.toContain('secret');
    expect(JSON.stringify(parsePeerAgentCatalog(catalog, hubId))).not.toContain('pid');
    expect(() =>
      parsePeerAgentCatalog({ ...catalog, agents: [{ ...catalog.agents[0], hubId: 'another-peer' }] }, hubId),
    ).toThrow('transitive');
  });
  it('runs the actual Pi handshake over a native sealed socket and closes it on revocation', async () => {
    const local = store();
    const remote = store();
    const transport = createFederationTransport({ store: remote, records: () => [] });
    const protocol = createFederationProtocol({ transport, store: remote, records: () => [], onNotice: vi.fn() });
    const sockets = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => sockets.once('listening', resolve));
    const address = sockets.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
    const origin = `http://127.0.0.1:${address.port}`;
    const peer = { ...remote.identity(), name: 'remote', origin, agentIds: [] };
    local.enroll(peer);
    remote.enroll({ ...local.identity(), name: 'local', origin: 'https://local.example', agentIds: ['allowed'] });
    sockets.on('connection', (raw) => {
      const events = protocol.events();
      const ws = new WSContext({ raw, readyState: 1, send: (data) => raw.send(data), close: () => raw.close() });
      raw.on('message', (data) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        events.onMessage?.(new MessageEvent('message', { data: bytes.toString('utf8') }), ws);
      });
      raw.on('close', () => events.onClose?.(new Event('close') as CloseEvent, ws));
      raw.on('error', () => events.onError?.(new Event('error'), ws));
      events.onOpen?.(new Event('open'), ws);
    });
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const result = await transport.handle(JSON.parse(init?.body as string));
      return new Response(JSON.stringify(result.body), { status: result.status });
    });
    const client = new Client({
      serverId: remote.identity().hubId,
      transportFactory: createFederationClientTransport({ store: local, peer }),
    });
    try {
      await client.connect();
      expect(client.connected).toBe(true);
      await expect(
        client.request(
          { serverId: remote.identity().hubId },
          {
            serviceId: DoomSessionManagementService.id,
            member: 'attach',
            args: ['not-granted'],
          },
        ),
      ).rejects.toThrow();
      remote.revoke(local.identity().hubId);
      transport.closePeer(local.identity().hubId);
      await vi.waitFor(() => expect(client.connected).toBe(false));
    } finally {
      await client.dispose();
      protocol.close();
      transport.close();
      await new Promise<void>((resolve, reject) => sockets.close((error) => (error ? reject(error) : resolve())));
    }
  });
  it('refuses an upgrade that opens after protocol shutdown', () => {
    const remote = store();
    const transport = createFederationTransport({ store: remote, records: () => [] });
    const protocol = createFederationProtocol({ transport, store: remote, records: () => [], onNotice: vi.fn() });
    const events = protocol.events();
    protocol.close();
    const close = vi.fn();
    const ws = new WSContext<never>({ readyState: 1, send: vi.fn(), close });
    events.onOpen?.(new Event('open'), ws);
    expect(close).toHaveBeenCalledOnce();
    transport.close();
  });
});
