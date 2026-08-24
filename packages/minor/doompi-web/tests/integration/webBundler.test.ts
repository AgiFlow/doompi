import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleCockpitWeb } from '../../src/adapters/webBundler.ts';
import { loadHubChannels } from '../../src/adapters/webHubPluginLoader.ts';

const workflowRoot = fileURLToPath(new URL('../../../doompi-workflow', import.meta.url));

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('the sync-time cockpit bundler', () => {
  it('bundles the shell with an installed plugin and hands the hub its channels', { timeout: 120_000 }, async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-bundle-'));
    cleanups.push(() => fs.rmSync(outDir, { recursive: true, force: true }));
    const notices: string[] = [];

    // The real thing: Vite compiles the host shell plus doompi-workflow's
    // shipped web source, discovered from its doompiWeb manifest alone.
    const result = await bundleCockpitWeb({
      pluginRoots: [workflowRoot],
      outDir,
      onNotice: (message) => notices.push(message),
    });
    expect(result.pluginIds).toEqual(['subagents', 'workflows']);
    expect(fs.existsSync(path.join(result.assetsDir, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(result.assetsDir, 'webPlugins.server.json'))).toBe(true);
    const bundledJs = fs
      .readdirSync(path.join(result.assetsDir, 'assets'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => fs.readFileSync(path.join(result.assetsDir, 'assets', name), 'utf8'))
      .join('\n');
    // The workflows panel really is compiled in: its empty-state copy appears.
    expect(bundledJs).toContain('no workflow runs yet');

    // The hub loads the plugin's built channel from the registry the bundle carries.
    const channels = await loadHubChannels(result.assetsDir, (message) => notices.push(message));
    expect(channels.map((channel) => channel.frameType)).toEqual(['subagent_runs', 'workflow_runs']);
  });

  it('falls back to built-in channels when the assets carry no registry', async () => {
    const notices: string[] = [];
    const channels = await loadHubChannels('/nonexistent-assets', (message) => notices.push(message));
    expect(channels.map((channel) => channel.frameType)).toEqual(['subagent_runs']);
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
    expect(channels.map((channel) => channel.frameType)).toEqual(['subagent_runs']);
    expect(notices.some((message) => message.includes("web plugin 'ghost' hub channels unavailable"))).toBe(true);
  });
});
