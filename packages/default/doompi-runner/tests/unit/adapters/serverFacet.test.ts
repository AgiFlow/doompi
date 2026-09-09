import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerHostService,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
import { runnerServerFacet } from '../../../src/adapters/server/facet.ts';

type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];

function hostContext(scope: DoomServerHostService['scope']) {
  const registered: MountedApi[] = [];
  const state = { disposed: 0 };
  const host: DoomServerHostService = {
    scope,
    context: { locality: 'local' } as unknown as DoomServerHostService['context'],
    registerApi(api) {
      registered.push(api);
      return {
        dispose() {
          state.disposed += 1;
        },
      };
    },
    mounted() {
      return registered.map((api) => api.basePath);
    },
  };
  const context = {
    get(name: string) {
      return name === DOOM_SERVER_HOST_SERVICE ? host : undefined;
    },
  } as unknown as Context;
  return { context, registered, state };
}

describe('runnerServerFacet', () => {
  it('injects the server host so the facet mounts as one fiber', () => {
    expect(runnerServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the package API on the session scope', () => {
    const harness = hostContext('session');

    const dispose = runnerServerFacet.apply(harness.context);

    expect(harness.registered).toHaveLength(1);
    expect(typeof dispose).toBe('function');
  });

  it('unregisters the API when the host disposes the facet', () => {
    const harness = hostContext('session');

    runnerServerFacet.apply(harness.context)?.();

    expect(harness.state.disposed).toBe(1);
  });

  it('registers nothing on the other scope', () => {
    const harness = hostContext('hub');

    const dispose = runnerServerFacet.apply(harness.context);

    expect(harness.registered).toEqual([]);
    expect(dispose).toBeUndefined();
  });
});
