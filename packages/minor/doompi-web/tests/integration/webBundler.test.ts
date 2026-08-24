import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleCockpitWeb } from '../../src/adapters/webBundler.ts';
import { loadHubChannels } from '../../src/adapters/webHubPluginLoader.ts';

const workflowRoot = fileURLToPath(new URL('../../../doompi-workflow', import.meta.url));
const planRoot = fileURLToPath(new URL('../../../doompi-plan', import.meta.url));
const teamRoot = fileURLToPath(new URL('../../../../../layers/team/doompi-team', import.meta.url));

function bundledJsHas(assetsDir: string, needle: string): boolean {
  return fs
    .readdirSync(path.join(assetsDir, 'assets'))
    .filter((name) => name.endsWith('.js'))
    .some((name) => fs.readFileSync(path.join(assetsDir, 'assets', name), 'utf8').includes(needle));
}

/** The built stylesheet: plugin utility classes prove the plugin dirs were scanned. */
function bundledCssHas(assetsDir: string, needle: string): boolean {
  return fs
    .readdirSync(path.join(assetsDir, 'assets'))
    .filter((name) => name.endsWith('.css'))
    .some((name) => fs.readFileSync(path.join(assetsDir, 'assets', name), 'utf8').includes(needle));
}

let cleanups: Array<() => void> = [];

/** A package root with only a manifest, for the failure paths the sync must survive. */
function brokenPackage(manifest: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `doompi-web-${String(manifest.name)}-`));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  return root;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('the sync-time cockpit bundler', () => {
  it('bundles the shell with an installed plugin and hands the hub its channels', { timeout: 120_000 }, async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-bundle-'));
    cleanups.push(() => fs.rmSync(outDir, { recursive: true, force: true }));
    const notices: string[] = [];

    // Two broken packages ride along: one with a malformed block, one whose
    // entry file is missing. A user can install anything, so each is a notice
    // and the bundle still builds from the rest.
    const malformed = brokenPackage({
      name: 'malformed',
      doompiWeb: { pluginId: 'Bad Case', client: './web/index.ts' },
    });
    const entryless = brokenPackage({
      name: 'entryless',
      doompiWeb: { pluginId: 'entryless', client: './web/index.ts' },
    });

    // The real thing: Vite compiles the host shell plus doompi-workflow's
    // shipped web source, discovered from its doompiWeb manifest alone.
    const result = await bundleCockpitWeb({
      pluginRoots: [teamRoot, malformed, workflowRoot, entryless, planRoot],
      outDir,
      onNotice: (message) => notices.push(message),
    });
    // doompi-plan proves the metadata-only plugin shape: no tab, no channel,
    // just a minor-mode declaration compiled into the bundle.
    expect(result.pluginIds).toEqual(['subagents', 'workflows', 'plan']);
    expect(notices.filter((message) => message.includes('skipped'))).toEqual([
      expect.stringMatching(/malformed.*skipped: .*kebab-case/),
      expect.stringMatching(/entryless.*skipped: .*client\.entry/),
    ]);
    expect(bundledJsHas(result.assetsDir, 'no subagent runs yet')).toBe(true);
    expect(fs.existsSync(path.join(result.assetsDir, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(result.assetsDir, 'webPlugins.server.json'))).toBe(true);
    // The roots file beside the bundle is what the dev server reads to serve
    // the same composition with hot reload.
    expect(JSON.parse(fs.readFileSync(path.join(outDir, 'pluginRoots.json'), 'utf8'))).toEqual([
      teamRoot,
      malformed,
      workflowRoot,
      entryless,
      planRoot,
    ]);
    // Both moved panels really are compiled in: their empty-state copy appears.
    expect(bundledJsHas(result.assetsDir, 'no workflow runs yet')).toBe(true);
    // Tailwind scanned the plugin sources too: the subagents grid uses an
    // auto-fill column template the host shell never does.
    expect(bundledCssHas(result.assetsDir, 'auto-fill')).toBe(true);

    // The hub loads the plugin's built channel from the registry the bundle carries.
    const channels = await loadHubChannels(result.assetsDir, (message) => notices.push(message));
    expect(channels.map((channel) => channel.frameType)).toEqual(['subagent_runs', 'workflow_runs']);
  });

  it('serves zero channels for assets without a registry, since nothing is built in', async () => {
    const channels = await loadHubChannels('/nonexistent-assets', () => undefined);
    expect(channels).toEqual([]);
  });

  it('treats a registry naming a missing hub entry as a notice, not a crash', async () => {
    const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-registry-'));
    cleanups.push(() => fs.rmSync(assetsDir, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(assetsDir, 'webPlugins.server.json'),
      JSON.stringify([{ pluginId: 'ghost', channels: ['ghost_runs'], hubEntry: '/nowhere/dist/webHub.mjs' }]),
    );
    const notices: string[] = [];
    const channels = await loadHubChannels(assetsDir, (message) => notices.push(message));
    expect(channels).toEqual([]);
    expect(notices.some((message) => message.includes("web plugin 'ghost' hub channels unavailable"))).toBe(true);
  });
});
