import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import { api } from '../../../src/controllers/workflowHubApi';
import { workflowServerFacet } from '../../../src/extensions/server';

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
    registerChannel() {
      return { dispose: () => undefined };
    },
    registerMethod() {
      return { dispose: () => undefined };
    },
    mounted: () => registered.map((candidate) => candidate.basePath),
    mountedChannels: () => [],
  };
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, host);
  return { context, registered, state };
}

describe('workflowServerFacet', () => {
  it('injects the server host', () => {
    expect(workflowServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the exact API on the hub scope', async () => {
    const harness = hostContext('global');
    const dispose = await workflowServerFacet.apply(harness.context);
    expect(harness.registered).toHaveLength(1);
    expect(harness.registered[0]).toBe(api);
    expect(typeof dispose).toBe('function');
  });

  it('unregisters the API when disposed', async () => {
    const harness = hostContext('global');
    await (
      await workflowServerFacet.apply(harness.context)
    )?.();
    expect(harness.state.disposed).toBe(1);
  });

  it('registers the API independently on the session scope', async () => {
    const harness = hostContext('session');
    expect(typeof (await workflowServerFacet.apply(harness.context))).toBe('function');
    expect(harness.registered).toEqual([api]);
  });
});
