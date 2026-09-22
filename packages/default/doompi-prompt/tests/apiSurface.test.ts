import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/serverFacet';
import { assertContractSurface } from '@agimon-ai/doompi-core/testing';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { facet } from '../generated/server';
import { AGENT_DIR_ENV } from '../src/constants/promptStore';
import { apiContracts } from '../src/schemas/apiContracts';

type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];

const dirs: string[] = [];
let previousAgentDir: string | undefined;

beforeEach(() => {
  // The routes build a real store, and a bare one reads the developer's own
  // prompt library out of the home directory. Pi's own override points it at a
  // temporary directory instead.
  previousAgentDir = process.env[AGENT_DIR_ENV];
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-prompt-surface-'));
  dirs.push(agentDir);
  process.env[AGENT_DIR_ENV] = agentDir;
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
  else process.env[AGENT_DIR_ENV] = previousAgentDir;
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
 * Nothing else compares the two halves. This package's API lived behind a flat
 * `api/route.server.ts` whose base path came from a hand-written constant, so
 * the contract, the mount and the URLs the page built were three independent
 * copies of the word `prompts`.
 *
 * Only the global scope is asserted. The generated server entry cascades a
 * global contribution into workspace and session, so the same API answers
 * there too, by design and by the page's own use of it; the contract describes
 * the mount rather than the cascade, and asserting the cascaded scopes here
 * would be testing the host's composition rather than this package's promise.
 */
describe('the declared API surface', () => {
  it('mounts every route the contract declares at global scope', async () => {
    await expect(
      assertContractSurface({
        contract: apiContracts,
        scope: 'global',
        apis: await mountedApis('global'),
        // Both name-bearing routes refuse an unusable name with a 400, which is
        // this package's own answer and not the framework's miss, so the
        // literal `{name}` segment is a usable probe for liveness.
        probe: {
          'prompts.save': { body: '{}', headers: { 'content-type': 'application/json' } },
        },
      }),
    ).resolves.toBeUndefined();
  });
});
