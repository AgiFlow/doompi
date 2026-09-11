import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerHostService,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
import { api } from '../../../src/adapters/fileEditsApi.ts';
import { fileEditsServerFacet } from '../../../src/adapters/server/facet.ts';
import { filesChannelType } from '../../../src/types/webFiles.ts';

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
    registerChannel(candidate) {
      channels.push(candidate);
      return { dispose: () => void (state.disposed += 1) };
    },
    mounted: () => registered.map((candidate) => candidate.basePath),
    mountedChannels: () => channels.map((candidate) => candidate.frameType),
  };
  const context = {
    get: (name: string) => (name === DOOM_SERVER_HOST_SERVICE ? host : undefined),
  } as unknown as Context;
  return { context, registered, channels, state };
}

describe('fileEditsServerFacet', () => {
  it('declares its host dependency', () => {
    expect(fileEditsServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the exact file-edits API in session scope', () => {
    const harness = hostContext('session');
    expect(typeof fileEditsServerFacet.apply(harness.context)).toBe('function');
    expect(harness.registered).toEqual([api]);
    expect(harness.channels).toEqual([]);
  });

  it('registers the file-edits channel in hub scope', () => {
    const harness = hostContext('hub');
    expect(typeof fileEditsServerFacet.apply(harness.context)).toBe('function');
    expect(harness.registered).toEqual([]);
    expect(harness.channels).toHaveLength(1);
    expect(harness.channels[0]?.frameType).toBe(filesChannelType);
  });

  it('unregisters the API and channel on disposal', () => {
    const session = hostContext('session');
    fileEditsServerFacet.apply(session.context)?.();
    expect(session.state.disposed).toBe(1);

    const hub = hostContext('hub');
    fileEditsServerFacet.apply(hub.context)?.();
    expect(hub.state.disposed).toBe(1);
  });
});
