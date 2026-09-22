import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/serverFacet';
import { assertContractSurface } from '@agimon-ai/doompi-core/testing';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import { facet } from '../generated/server';
import { apiContracts } from '../src/schemas/apiContracts';

type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];

/** Applies the real generated facet at one scope and collects what it mounted. */
async function mountedApis(scope: DoomServerHostService['scope']): Promise<MountedApi[]> {
  const registered: MountedApi[] = [];
  const host = {
    scope,
    context: { locality: 'local' } as unknown as DoomServerHostService['context'],
    registerApi(candidate: MountedApi) {
      registered.push(candidate);
      return { dispose() {} };
    },
    registerMethod: () => ({ dispose() {} }),
    registerChannel: () => ({ dispose() {} }),
    mounted: () => registered.map((candidate) => candidate.basePath),
    mountedChannels: () => [],
  } as unknown as DoomServerHostService;
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, host);
  await facet.apply(context);
  return registered;
}

/**
 * Checks that what the contract promises is what the facet serves.
 *
 * Nothing else compares the two halves: the contract is validated for shape and
 * the mount is tested directly through `settingsApi`, so a mount registered
 * under a different segment, or not registered at all, passes both.
 *
 * Only global and workspace, which are the scopes the contract declares. A
 * session host gets no settings mount at all: the routed contribution answers
 * `undefined` there and the mount itself throws if it is started anyway, so
 * there is nothing to compare.
 */
describe('the declared API surface', () => {
  for (const scope of ['global', 'workspace'] as const) {
    it(`mounts every route the contract declares at ${scope} scope`, async () => {
      await expect(
        assertContractSurface({ contract: apiContracts, scope, apis: await mountedApis(scope) }),
      ).resolves.toBeUndefined();
    });
  }
});
