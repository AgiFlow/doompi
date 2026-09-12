import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerHostService,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
import { api } from '../../../src/controllers/computerUseApi';
import { computerUseServerFacet } from '../../../src/extensions/server';

type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];
type MountedChannel = Parameters<DoomServerHostService['registerChannel']>[0];

function hostContext(scope: DoomServerHostService['scope']) {
  const registered: MountedApi[] = [];
  const registeredChannels: MountedChannel[] = [];
  const state = { disposed: 0, channelDisposed: 0 };
  const host: DoomServerHostService = {
    scope,
    context: { locality: 'local' } as unknown as DoomServerHostService['context'],
    registerApi(candidate) {
      registered.push(candidate);
      return { dispose: () => void (state.disposed += 1) };
    },
    registerChannel(channel) {
      registeredChannels.push(channel);
      return { dispose: () => void (state.channelDisposed += 1) };
    },
    registerMethod() {
      return { dispose: () => undefined };
    },
    mounted: () => registered.map((candidate) => candidate.basePath),
    mountedChannels: () => registeredChannels.map((channel) => channel.frameType),
  };
  const context = {
    effect() {},
    get: (name: string) => (name === DOOM_SERVER_HOST_SERVICE ? host : undefined),
  } as unknown as Context;
  return { context, registered, registeredChannels, state };
}

describe('computerUseServerFacet', () => {
  it('declares its host dependency', () => {
    expect(computerUseServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the exact computer-use API in session scope', async () => {
    const harness = hostContext('session');
    expect(typeof (await computerUseServerFacet.apply(harness.context))).toBe('function');
    expect(harness.registered).toEqual([api]);
  });

  it('unregisters the API on disposal', async () => {
    const harness = hostContext('session');
    await (
      await computerUseServerFacet.apply(harness.context)
    )?.();
    expect(harness.state.disposed).toBe(1);
  });

  it('registers and disposes its live channel in hub scope', async () => {
    const harness = hostContext('global');
    const dispose = await computerUseServerFacet.apply(harness.context);
    expect(typeof dispose).toBe('function');
    expect(harness.registered).toEqual([]);
    expect(harness.registeredChannels).toHaveLength(1);
    await dispose?.();
    expect(harness.state.channelDisposed).toBe(1);
  });
});
