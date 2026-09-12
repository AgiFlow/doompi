import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerHostService,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
import { api } from '../../../src/controllers/hubApi';
import { logServerFacet } from '../../../src/extensions/server';

type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];

function hostContext(scope: DoomServerHostService['scope']) {
  const registered: MountedApi[] = [];
  const state = { disposed: 0 };
  const host: DoomServerHostService = {
    scope,
    context: { scope } as DoomServerHostService['context'],
    registerApi(candidate) {
      registered.push(candidate);
      return { dispose: () => void (state.disposed += 1) };
    },
    registerMethod() {
      return { dispose() {} };
    },
    registerChannel() {
      return { dispose: () => undefined };
    },
    mounted: () => registered.map((candidate) => candidate.basePath),
    mountedChannels: () => [],
  };
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, host);
  return { context, registered, state };
}

describe('logServerFacet', () => {
  it('injects the server host', async () => {
    expect(logServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the exact API on the hub scope', async () => {
    const harness = hostContext('global');
    const dispose = await logServerFacet.apply(harness.context);
    expect(harness.registered).toHaveLength(1);
    expect(harness.registered[0]).toBe(api);
    expect(typeof dispose).toBe('function');
  });

  it('unregisters the API when disposed', async () => {
    const harness = hostContext('global');
    await (
      await logServerFacet.apply(harness.context)
    )?.();
    expect(harness.state.disposed).toBe(1);
  });

  it('registers nothing on the session scope', async () => {
    const harness = hostContext('session');
    const dispose = await logServerFacet.apply(harness.context);
    await dispose?.();
    expect(harness.registered).toEqual([]);
  });
});
