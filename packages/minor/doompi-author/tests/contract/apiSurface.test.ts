import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/serverFacet';
import { assertContractSurface } from '@agimon-ai/doompi-core/testing';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it } from 'vitest';

import { facet } from '../../generated/server';
import { apiContracts } from '../../src/schemas/apiContracts';

type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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
 * Twelve session routes are declared across three Hono apps that the mount
 * folds into one, and nothing compared the two halves before this: a bridge
 * path could move in the app and stay put in the contract, and only a browser
 * hitting a 404 would say so.
 */
describe('the declared API surface', () => {
  it('mounts every route the contract declares at session scope', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-author-surface-'));
    dirs.push(cwd);

    await expect(
      assertContractSurface({
        contract: apiContracts,
        scope: 'session',
        apis: await mountedApis('session'),
        mount: { sessionId: 's1', cwd },
      }),
    ).resolves.toBeUndefined();
  });
});
