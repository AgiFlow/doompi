import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleCockpitWeb } from '../../src/adapters/webBundler.ts';

const workflowRoot = fileURLToPath(new URL('../../../doompi-workflow', import.meta.url));
const teamRoot = fileURLToPath(new URL('../../../../../layers/team/doompi-team', import.meta.url));

/** Env var the cockpit fixture reads to serve the synced-style bundle. */
export const SYNCED_DIST_ENV = 'DOOMPI_E2E_SYNCED_DIST';

/**
 * Playwright global setup: build one synced-style bundle (host shell plus the
 * workspace's doompi-workflow plugin, discovered from its manifest) that the
 * specs opting into `assets: 'synced'` serve. This is the same code path
 * `doompi sync` runs, so the e2e suite proves it end to end.
 */
export default async function globalSetup(): Promise<() => void> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-e2e-sync-'));
  const result = await bundleCockpitWeb({ pluginRoots: [teamRoot, workflowRoot], outDir });
  process.env[SYNCED_DIST_ENV] = result.assetsDir;
  return () => {
    fs.rmSync(outDir, { recursive: true, force: true });
  };
}
