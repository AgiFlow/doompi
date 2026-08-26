import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDeclaredApi,
  mountPackageApi,
  standardExtensionScenarios,
} from '@agimon-ai/doompi-extension-contracts/testing';
import { describe, expect, it } from 'vitest';
import { workflowExtension } from '../../src/adapters/pi/extension.ts';
import { api } from '../../src/adapters/workflowHubApi.ts';

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/**
 * The three surfaces this package ships, each checked where it is declared.
 *
 * The Pi lifecycle comes from the shared contract, so this package proves the
 * same things every other extension does rather than its own subset. What is
 * particular to workflows, the fencing of a replaced generation and of a
 * shut-down runtime, stays in standardExtension.test.ts.
 */

describe('the Pi surface', () => {
  for (const scenario of standardExtensionScenarios({
    factory: workflowExtension,
    tools: ['list_workflows', 'launch_workflow', 'workflow_run'],
    commands: ['workflow-launch'],
  })) {
    it(scenario.name, () => scenario.run());
  }
});

describe('the API surface', () => {
  it('answers on the path a browser asks for, once the host strips the mount', async () => {
    const mounted = mountPackageApi(api, { scope: 'hub' });

    // A run that does not exist is the cheapest route that proves the mount:
    // the 404 is the package's own, not the harness refusing to route.
    const response = await mounted.fetch('/api/plugin/workflow/runs/repo/absent-run/artifacts');

    expect(mounted.mountPath).toBe('/api/plugin/workflow');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('absent-run') });
    mounted.close();
  });

  it('refuses a path outside its own mount', async () => {
    const mounted = mountPackageApi(api, { scope: 'hub' });

    expect((await mounted.fetch('/api/plugin/runner/runs')).status).toBe(404);
    mounted.close();
  });

  it('serves the base path the manifest mounts it at', () => {
    // Vibe-Lint checks the manifest statically and cannot read the value, so
    // this is the only place the two are compared.
    const report = assertDeclaredApi({ packageRoot: PACKAGE_ROOT, api, scope: 'hub' });

    expect(report).toMatchObject({ basePath: 'workflow', dist: './dist/hubApi.mjs' });
  });
});
