import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDeclaredApi,
  mountPackageApi,
  standardExtensionScenarios,
} from '@agimon-ai/doompi-extension-contracts/testing';
import { describe, expect, it } from 'vitest';
import { runnerExtension } from '../../src/adapters/pi/extension.ts';
import { api } from '../../src/adapters/runnerLogApi.ts';

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/**
 * The surfaces this package ships, each checked where it is declared.
 *
 * The runner's API is the only session-scoped one in the repository, so this is
 * also where the session half of the mount is exercised: the host hands a
 * session id and a cwd that a hub-scoped API would never see.
 */

describe('the Pi surface', () => {
  for (const scenario of standardExtensionScenarios({
    factory: runnerExtension,
    tools: ['bash'],
    commands: ['runners'],
  })) {
    it(scenario.name, () => scenario.run());
  }
});

describe('the API surface', () => {
  it('answers on the path a browser asks for, once the host strips the mount', async () => {
    const mounted = mountPackageApi(api, { scope: 'session', sessionId: 's1', cwd: '/repo' });

    // A run that does not exist is the cheapest route that proves the mount:
    // the answer comes from the package's own handler, not from the harness.
    const response = await mounted.fetch('/api/plugin/runner/runners/absent-run/log');

    expect(mounted.mountPath).toBe('/api/plugin/runner');
    expect(response.status).toBe(404);
    mounted.close();
  });

  it('refuses a path outside its own mount', async () => {
    const mounted = mountPackageApi(api, { scope: 'session', sessionId: 's1' });

    expect((await mounted.fetch('/api/plugin/workflow/runs')).status).toBe(404);
    mounted.close();
  });

  it('serves the base path the manifest mounts it at', () => {
    const report = assertDeclaredApi({ packageRoot: PACKAGE_ROOT, api, scope: 'session' });

    expect(report).toMatchObject({ basePath: 'runner', dist: './dist/sessionApi.mjs' });
  });
});
