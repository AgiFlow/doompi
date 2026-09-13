import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config';
import { readSyncRegistration } from '@agimon-ai/doompi-core/sync-registration';
import { bundleCockpitWeb } from '@agimon-ai/doompi/builders/web';

import { pluginPackageRoots } from './pluginRoots';

/** A fixture plugin whose tool renderer throws on demand, so the timeline's fallback can be proved. */
const crashRoot = fileURLToPath(new URL('../fixtures/crash-plugin', import.meta.url));

/** Env vars the cockpit fixture reads for the controlled synchronized composition. */
export const SYNCED_DIST_ENV = 'DOOMPI_E2E_SYNCED_DIST';
export const SYNCED_HOME_ENV = 'DOOMPI_E2E_SYNCED_HOME';
export const SYNCED_WORK_ROOT_ENV = 'DOOMPI_E2E_SYNCED_WORK_ROOT';

const execFileAsync = promisify(execFile);

/**
 * Playwright global setup: publish one real synchronization generation, then
 * replace its web bundle with the all-plugin test composition. Every test works
 * below that repository root without sharing the developer's Doom state or
 * rebuilding browser assets per test.
 */
export default async function globalSetup(): Promise<() => void> {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-e2e-sync-'));
  const homeDir = path.join(testRoot, 'home');
  const agentDir = path.join(homeDir, '.pi', 'agent');
  const workspaceRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const cli = path.join(workspaceRoot, 'packages', 'core', 'doompi', 'dist', 'bin', 'cli.mjs');
  fs.mkdirSync(agentDir, { recursive: true });
  const syncEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    DOOMPI_ROOT: workspaceRoot,
  };
  const inheritedPrefixes = ['AGENT_HARNESS_', 'DOOMPI_', 'DOOM_PI_', 'PI_SUBAGENT_'];
  for (const key of Object.keys(syncEnv)) {
    if (inheritedPrefixes.some((prefix) => key.startsWith(prefix))) delete syncEnv[key];
  }
  const commandOptions = (root: string) => ({
    cwd: root,
    env: { ...syncEnv, DOOMPI_ROOT: root },
    maxBuffer: 16 * 1024 * 1024,
  });
  await execFileAsync(process.execPath, [cli, 'init'], commandOptions(workspaceRoot));
  const globalRoot = globalDoomConfigDirectory(homeDir);
  const packages = pluginPackageRoots();
  const packageLines = [
    ...packages
      .filter((entry) => !entry.root.includes(`${path.sep}packages${path.sep}core${path.sep}`))
      .map((entry) => entry.root),
    crashRoot,
  ]
    .map((root) => `    - ${JSON.stringify(root)}`)
    .join('\n');
  fs.writeFileSync(
    path.join(globalRoot, 'modes.yaml'),
    `default:
  packages:
${packageLines}
layers: {}
defaultMajorMode: minimal
majorMode:
  minimal:
    description: All-plugin web E2E fixture.
    layers: []
`,
  );
  await execFileAsync(process.execPath, [cli, 'sync'], commandOptions(globalRoot));
  await execFileAsync(process.execPath, [cli, 'sync'], commandOptions(workspaceRoot));

  const registration = readSyncRegistration(workspaceRoot, homeDir);
  if (registration?.webDirectory === null || registration?.webDirectory === undefined) {
    throw new Error('global setup sync did not publish a complete web bundle');
  }
  const outDir = path.dirname(registration.webDirectory);
  const result = await bundleCockpitWeb({
    hostRoot: fileURLToPath(new URL('../..', import.meta.url)),
    pluginRoots: [...packages.map((entry) => entry.root), crashRoot],
    outDir,
  });
  const workRoot = fs.mkdtempSync(path.join(workspaceRoot, 'node_modules', '.doompi-e2e-'));
  const previousDist = process.env[SYNCED_DIST_ENV];
  const previousHome = process.env[SYNCED_HOME_ENV];
  const previousWorkRoot = process.env[SYNCED_WORK_ROOT_ENV];
  process.env[SYNCED_DIST_ENV] = result.assetsDir;
  process.env[SYNCED_HOME_ENV] = homeDir;
  process.env[SYNCED_WORK_ROOT_ENV] = workRoot;
  return () => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.rmSync(workRoot, { recursive: true, force: true });
    if (previousDist === undefined) delete process.env[SYNCED_DIST_ENV];
    else process.env[SYNCED_DIST_ENV] = previousDist;
    if (previousHome === undefined) delete process.env[SYNCED_HOME_ENV];
    else process.env[SYNCED_HOME_ENV] = previousHome;
    if (previousWorkRoot === undefined) delete process.env[SYNCED_WORK_ROOT_ENV];
    else process.env[SYNCED_WORK_ROOT_ENV] = previousWorkRoot;
  };
}
