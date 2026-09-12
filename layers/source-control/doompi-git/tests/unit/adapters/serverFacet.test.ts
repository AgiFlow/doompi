import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
import { gitServerFacet } from '../../../src/extensions/server';

type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];

function hostContext(scope: DoomServerHostService['scope']) {
  const registered: MountedApi[] = [];
  const state = { disposed: 0 };
  const host: DoomServerHostService = {
    scope,
    context: { locality: 'local' } as unknown as DoomServerHostService['context'],
    registerMethod() {
      return { dispose: () => undefined };
    },
    registerApi(api) {
      registered.push(api);
      return {
        dispose() {
          state.disposed += 1;
        },
      };
    },
    registerChannel() {
      return { dispose: () => undefined };
    },
    mounted() {
      return registered.map((api) => api.basePath);
    },
    mountedChannels() {
      return [];
    },
  };
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, host);
  return { context, registered, state };
}

describe('gitServerFacet', () => {
  it('injects the server host so the facet mounts as one fiber', () => {
    expect(gitServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the package API on the hub scope', async () => {
    const harness = hostContext('global');

    const dispose = await gitServerFacet.apply(harness.context);

    expect(harness.registered).toHaveLength(1);
    expect(typeof dispose).toBe('function');
  });

  it('unregisters the API when the host disposes the facet', async () => {
    const harness = hostContext('global');

    await (
      await gitServerFacet.apply(harness.context)
    )?.();

    expect(harness.state.disposed).toBe(1);
  });

  it('requires the direct event bus in session scope', async () => {
    const harness = hostContext('session');
    await expect(gitServerFacet.apply(harness.context)).rejects.toThrow('requires the session direct event bus');
    expect(harness.registered).toEqual([]);
  });
});
