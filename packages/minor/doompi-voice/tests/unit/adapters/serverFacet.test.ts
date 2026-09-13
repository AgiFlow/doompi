import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import { api } from '../../../src/controllers/voiceSessionApi';
import { voiceServerFacet } from '../../../src/extensions/server';

type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];
type MountedChannel = Parameters<DoomServerHostService['registerChannel']>[0];

function hostContext(scope: DoomServerHostService['scope']) {
  const registered: MountedApi[] = [];
  const channels: MountedChannel[] = [];
  const state = { disposed: 0 };
  const host: DoomServerHostService = {
    scope,
    context: { locality: 'local' } as unknown as DoomServerHostService['context'],
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
      return { dispose: () => void (state.disposed += 1) };
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
  return { context, registered, channels, state };
}

describe('voiceServerFacet', () => {
  it('injects the server host so the facet mounts as one fiber', () => {
    expect(voiceServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the voice session API on the session scope', async () => {
    const harness = hostContext('session');

    const dispose = await voiceServerFacet.apply(harness.context);

    expect(harness.registered).toEqual([api]);
    expect(typeof dispose).toBe('function');
  });

  it('unregisters the API when the host disposes the facet', async () => {
    const harness = hostContext('session');

    await (
      await voiceServerFacet.apply(harness.context)
    )?.();

    expect(harness.state.disposed).toBe(1);
  });

  it('registers voice wake and ownership channels on the hub scope', async () => {
    const harness = hostContext('global');

    const dispose = await voiceServerFacet.apply(harness.context);

    expect(harness.registered).toEqual([]);
    expect(harness.channels.map((channel) => channel.frameType)).toEqual(['voice_media_wake', 'voice_ownership']);
    expect(typeof dispose).toBe('function');
    await dispose?.();
    expect(harness.state.disposed).toBe(2);
  });
});
