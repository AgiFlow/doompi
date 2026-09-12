import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerHostService,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
import { voiceServerFacet } from '../../../src/adapters/server/facet.ts';
import { api } from '../../../src/adapters/voiceSessionApi.ts';

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
    mounted() {
      return registered.map((mounted) => mounted.basePath);
    },
    mountedChannels() {
      return [];
    },
  };
  const context = {
    get(name: string) {
      return name === DOOM_SERVER_HOST_SERVICE ? host : undefined;
    },
  } as unknown as Context;
  return { context, registered, channels, state };
}

describe('voiceServerFacet', () => {
  it('injects the server host so the facet mounts as one fiber', () => {
    expect(voiceServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the voice session API on the session scope', () => {
    const harness = hostContext('session');

    const dispose = voiceServerFacet.apply(harness.context);

    expect(harness.registered).toEqual([api]);
    expect(typeof dispose).toBe('function');
  });

  it('unregisters the API when the host disposes the facet', () => {
    const harness = hostContext('session');

    voiceServerFacet.apply(harness.context)?.();

    expect(harness.state.disposed).toBe(1);
  });

  it('registers voice wake and ownership channels on the hub scope', () => {
    const harness = hostContext('global');

    const dispose = voiceServerFacet.apply(harness.context);

    expect(harness.registered).toEqual([]);
    expect(harness.channels.map((channel) => channel.frameType)).toEqual(['voice_media_wake', 'voice_ownership']);
    expect(typeof dispose).toBe('function');
    dispose?.();
    expect(harness.state.disposed).toBe(2);
  });
});
