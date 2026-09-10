import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerHostService,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
import { mcpServerFacet } from '../../../src/adapters/server/facet.ts';
import { mcpHubApi } from '../../../src/adapters/web/mcpHubApi.ts';

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
    mounted: () => registered.map((candidate) => candidate.basePath),
  };
  const context = {
    get: (name: string) => (name === DOOM_SERVER_HOST_SERVICE ? host : undefined),
  } as unknown as Context;
  return { context, registered, state };
}

describe('mcpServerFacet', () => {
  it('injects the server host', () => {
    expect(mcpServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the exact API on the hub scope', () => {
    const harness = hostContext('hub');
    const dispose = mcpServerFacet.apply(harness.context);
    expect(harness.registered).toHaveLength(1);
    expect(harness.registered[0]).toBe(mcpHubApi);
    expect(typeof dispose).toBe('function');
  });

  it('unregisters the API when disposed', () => {
    const harness = hostContext('hub');
    mcpServerFacet.apply(harness.context)?.();
    expect(harness.state.disposed).toBe(1);
  });

  it('registers nothing on the session scope', () => {
    const harness = hostContext('session');
    expect(mcpServerFacet.apply(harness.context)).toBeUndefined();
    expect(harness.registered).toEqual([]);
  });
});
