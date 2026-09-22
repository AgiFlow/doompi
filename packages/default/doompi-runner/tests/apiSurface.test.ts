import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DoomDirectEventBus } from '@agimon-ai/doompi-core/hubChannel';
import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/serverFacet';
import { assertContractSurface } from '@agimon-ai/doompi-core/testing';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { facet } from '../generated/server';
import { PI_CODING_AGENT_DIR_ENV } from '../src/constants/runnerPaths';
import { apiContracts } from '../src/schemas/apiContracts';

type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];

const SESSION_ID = 'surface-session';

const dirs: string[] = [];
let previousAgentDir: string | undefined;

beforeEach(() => {
  // The routes resolve a run out of a real store, and a bare one reads the
  // developer's own runner directory. Pi's own override points it at an empty
  // temporary one, so every probe below is answered by "no such runner".
  previousAgentDir = process.env[PI_CODING_AGENT_DIR_ENV];
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runner-surface-'));
  dirs.push(agentDir);
  process.env[PI_CODING_AGENT_DIR_ENV] = agentDir;
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env[PI_CODING_AGENT_DIR_ENV];
  else process.env[PI_CODING_AGENT_DIR_ENV] = previousAgentDir;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Applies the real generated facet at session scope and collects what it mounted. */
async function mountedApis(): Promise<MountedApi[]> {
  const registered: MountedApi[] = [];
  // The session root refuses to build without one; nothing here publishes.
  const directEvents: DoomDirectEventBus = {
    publish: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    close: vi.fn(),
  };
  const host = {
    scope: 'session',
    sessionId: SESSION_ID,
    context: { locality: 'local', directEvents } as unknown as DoomServerHostService['context'],
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
 * Nothing else compares the two halves. Session scope only: this package mounts
 * `api/runner/` under `workspaces/sessions/`, and the contract declares all
 * four routes there, so that is the whole of its promise.
 *
 * The two stream routes are probed like any other. Both resolve the run before
 * `streamSSE` is reached, and no run exists in the temporary store, so each
 * answers its own 404 and the assertion never waits on an open socket. A probe
 * that did reach the stream would hang here rather than fail, which is worth
 * knowing before adding a fixture run.
 */
describe('the declared API surface', () => {
  it('mounts every route the contract declares at session scope', async () => {
    await expect(
      assertContractSurface({
        contract: apiContracts,
        scope: 'session',
        apis: await mountedApis(),
        mount: { sessionId: SESSION_ID, cwd: '/repo' },
      }),
    ).resolves.toBeUndefined();
  });
});
