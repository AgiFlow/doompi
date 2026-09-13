import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import { api } from '../../../src/controllers/planApi';
import { planServerFacet } from '../../../src/extensions/server';

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
    registerMethod() {
      return { dispose: () => undefined };
    },
    mounted: () => registered.map((candidate) => candidate.basePath),
    mountedChannels: () => [],
  };
  const context = {
    effect() {},
    get: (name: string) => (name === DOOM_SERVER_HOST_SERVICE ? host : undefined),
  } as unknown as Context;
  return { context, registered, state };
}

describe('planServerFacet', () => {
  it('declares its host dependency', () => {
    expect(planServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the exact plan API in session scope', async () => {
    const harness = hostContext('session');
    expect(typeof (await planServerFacet.apply(harness.context))).toBe('function');
    expect(harness.registered).toEqual([api]);
  });

  it('unregisters the API on disposal', async () => {
    const harness = hostContext('session');
    await (
      await planServerFacet.apply(harness.context)
    )?.();
    expect(harness.state.disposed).toBe(1);
  });

  it('does nothing in hub scope', async () => {
    const harness = hostContext('global');
    expect(await planServerFacet.apply(harness.context)).toBeUndefined();
    expect(harness.registered).toEqual([]);
  });
});
