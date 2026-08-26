import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleCockpitWeb } from '../../src/adapters/webBundler.ts';
import { pluginPackageRoots } from './pluginRoots.ts';

/** A fixture plugin whose tool renderer throws on demand, so the timeline's fallback can be proved. */
const crashRoot = fileURLToPath(new URL('../fixtures/crash-plugin', import.meta.url));

/** Env var the cockpit fixture reads to serve the synced-style bundle. */
export const SYNCED_DIST_ENV = 'DOOMPI_E2E_SYNCED_DIST';

/**
 * Playwright global setup: build one synced-style bundle (the host shell plus
 * every workspace plugin, and the crash fixture) that the specs opting into
 * `assets: 'synced'` serve. This is the same code path `doompi sync` runs, so
 * the e2e suite proves it end to end.
 *
 * The plugin list is walked rather than written down. It used to be fourteen
 * hardcoded paths, and it had drifted: the domain, profile, help, and loop
 * plugins ship in the bundle sync produces and were missing from the suite
 * that is meant to prove it. A plugin added tomorrow is now covered without
 * anyone remembering this file exists.
 */
export default async function globalSetup(): Promise<() => void> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-e2e-sync-'));
  const result = await bundleCockpitWeb({
    pluginRoots: [...pluginPackageRoots().map((entry) => entry.root), crashRoot],
    outDir,
  });
  process.env[SYNCED_DIST_ENV] = result.assetsDir;
  return () => {
    fs.rmSync(outDir, { recursive: true, force: true });
  };
}
