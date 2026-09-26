import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DoomHubChannelHost } from '@agimon-ai/doompi-core/hubChannel';
import { describe, expect, it, vi } from 'vitest';

import { createAuthorBridgeApi } from '../../src/extensions/workspaces/sessions/(backend)/api/author/_lib/authorBridgeApi';
import { createAuthorBridgeState } from '../../src/models/authorBridgeState';
import { createAuthorCanvasRegistry } from '../../src/services/authorCanvasRegistry';
import { createAuthorChannel } from '../../src/services/webAuthorChannel';

const scope = { sessionId: 'session', cwd: '/repo' };

async function harness() {
  const state = createAuthorBridgeState({
    now: Date.now,
    issueToken: vi.fn().mockReturnValueOnce('owner').mockReturnValueOnce('catalog').mockReturnValueOnce('request'),
    scheduleTimeout(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  });
  let first = true;
  const registry = createAuthorCanvasRegistry(path.resolve(fileURLToPath(import.meta.url), '..', '..', '..'), () => {
    if (first) {
      first = false;
      return state;
    }
    return createAuthorBridgeState({
      now: Date.now,
      issueToken: () => crypto.randomUUID(),
      scheduleTimeout(callback, delayMs) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    });
  });
  await registry.open('README.md', undefined, 'review');
  const app = createAuthorBridgeApi(registry);
  const targeted: unknown[] = [];
  const host: DoomHubChannelHost = {
    sessions: () => [scope],
    directEvents: {
      publish: () => undefined,
      subscribe: () => () => undefined,
      close: () => undefined,
    },
    publish: vi.fn(),
    publishToConnection(connectionId, sessionId, payload) {
      expect(connectionId).toBe('connection');
      expect(sessionId).toBe(scope.sessionId);
      targeted.push(payload);
      return true;
    },
    requestSessionApi: async (_scope, request) =>
      await app.fetch(
        new Request(`http://author.test${request.path}`, {
          method: request.method,
          body: request.body as string | undefined,
          signal: request.signal,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    onNotice: vi.fn(),
  };
  const channel = createAuthorChannel();
  const source = channel.start(host);
  const connection = { connectionId: 'connection' };
  return { state, registry, targeted, host, channel, source, connection };
}

describe('the Author targeted web hub bridge', () => {
  it('targets accepted and request frames only to the owning connection', async () => {
    const h = await harness();
    h.channel.receive!(scope, { alias: 'review', kind: 'register', generation: 1 }, h.connection);
    await vi.waitFor(() =>
      expect(h.targeted).toContainEqual(expect.objectContaining({ kind: 'accepted', ownerToken: 'owner' })),
    );
    h.channel.receive!(
      scope,
      {
        alias: 'review',
        kind: 'catalog',
        generation: 1,
        ownerToken: 'owner',
        tools: [{ name: 'replace_selection', label: 'Replace', description: 'Replace text', inputSchema: {} }],
      },
      h.connection,
    );
    await vi.waitFor(() => expect(h.targeted).toContainEqual(expect.objectContaining({ catalogToken: 'catalog' })));

    const invocation = h.state.invoke({ catalogToken: 'catalog', name: 'replace_selection', arguments: {} });
    await vi.waitFor(() =>
      expect(h.targeted).toContainEqual(expect.objectContaining({ kind: 'request', requestId: 'request' })),
    );
    h.channel.receive!(
      scope,
      {
        alias: 'review',
        kind: 'result',
        generation: 1,
        ownerToken: 'owner',
        catalogToken: 'catalog',
        requestId: 'request',
        result: { changed: true },
      },
      h.connection,
    );
    await expect(invocation).resolves.toMatchObject({ result: { changed: true } });
    expect(h.host.publish).not.toHaveBeenCalled();
    h.source.close();
  });

  it('releases the accepted catalog when the document viewport blurs', async () => {
    const h = await harness();
    h.channel.receive!(scope, { alias: 'review', kind: 'register', generation: 1 }, h.connection);
    await vi.waitFor(() => expect(h.targeted).toHaveLength(1));
    h.channel.receive!(scope, { alias: 'review', kind: 'release', generation: 1 }, h.connection);
    await vi.waitFor(() => expect(() => h.state.describe()).toThrow('No Author viewport'));
    h.source.close();
  });
  it('returns an actionable rejection for an unknown alias without installing a binding', async () => {
    const h = await harness();
    h.channel.receive!(scope, { alias: 'unknown', kind: 'register', generation: 1 }, h.connection);
    await vi.waitFor(() =>
      expect(h.targeted).toContainEqual(
        expect.objectContaining({
          alias: 'unknown',
          kind: 'rejected',
          reason: expect.stringContaining('Unknown Author canvas'),
        }),
      ),
    );
    h.source.close();
  });

  it('isolates two alias bindings on the same connection', async () => {
    const h = await harness();
    await h.registry.open('llms.txt', undefined, 'notes');
    h.channel.receive!(scope, { alias: 'review', kind: 'register', generation: 1 }, h.connection);
    await vi.waitFor(() =>
      expect(h.targeted).toContainEqual(expect.objectContaining({ alias: 'review', kind: 'accepted' })),
    );
    h.channel.receive!(scope, { alias: 'notes', kind: 'register', generation: 1 }, h.connection);
    await vi.waitFor(() =>
      expect(h.targeted).toContainEqual(expect.objectContaining({ alias: 'notes', kind: 'accepted' })),
    );
    h.channel.receive!(scope, { alias: 'review', kind: 'release', generation: 1 }, h.connection);
    await vi.waitFor(() => expect(() => h.registry.bridge('review').describe()).toThrow('No Author viewport'));
    expect(() => h.registry.bridge('notes').describe()).toThrow('no catalog');
    h.source.close();
  });

  it('releases the connection binding when its socket disconnects', async () => {
    const h = await harness();
    h.channel.receive!(scope, { alias: 'review', kind: 'register', generation: 1 }, h.connection);
    await vi.waitFor(() => expect(h.targeted).toHaveLength(1));
    h.channel.disconnected!(h.connection);
    await vi.waitFor(() => expect(() => h.state.describe()).toThrow('No Author viewport'));
    h.source.close();
  });
});
