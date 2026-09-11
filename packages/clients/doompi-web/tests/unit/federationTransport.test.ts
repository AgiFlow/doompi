import { generateKeyPairSync, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFederationTransport,
  connectFederationPeer,
  type FederationTransport,
} from '../../src/adapters/federationTransport.ts';
import { createFederationStore, type FederationStore } from '../../src/adapters/federationStore.ts';
import { federationIdentity } from '../../src/services/federationPolicy.ts';
import type { SessionRecord } from '../../src/types/registry.ts';

let directories: string[] = [];
beforeEach(() => {
  directories = [];
});
afterEach(() => {
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
});

const record = (id: string): SessionRecord => ({
  version: 1,
  id,
  name: `Agent ${id}`,
  cwd: '/not-exported/project',
  socketPath: '/not-exported/socket',
  apiSocketPath: '/not-exported/api',
  protocolSocketPath: '/not-exported/protocol',
  protocolServerId: 'not-exported-server',
  tokenFile: '/not-exported/token',
  pid: 1,
  createdAt: '2026-09-10T00:00:00.000Z',
});

function store(): FederationStore {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-federation-transport-'));
  directories.push(directory);
  return createFederationStore(directory);
}

function enrolled(identity: ReturnType<FederationStore['identity']>, name: string) {
  return { ...identity, name, origin: 'https://peer.example', agentIds: ['s1'] };
}

function bridge(server: FederationTransport): {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  lastMessage?: Record<string, unknown>;
  lastHello?: Record<string, unknown>;
} {
  let lastMessage: Record<string, unknown> | undefined;
  let lastHello: Record<string, unknown> | undefined;
  return {
    async fetch(_input, init) {
      const body = JSON.parse(await new Response(init?.body).text()) as Record<string, unknown>;
      if (body.type === 'message') lastMessage = body;
      if (body.type === 'hello') lastHello = body;
      const result = await server.handle(body);
      return new Response(JSON.stringify(result.body), { status: result.status });
    },
    get lastHello() {
      return lastHello;
    },
    get lastMessage() {
      return lastMessage;
    },
  };
}

describe('sealed federation transport', () => {
  it('pins both identities, seals catalog access, and never exports session metadata', async () => {
    const clientStore = store();
    const serverStore = store();
    const clientIdentity = clientStore.identity();
    const serverIdentity = serverStore.identity();
    clientStore.enroll(enrolled(serverIdentity, 'server'));
    serverStore.enroll(enrolled(clientIdentity, 'client'));
    const server = createFederationTransport({
      store: serverStore,
      records: () => [record('s1')],
    });
    const wire = bridge(server);
    const peer = { ...serverIdentity, name: 'server', origin: 'https://peer.example', agentIds: ['s1'] };
    const connection = await connectFederationPeer({ store: clientStore, peer, fetch: wire.fetch });

    await expect(connection.catalog()).resolves.toEqual({
      version: 1,
      hubId: serverIdentity.hubId,
      agents: [
        {
          version: 1,
          hubId: serverIdentity.hubId,
          agentId: 's1',
          name: 'Agent s1',
          project: 'project',
          createdAt: '2026-09-10T00:00:00.000Z',
          status: 'live',
        },
      ],
    });
    expect(JSON.stringify(await connection.catalog())).not.toContain('not-exported');
  });

  it('rejects replay and changed grants while permitting independent session connections', async () => {
    const clientStore = store();
    const serverStore = store();
    const clientIdentity = clientStore.identity();
    const serverIdentity = serverStore.identity();
    clientStore.enroll(enrolled(serverIdentity, 'server'));
    serverStore.enroll(enrolled(clientIdentity, 'client'));
    const server = createFederationTransport({
      store: serverStore,
      records: () => [record('s1')],
      onCall: async (payload, context) => ({ payload, agentId: context.agentId }),
    });
    const wire = bridge(server);
    const peer = { ...serverIdentity, name: 'server', origin: 'https://peer.example', agentIds: ['s1'] };
    const connection = await connectFederationPeer({ store: clientStore, peer, fetch: wire.fetch });
    await expect(connection.call('s1', { command: 'ok' })).resolves.toEqual({
      payload: { command: 'ok' },
      agentId: 's1',
    });
    const replay = await server.handle(wire.lastMessage);
    expect(replay.status).toBe(400);

    const second = await connectFederationPeer({ store: clientStore, peer, fetch: wire.fetch });
    expect(second.sessionId).not.toBe(connection.sessionId);
    await second.disconnect();
    await expect(connection.catalog()).resolves.toMatchObject({ hubId: serverIdentity.hubId });
    serverStore.enroll({ ...enrolled(clientIdentity, 'client'), agentIds: [] }, clientIdentity.fingerprint);
    await expect(connection.call('s1', { command: 'revoked' })).rejects.toThrow('401');
  });

  it.each(['challenge', 'welcome'])('refuses a %s signed by an identity other than the pinned one', async (stage) => {
    const clientStore = store();
    const serverStore = store();
    const clientIdentity = clientStore.identity();
    const serverIdentity = serverStore.identity();
    clientStore.enroll(enrolled(serverIdentity, 'server'));
    serverStore.enroll(enrolled(clientIdentity, 'client'));
    const server = createFederationTransport({ store: serverStore, records: () => [] });
    const wire = bridge(server);
    const peer = { ...serverIdentity, name: 'server', origin: 'https://peer.example', agentIds: ['s1'] };
    const malicious = generateKeyPairSync('ed25519');
    const forged = federationIdentity(
      randomUUID(),
      malicious.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    );
    const originalFetch = wire.fetch;
    await expect(
      connectFederationPeer({
        store: clientStore,
        peer,
        fetch: async (input, init) => {
          const response = await originalFetch(input, init);
          const body = (await response.json()) as Record<string, unknown>;
          if (body.type === stage) body.serverPublicKey = forged.publicKey;
          return new Response(JSON.stringify(body), { status: response.status });
        },
      }),
    ).rejects.toThrow('identity or signature');
  });
  it('serializes concurrent requests and uses remote grants rather than incoming local grants', async () => {
    const clientStore = store();
    const serverStore = store();
    const peer = { ...enrolled(serverStore.identity(), 'server'), agentIds: ['local-only'] };
    clientStore.enroll(peer);
    serverStore.enroll(enrolled(clientStore.identity(), 'client'));
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const calls: unknown[] = [];
    const server = createFederationTransport({
      store: serverStore,
      records: () => [record('s1')],
      onCall: async (payload) => {
        calls.push(payload);
        if (payload === 'first') {
          started();
          await held;
        }
        return payload;
      },
    });
    const wire = bridge(server);
    const connection = await connectFederationPeer({
      store: clientStore,
      peer,
      fetch: async (input, init) => {
        expect(init?.redirect).toBe('error');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return wire.fetch(input, init);
      },
    });
    const first = connection.call('s1', 'first');
    const second = connection.call('s1', 'second');
    await entered;
    expect(calls).toEqual(['first']);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    connection.close();
    await expect(connection.catalog()).rejects.toThrow('closed');
  });
  it('rejects requests beyond the bounded queue without reordering accepted requests', async () => {
    const clientStore = store();
    const serverStore = store();
    const peer = enrolled(serverStore.identity(), 'server');
    clientStore.enroll(peer);
    serverStore.enroll(enrolled(clientStore.identity(), 'client'));
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const calls: unknown[] = [];
    const server = createFederationTransport({
      store: serverStore,
      records: () => [record('s1')],
      onCall: async (payload) => {
        calls.push(payload);
        if (payload === 0) {
          started();
          await held;
        }
        return payload;
      },
    });
    const connection = await connectFederationPeer({ store: clientStore, peer, fetch: bridge(server).fetch });
    const requests = Array.from({ length: 33 }, (_, index) => connection.call('s1', index));
    await entered;
    expect(calls).toEqual([0]);
    await expect(requests[32]).rejects.toThrow('queue is full');
    release();
    await expect(Promise.all(requests.slice(0, 32))).resolves.toEqual(Array.from({ length: 32 }, (_, index) => index));
    connection.close();
  });

  it('withholds an in-flight result when authorization is revoked', async () => {
    const clientStore = store();
    const serverStore = store();
    const peer = enrolled(serverStore.identity(), 'server');
    clientStore.enroll(peer);
    serverStore.enroll(enrolled(clientStore.identity(), 'client'));
    const server = createFederationTransport({
      store: serverStore,
      records: () => [record('s1')],
      onCall: async () => {
        await Promise.resolve();
        serverStore.revoke(clientStore.identity().hubId);
        return 'must not leave the server';
      },
    });
    const connection = await connectFederationPeer({ store: clientStore, peer, fetch: bridge(server).fetch });
    await expect(connection.call('s1', null)).rejects.toThrow('401');
  });

  it('rejects captured hellos after transport restart without persisting replay memory', async () => {
    const clientStore = store();
    const serverStore = store();
    const peer = enrolled(serverStore.identity(), 'server');
    clientStore.enroll(peer);
    serverStore.enroll(enrolled(clientStore.identity(), 'client'));
    const server = createFederationTransport({ store: serverStore, records: () => [record('s1')] });
    const wire = bridge(server);
    const connection = await connectFederationPeer({ store: clientStore, peer, fetch: wire.fetch });
    const hello = wire.lastHello;
    expect(hello).toBeDefined();
    connection.close();
    server.closePeer(clientStore.identity().hubId);
    expect((await server.handle(hello)).status).toBe(409);
    server.close();

    const restarted = createFederationTransport({ store: serverStore, records: () => [record('s1')] });
    const rejected = await restarted.handle(hello);
    expect(rejected.status).toBe(401);
    expect(rejected.body.error).toContain('stale');
    const challenge = await restarted.handle({ v: 1, type: 'challenge' });
    expect(challenge.body.serverEpoch).not.toBe(hello?.serverEpoch);
    const rewritten = await restarted.handle({ ...hello, serverEpoch: challenge.body.serverEpoch });
    expect(rewritten.status).toBe(401);
    expect(rewritten.body.error).toContain('signature');
    const fresh = await connectFederationPeer({ store: clientStore, peer, fetch: bridge(restarted).fetch });
    await expect(fresh.catalog()).resolves.toMatchObject({ hubId: peer.hubId, agents: [{ agentId: 's1' }] });
    fresh.close();
    restarted.close();
  });

  it.each(['challenge', 'welcome'])('refuses a tampered server epoch in %s', async (stage) => {
    const clientStore = store();
    const serverStore = store();
    const peer = enrolled(serverStore.identity(), 'server');
    clientStore.enroll(peer);
    serverStore.enroll(enrolled(clientStore.identity(), 'client'));
    const server = createFederationTransport({ store: serverStore, records: () => [] });
    const wire = bridge(server);
    await expect(
      connectFederationPeer({
        store: clientStore,
        peer,
        fetch: async (input, init) => {
          const response = await wire.fetch(input, init);
          const body = (await response.json()) as Record<string, unknown>;
          if (body.type === stage) body.serverEpoch = Buffer.alloc(32).toString('base64url');
          return new Response(JSON.stringify(body), { status: response.status });
        },
      }),
    ).rejects.toThrow('identity or signature');
    server.close();
  });

  it.each(['challenge', 'welcome'])('rejects enrollment revoked during %s before returning a client', async (stage) => {
    const clientStore = store();
    const serverStore = store();
    const peer = enrolled(serverStore.identity(), 'server');
    clientStore.enroll(peer);
    serverStore.enroll(enrolled(clientStore.identity(), 'client'));
    const server = createFederationTransport({ store: serverStore, records: () => [] });
    const wire = bridge(server);
    const sent: unknown[] = [];
    await expect(
      connectFederationPeer({
        store: clientStore,
        peer,
        fetch: async (input, init) => {
          const response = await wire.fetch(input, init);
          const body = (await response.json()) as Record<string, unknown>;
          sent.push(body.type);
          if (body.type === stage) clientStore.revoke(peer.hubId);
          return new Response(JSON.stringify(body), { status: response.status });
        },
      }),
    ).rejects.toThrow('not currently enrolled');
    expect(sent).toEqual(stage === 'challenge' ? ['challenge'] : ['challenge', 'welcome']);
    server.close();
  });

  it('cancels oversized streamed responses without first buffering the whole body', async () => {
    const clientStore = store();
    const peer = enrolled(store().identity(), 'server');
    clientStore.enroll(peer);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(128 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      connectFederationPeer({ store: clientStore, peer, fetch: async () => new Response(body) }),
    ).rejects.toThrow('size limit');
    expect(cancelled).toBe(true);
  });
  it('aborts an in-flight handshake when discovery is cancelled', async () => {
    const clientStore = store();
    const peerStore = store();
    const peer = enrolled(peerStore.identity(), 'server');
    clientStore.enroll(peer);
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const connecting = connectFederationPeer({
      store: clientStore,
      peer,
      signal: controller.signal,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason));
        }),
    });
    controller.abort(new Error('discovery cancelled'));
    await expect(connecting).rejects.toThrow('discovery cancelled');
    expect(requestSignal?.aborted).toBe(true);
  });
});
