import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleCockpitWeb } from '../../src/adapters/webBundler.ts';

const workflowRoot = fileURLToPath(new URL('../../../../minor/doompi-workflow', import.meta.url));
const runnerRoot = fileURLToPath(new URL('../../../../default/doompi-runner', import.meta.url));
const teamRoot = fileURLToPath(new URL('../../../../../layers/team/doompi-team', import.meta.url));
const readRoot = fileURLToPath(new URL('../../../../default/doompi-read', import.meta.url));
const editRoot = fileURLToPath(new URL('../../../../default/doompi-edit', import.meta.url));
const grepRoot = fileURLToPath(new URL('../../../../default/doompi-grep', import.meta.url));
const mcpRoot = fileURLToPath(new URL('../../../../default/doompi-mcp', import.meta.url));
const uiRoot = fileURLToPath(new URL('../../../../core/doompi-ui', import.meta.url));
const planRoot = fileURLToPath(new URL('../../../../minor/doompi-plan', import.meta.url));
const goalRoot = fileURLToPath(new URL('../../../../minor/doompi-goal', import.meta.url));
const voiceRoot = fileURLToPath(new URL('../../../../minor/doompi-voice', import.meta.url));
const taskRoot = fileURLToPath(new URL('../../../../../layers/task/doompi-task', import.meta.url));
const askUserRoot = fileURLToPath(new URL('../../../../../layers/ask-user/doompi-user-feedback', import.meta.url));
/** A fixture plugin whose tool renderer throws on demand, so the timeline's fallback can be proved. */
const crashRoot = fileURLToPath(new URL('../fixtures/crash-plugin', import.meta.url));

/** Env var the cockpit fixture reads to serve the synced-style bundle. */
export const SYNCED_DIST_ENV = 'DOOMPI_E2E_SYNCED_DIST';

/**
 * Playwright global setup: build one synced-style bundle (host shell plus
 * every workspace plugin that renders a tool, discovered from their
 * manifests, and the crash fixture) that the specs opting into
 * `assets: 'synced'` serve. This is the same code path
 * `doompi sync` runs, so the e2e suite proves it end to end.
 */
export default async function globalSetup(): Promise<() => void> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-e2e-sync-'));
  const result = await bundleCockpitWeb({
    pluginRoots: [
      teamRoot,
      runnerRoot,
      workflowRoot,
      readRoot,
      editRoot,
      grepRoot,
      mcpRoot,
      uiRoot,
      planRoot,
      goalRoot,
      voiceRoot,
      taskRoot,
      askUserRoot,
      crashRoot,
    ],
    outDir,
  });
  process.env[SYNCED_DIST_ENV] = result.assetsDir;
  return () => {
    fs.rmSync(outDir, { recursive: true, force: true });
  };
}
