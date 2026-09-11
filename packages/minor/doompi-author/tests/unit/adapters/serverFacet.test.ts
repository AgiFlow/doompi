import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerHostService,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
import { api } from '../../../src/adapters/authorApi.ts';
import { authorServerFacet } from '../../../src/adapters/server/facet.ts';

type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];

function hostContext(scope: DoomServerHostService['scope']) {
  const registered: MountedApi[] = [];
  const state = { disposed: 0 };
  const host: DoomServerHostService = {
    scope,
    context: { locality: 'local' } as unknown as DoomServerHostService['context'],
    registerApi(candidate) {
      registered.push(candidate);
      return { dispose: () => void (state.disposed += 1) };
    },
    registerChannel() {
      return { dispose: () => undefined };
    },
    mounted: () => registered.map((candidate) => candidate.basePath),
    mountedChannels: () => [],
  };
  const context = {
    get: (name: string) => (name === DOOM_SERVER_HOST_SERVICE ? host : undefined),
  } as unknown as Context;
  return { context, registered, state };
}

describe('authorServerFacet', () => {
  it('declares its host dependency', () => {
    expect(authorServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the exact Author API in session scope', () => {
    const harness = hostContext('session');
    expect(typeof authorServerFacet.apply(harness.context)).toBe('function');
    expect(harness.registered).toEqual([api]);
  });

  it('unregisters the API on disposal', () => {
    const harness = hostContext('session');
    authorServerFacet.apply(harness.context)?.();
    expect(harness.state.disposed).toBe(1);
  });

  it('does nothing in hub scope', () => {
    const harness = hostContext('hub');
    expect(authorServerFacet.apply(harness.context)).toBeUndefined();
    expect(harness.registered).toEqual([]);
  });
});
