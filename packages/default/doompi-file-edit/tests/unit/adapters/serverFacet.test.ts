import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import { api } from '../../../src/controllers/fileEditsApi';
import { fileEditsServerFacet } from '../../../src/extensions/server';
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
  return { context, registered, channels, state };
}

describe('fileEditsServerFacet', () => {
  it('declares its host dependency', async () => {
    expect(fileEditsServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the exact file-edits API in session scope', async () => {
    const harness = hostContext('session');
    expect(typeof (await fileEditsServerFacet.apply(harness.context))).toBe('function');
    expect(harness.registered).toEqual([api]);
    expect(harness.channels).toEqual([]);
  });

  it('registers the file-edits channel in hub scope', async () => {
    const harness = hostContext('global');
    expect(typeof (await fileEditsServerFacet.apply(harness.context))).toBe('function');
    expect(harness.registered).toEqual([]);
    expect(harness.channels).toHaveLength(1);
    expect(harness.channels[0]?.frameType).toBe(filesChannelType);
  });

  it('unregisters the API and channel on disposal', async () => {
    const session = hostContext('session');
    await (
      await fileEditsServerFacet.apply(session.context)
    )?.();
    expect(session.state.disposed).toBe(1);

    const hub = hostContext('global');
    await (
      await fileEditsServerFacet.apply(hub.context)
    )?.();
    expect(hub.state.disposed).toBe(1);
  });
});
