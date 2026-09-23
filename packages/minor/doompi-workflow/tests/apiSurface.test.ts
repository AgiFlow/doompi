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
 * Nothing else compares the two halves: the contract is validated for shape,
 * and the Hono app is tested directly, so an app mounted under a different
 * segment than `workflow` passes both. The browser's client now takes that
 * segment from the folder this facet is built out of, so a rename that moved
 * the mount would move every URL the cockpit sends with it, silently.
 *
 * All three scopes are asserted because the contract declares all three. The
 * global tree contributes the API and the generated entry cascades it into
 * workspace and session; the session tree mounts it again for a session's own
 * server, and the global contribution stands aside there, which is what keeps
 * exactly one mount at every scope.
 */
describe('the declared API surface', () => {
  for (const scope of ['global', 'workspace', 'session'] as const) {
    it(`mounts every route the contract declares at ${scope} scope, exactly once`, async () => {
      const apis = await mountedApis(scope);

      // Once, not twice. Both trees offer this API, and the global one returns
      // nothing at session scope so the session's own copy is the only mount
      // there. A second registration would answer the same URL from a second
      // Hono app with its own terminal caches.
      expect(apis.map((api) => api.basePath)).toEqual(['workflow']);
      await expect(
        assertContractSurface({ contract: apiContracts, scope, apis, mount: { sessionId: 's1' } }),
      ).resolves.toBeUndefined();
    });
  }
});
