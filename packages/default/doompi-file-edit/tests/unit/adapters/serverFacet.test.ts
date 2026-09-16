import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import { facet as fileEditsServerFacet } from '../../../generated/server';
import { filesChannelType } from '../../../src/types/webFiles';

type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];

type MountedChannel = Parameters<DoomServerHostService['registerChannel']>[0];

function hostContext(scope: DoomServerHostService['scope']) {
  const registered: MountedApi[] = [];
  const channels: MountedChannel[] = [];
  const state = { disposed: 0 };
  const host: DoomServerHostService = {
    scope,
    context: { locality: 'local' } as unknown as DoomServerHostService['context'],
    registerApi(candidate) {
      registered.push(candidate);
      return { dispose: () => void (state.disposed += 1) };
    },
    registerMethod() {
      return { dispose() {} };
    },
    registerChannel(candidate) {
      channels.push(candidate);
      return { dispose: () => void (state.disposed += 1) };
    },
    mounted: () => registered.map((candidate) => candidate.basePath),
    mountedChannels: () => channels.map((candidate) => candidate.frameType),
  };
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, host);
  return { context, registered, channels, state, mountedApis: () => host.mounted() };
}

describe('fileEditsServerFacet', () => {
  it('declares its host dependency', async () => {
    expect(fileEditsServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('mounts the file-edits API and channel in session scope', async () => {
    const harness = hostContext('session');
    expect(typeof (await fileEditsServerFacet.apply(harness.context))).toBe('function');
    // This assertion used to read `toEqual([])`, and it was correct: the API
    // was declared, contracted and unit-tested, and mounted nowhere.
    expect(harness.mountedApis()).toEqual(['file-edits']);
    expect(harness.channels).toHaveLength(1);
    expect(harness.channels[0]?.frameType).toBe(filesChannelType);
  });

  it('registers the file-edits channel in hub scope, but mounts no session API there', async () => {
    const harness = hostContext('global');
    expect(typeof (await fileEditsServerFacet.apply(harness.context))).toBe('function');
    expect(harness.mountedApis()).toEqual([]);
    expect(harness.channels).toHaveLength(1);
    expect(harness.channels[0]?.frameType).toBe(filesChannelType);
  });

  it('unregisters the API and channel on disposal', async () => {
    const session = hostContext('session');
    await (
      await fileEditsServerFacet.apply(session.context)
    )?.();
    // Two now: the channel, and the API this package spent its life not mounting.
    expect(session.state.disposed).toBe(2);

    const hub = hostContext('global');
    await (
      await fileEditsServerFacet.apply(hub.context)
    )?.();
    expect(hub.state.disposed).toBe(1);
  });
});
