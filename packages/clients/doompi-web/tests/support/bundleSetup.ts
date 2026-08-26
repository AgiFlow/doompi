import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type DeclaredPackageApi,
  DOOM_API_SCOPES,
  type DoomApiScope,
  declaredApisOf,
  orderDeclaredApis,
} from '@agimon-ai/doompi-extension-contracts/package-api';
import { bundleCockpitWeb } from '../../src/adapters/webBundler.ts';
import { pluginPackageRoots } from './pluginRoots.ts';

/** A fixture plugin whose tool renderer throws on demand, so the timeline's fallback can be proved. */
const crashRoot = fileURLToPath(new URL('../fixtures/crash-plugin', import.meta.url));

/** Env var the cockpit fixture reads to serve the synced-style bundle. */
export const SYNCED_DIST_ENV = 'DOOMPI_E2E_SYNCED_DIST';

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

function writeApiRoutes(packageRoots: readonly string[], apiDir: string): void {
  fs.mkdirSync(apiDir, { recursive: true });
  const declared = packageRoots.flatMap((root) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    return declaredApisOf(root, manifest);
  });
  const ordered = orderDeclaredApis(declared);
  for (const scope of DOOM_API_SCOPES) {
    fs.writeFileSync(path.join(apiDir, `${scope}.routes.mjs`), renderApiRoutes(scope, ordered));
  }
}

/**
 * Playwright global setup: build one synced-style bundle and the package API
 * route modules that the same synced composition publishes. Specs opting into
 * `assets: 'synced'` then exercise both halves of a plugin on a clean machine,
 * without inheriting the developer's ~/.doompi state.
 */
export default async function globalSetup(): Promise<() => void> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-e2e-sync-'));
  const packages = pluginPackageRoots();
  const result = await bundleCockpitWeb({
    pluginRoots: [...packages.map((entry) => entry.root), crashRoot],
    outDir,
  });
  const apiDir = path.join(outDir, 'api');
  writeApiRoutes(
    packages.map((entry) => entry.root),
    apiDir,
  );
  const previousApiDir = process.env.DOOMPI_API_DIR;
  process.env[SYNCED_DIST_ENV] = result.assetsDir;
  process.env.DOOMPI_API_DIR = apiDir;
  return () => {
    fs.rmSync(outDir, { recursive: true, force: true });
    if (previousApiDir === undefined) delete process.env.DOOMPI_API_DIR;
    else process.env.DOOMPI_API_DIR = previousApiDir;
  };
}
