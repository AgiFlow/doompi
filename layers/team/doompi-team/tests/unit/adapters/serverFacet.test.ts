import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import { teamServerFacet } from '../../../src/extensions/server';

type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];
type MountedChannel = Parameters<DoomServerHostService['registerChannel']>[0];

function hostContext(scope: DoomServerHostService['scope']) {
  const registered: MountedApi[] = [];
  const channels: MountedChannel[] = [];
  const state = { disposed: 0 };
  const host: DoomServerHostService = {
    scope,
    context: { locality: 'local' } as unknown as DoomServerHostService['context'],
    registerMethod() {
      return { dispose: () => undefined };
    },
    registerApi(candidate) {
      registered.push(candidate);
      return { dispose: () => void (state.disposed += 1) };
    },
    registerChannel(candidate) {
      channels.push(candidate);
      return { dispose: () => void (state.disposed += 1) };
    },
    mounted: () => registered.map((candidate) => candidate.basePath),
    mountedChannels: () => channels.map((candidate) => candidate.frameType),
  };
  const context = {
    effect: () => undefined,
    get: (name: string) => (name === DOOM_SERVER_HOST_SERVICE ? host : undefined),
  } as unknown as Context;
  return { channels, context, registered, state };
}

describe('teamServerFacet', () => {
  it('declares its host dependency', () => {
    expect(teamServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers and disposes Team channels in hub scope', async () => {
    const harness = hostContext('global');
    await (
      await teamServerFacet.apply(harness.context)
    )?.();
    expect(harness.channels.map((channel) => channel.frameType)).toEqual(['subagent_runs', 'subagent_catalog']);
    expect(harness.registered).toEqual([]);
    expect(harness.state.disposed).toBe(2);
  });
});
