import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/server-facet';
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
 * Nothing else compares the two halves. The contract declares this API at both
 * the global and the workspace scope, and only the workspace one is ever
 * addressed by the cockpit, so a mount that moved would be reported by the
 * panel's empty state and nowhere else.
 *
 * No probe: every route refuses a missing or unusable repositoryId with a 400,
 * which is this package's own answer rather than the framework's miss, so a
 * bare request is enough to prove a handler is there.
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
