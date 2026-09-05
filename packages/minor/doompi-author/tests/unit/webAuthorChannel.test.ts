import type { HubChannelHost } from '@agimon-ai/doompi-web-contracts';
import { describe, expect, it, vi } from 'vitest';
import { createAuthorBridgeApi } from '../../src/adapters/authorBridgeApi.ts';
import { createAuthorChannel } from '../../src/adapters/webAuthorChannel.ts';
import { createAuthorBridgeState } from '../../src/services/authorBridgeState.ts';

const scope = { sessionId: 'session', cwd: '/repo' };

function harness() {
  const state = createAuthorBridgeState({
    now: Date.now,
    issueToken: vi.fn().mockReturnValueOnce('owner').mockReturnValueOnce('catalog').mockReturnValueOnce('request'),
    scheduleTimeout(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  });
  const app = createAuthorBridgeApi(state);
  const targeted: unknown[] = [];
  const host: HubChannelHost = {
    sessions: () => [scope],
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
  return { state, targeted, host, channel, source, connection };
}

describe('the Author targeted web hub bridge', () => {
  it('targets accepted and request frames only to the owning connection', async () => {
    const h = harness();
    h.channel.receive!(scope, { kind: 'register', generation: 1 }, h.connection);
    await vi.waitFor(() =>
      expect(h.targeted).toContainEqual(expect.objectContaining({ kind: 'accepted', ownerToken: 'owner' })),
    );
    h.channel.receive!(
      scope,
      {
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
    const h = harness();
    h.channel.receive!(scope, { kind: 'register', generation: 1 }, h.connection);
    await vi.waitFor(() => expect(h.targeted).toHaveLength(1));
    h.channel.receive!(scope, { kind: 'release', generation: 1 }, h.connection);
    await vi.waitFor(() => expect(() => h.state.describe()).toThrow('No Author viewport'));
    h.source.close();
  });
  it('releases the connection binding when its socket disconnects', async () => {
    const h = harness();
    h.channel.receive!(scope, { kind: 'register', generation: 1 }, h.connection);
    await vi.waitFor(() => expect(h.targeted).toHaveLength(1));
    h.channel.disconnected!(h.connection);
    await vi.waitFor(() => expect(() => h.state.describe()).toThrow('No Author viewport'));
    h.source.close();
  });
});
