import { DOOM_HEADLESS_HOST_SERVICE, type DoomHeadlessHostService } from '@agimon-ai/doompi-core/headless';
import type { DoomPeerAgentRegistry } from '@agimon-ai/doompi-core/packageApi';
import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/serverFacet';
import { DOOM_MINOR_MODE_CATALOG_SERVICE } from '@agimon-ai/doompi-minor-mode';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import { facet as voiceServerFacet } from '../../../generated/server';

type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];
type MountedChannel = Parameters<DoomServerHostService['registerChannel']>[0];

function hostContext(scope: DoomServerHostService['scope']) {
  const registered: MountedApi[] = [];
  const channels: MountedChannel[] = [];
  const state = { disposed: 0 };
  const peerAgents = new Map<string, { fetch(request: Request): Promise<Response>; hubToken: string }>();
  const peerRegistry: DoomPeerAgentRegistry = {
    register(sessionId, agent, hubToken) {
      if (peerAgents.has(sessionId)) throw new Error('Duplicate Voice agent.');
      const entry = { fetch: (request: Request) => agent.fetch(request), hubToken };
      peerAgents.set(sessionId, entry);
      return () => {
        if (peerAgents.get(sessionId) === entry) peerAgents.delete(sessionId);
      };
    },
    get: (sessionId) => peerAgents.get(sessionId),
  };
  const host: DoomServerHostService = {
    scope,
    context: {
      locality: 'local',
      homeDirectory: '/tmp/voice-facet-test-home',
      sessionId: 'fixture',
      hubToken: 'fixture-hub-token',
      peerAgents: peerRegistry,
      directEvents: { publish() {}, subscribe: () => () => undefined, close() {} },
    } as unknown as DoomServerHostService['context'],
    registerApi(api) {
      registered.push(api);
      return {
        dispose() {
          state.disposed += 1;
        },
      };
    },
    registerChannel(channel) {
      channels.push(channel);
      return { mounted: true, dispose: () => void (state.disposed += 1) };
    },
    registerMethod() {
      return { dispose: () => undefined };
    },
    mounted() {
      return registered.map((mounted) => mounted.basePath);
    },
    mountedChannels() {
      return [];
    },
  };
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, host);
  context.provide(DOOM_HEADLESS_HOST_SERVICE, {
    context: {
      cwd: '/tmp',
      repoRoot: '/tmp',
      sessionId: 'fixture',
      environment: {},
      selection: { state: {} },
      client: { setStatus() {}, notify() {} },
    },
    registerCommand: () => ({ dispose() {} }),
    registerResource: () => ({ dispose() {} }),
    registerTool: () => ({ dispose() {} }),
    registerHook: () => ({ dispose() {} }),
    assertActive() {},
  } as unknown as DoomHeadlessHostService);
  context.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, { registerOwner: () => ({ publish() {}, dispose() {} }) } as never);
  return { context, registered, channels, state, peerAgents };
}

describe('voiceServerFacet', () => {
  it('injects the server host so the facet mounts as one fiber', () => {
    expect(voiceServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the voice session API on the session scope', async () => {
    const harness = hostContext('session');

    const dispose = await voiceServerFacet.apply(harness.context);

    expect(harness.registered.map((api) => api.basePath)).toEqual(['voice-media', 'voice']);
    expect(harness.channels.map((channel) => channel.frameType)).toEqual(['voice_media_wake']);
    expect(harness.peerAgents.get('fixture')?.hubToken).toBe('fixture-hub-token');
    expect(
      (
        await harness.peerAgents.get('fixture')?.fetch(
          new Request('http://voice.test/live/agent', {
            headers: { authorization: 'Bearer fixture-hub-token' },
          }),
        )
      )?.status,
    ).toBe(200);
    expect(typeof dispose).toBe('function');
    await dispose?.();
    expect(harness.peerAgents.has('fixture')).toBe(false);
  });

  it('unregisters the session APIs and channels when the host disposes the facet', async () => {
    const harness = hostContext('session');

    await (
      await voiceServerFacet.apply(harness.context)
    )?.();

    expect(harness.state.disposed).toBe(3);
  });

  it('keeps the native transfer route hub-authenticated on the global mount', async () => {
    const harness = hostContext('global');
    const dispose = await voiceServerFacet.apply(harness.context);
    const api = harness.registered
      .find((candidate) => candidate.basePath === 'voice')
      ?.start({
        scope: 'global',
        hubToken: 'fixture-hub-token',
        homeDirectory: '/tmp/voice-facet-test-home',
        onNotice: () => undefined,
      });
    if (!api) throw new Error('Global Voice API missing.');
    const call = (token?: string, body: unknown = {}) =>
      api.fetch(
        new Request('http://voice.test/live/native-transfer', {
          method: 'POST',
          ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
          body: JSON.stringify(body),
        }),
      );
    expect((await call()).status).toBe(401);
    expect((await call('wrong')).status).toBe(401);
    expect((await call('fixture-hub-token')).status).toBe(400);
    expect(
      (
        await call('fixture-hub-token', {
          sourceSessionId: 'fixture',
          activationId: 'activation',
          routeGeneration: 1,
          sessionIncarnation: 'incarnation',
          ordinal: 1,
          catalogRevision: 'catalog-1',
        })
      ).status,
    ).toBe(409);
    api.close();
    await dispose?.();
  });

  it('registers voice wake and ownership channels on the hub scope', async () => {
    const harness = hostContext('global');

    const dispose = await voiceServerFacet.apply(harness.context);

    expect(harness.registered.map((api) => api.basePath)).toEqual(['voice-media', 'voice']);
    expect(harness.channels.map((channel) => channel.frameType)).toEqual(['voice_media_wake', 'voice_ownership']);
    expect(typeof dispose).toBe('function');
    await dispose?.();
    expect(harness.state.disposed).toBe(4);
  });
});
