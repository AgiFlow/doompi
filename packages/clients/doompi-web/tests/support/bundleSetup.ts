import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config';
import { readSyncRegistration, readSyncState } from '@agimon-ai/doompi/services';
import {
  type DeclaredPackageApi,
  DOOM_API_SCOPES,
  type DoomApiScope,
  declaredApisOf,
  orderDeclaredApis,
} from '@agimon-ai/doompi-extension-contracts/package-api';
import {
  type DeclaredServerFacet,
  declaredServerFacetsOf,
  orderServerFacets,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import { bundleCockpitWeb } from '../../src/adapters/webBundler.ts';
import { pluginPackageRoots } from './pluginRoots.ts';

/** A fixture plugin whose tool renderer throws on demand, so the timeline's fallback can be proved. */
const crashRoot = fileURLToPath(new URL('../fixtures/crash-plugin', import.meta.url));

/** Env vars the cockpit fixture reads for the controlled synchronized composition. */
export const SYNCED_DIST_ENV = 'DOOMPI_E2E_SYNCED_DIST';
export const SYNCED_HOME_ENV = 'DOOMPI_E2E_SYNCED_HOME';
export const SYNCED_SERVER_COMPOSITION_ENV = 'DOOMPI_E2E_SYNCED_SERVER_COMPOSITION';
export const SYNCED_WORK_ROOT_ENV = 'DOOMPI_E2E_SYNCED_WORK_ROOT';

const execFileAsync = promisify(execFile);

function importName(basePath: string): string {
  return `${basePath.replace(/-([a-z0-9])/gu, (_, character: string) => character.toUpperCase())}Api`;
}

function renderApiRoutes(scope: DoomApiScope, apis: readonly DeclaredPackageApi[]): string {
  const imports: string[] = [];
  const names: string[] = [];
  for (const api of apis) {
    const entry = api[scope];
    if (entry === undefined) continue;
    const name = importName(api.basePath);
    names.push(name);
    imports.push(
      `import { api as ${name} } from '${pathToFileURL(path.join(api.packageDir, entry.dist ?? entry.entry)).href}';`,
    );
  }
  return [...imports, '', `export const apis = [${names.join(', ')}];`, ''].join('\n');
}

function renderServerFacets(scope: DoomApiScope, facets: readonly DeclaredServerFacet[]): string {
  const scoped = facets.filter((facet) => facet.scopes.includes(scope));
  const imports = scoped.map(
    (facet, index) => `import facet${index} from '${pathToFileURL(path.join(facet.packageDir, facet.dist)).href}';`,
  );
  const names = scoped.map((_facet, index) => `facet${index}`);
  return [...imports, '', `export const facets = [${names.join(', ')}];`, ''].join('\n');
}

function writeApiModules(packageRoots: readonly string[], apiDir: string): void {
  fs.mkdirSync(apiDir, { recursive: true });
  const manifests = packageRoots.map((root) => ({
    root,
    manifest: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>,
  }));
  const apis = orderDeclaredApis(manifests.flatMap(({ root, manifest }) => declaredApisOf(root, manifest)));
  const facets = orderServerFacets(manifests.flatMap(({ root, manifest }) => declaredServerFacetsOf(root, manifest)));
  for (const scope of DOOM_API_SCOPES) {
    fs.writeFileSync(path.join(apiDir, `${scope}.routes.mjs`), renderApiRoutes(scope, apis));
    fs.writeFileSync(path.join(apiDir, `${scope}.facets.mjs`), renderServerFacets(scope, facets));
  }
}

/**
 * Playwright global setup: publish one real synchronization generation, then
 * replace its web bundle with the all-plugin test composition. Every test works
 * below that repository root, so the hub resolves the same valid registration
 * without sharing the developer's Doom state or rebuilding per test.
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
  const state = readSyncState(workspaceRoot, homeDir);
  if (
    registration?.webDirectory === null ||
    registration?.webDirectory === undefined ||
    registration.serverBundle === undefined ||
    state === undefined
  ) {
    throw new Error('global setup sync did not publish a complete web and server bundle');
  }
  const serverComposition = {
    root: registration.root,
    majorMode: state.selection.majorMode,
    activeLayers: (state.env.DOOMPI_LAYERS ?? '').split(',').filter(Boolean),
    apiDirectory: registration.apiDirectory,
    generation: registration.generation,
    fingerprint: registration.serverBundle.fingerprint,
  };
  const outDir = path.dirname(registration.webDirectory);
  const result = await bundleCockpitWeb({
    pluginRoots: [...packages.map((entry) => entry.root), crashRoot],
    outDir,
  });
  const apiDir = path.join(testRoot, 'api');
  writeApiModules(
    packages.map((entry) => entry.root),
    apiDir,
  );
  const workRoot = fs.mkdtempSync(path.join(workspaceRoot, 'node_modules', '.doompi-e2e-'));
  const previousDist = process.env[SYNCED_DIST_ENV];
  const previousHome = process.env[SYNCED_HOME_ENV];
  const previousServerComposition = process.env[SYNCED_SERVER_COMPOSITION_ENV];
  const previousWorkRoot = process.env[SYNCED_WORK_ROOT_ENV];
  const previousApiDir = process.env.DOOMPI_API_DIR;
  process.env[SYNCED_DIST_ENV] = result.assetsDir;
  process.env[SYNCED_HOME_ENV] = homeDir;
  process.env[SYNCED_SERVER_COMPOSITION_ENV] = JSON.stringify(serverComposition);
  process.env[SYNCED_WORK_ROOT_ENV] = workRoot;
  process.env.DOOMPI_API_DIR = apiDir;
  return () => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.rmSync(workRoot, { recursive: true, force: true });
    if (previousDist === undefined) delete process.env[SYNCED_DIST_ENV];
    else process.env[SYNCED_DIST_ENV] = previousDist;
    if (previousHome === undefined) delete process.env[SYNCED_HOME_ENV];
    else process.env[SYNCED_HOME_ENV] = previousHome;
    if (previousServerComposition === undefined) delete process.env[SYNCED_SERVER_COMPOSITION_ENV];
    else process.env[SYNCED_SERVER_COMPOSITION_ENV] = previousServerComposition;
    if (previousWorkRoot === undefined) delete process.env[SYNCED_WORK_ROOT_ENV];
    else process.env[SYNCED_WORK_ROOT_ENV] = previousWorkRoot;
    if (previousApiDir === undefined) delete process.env.DOOMPI_API_DIR;
    else process.env.DOOMPI_API_DIR = previousApiDir;
  };
}
