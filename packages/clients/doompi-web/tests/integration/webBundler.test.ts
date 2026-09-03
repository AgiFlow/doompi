import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleCockpitWeb } from '../../src/adapters/webBundler.ts';
import { loadHubChannels } from '../../src/adapters/webHubPluginLoader.ts';

const workflowRoot = fileURLToPath(new URL('../../../../minor/doompi-workflow', import.meta.url));
const planRoot = fileURLToPath(new URL('../../../../minor/doompi-plan', import.meta.url));
const voiceRoot = fileURLToPath(new URL('../../../../minor/doompi-voice', import.meta.url));
const teamRoot = fileURLToPath(new URL('../../../../../layers/team/doompi-team', import.meta.url));
const securityPackageRoot = fileURLToPath(new URL('../../../../core/doompi-web-security', import.meta.url));
const securitySingletonFixtureRoot = fileURLToPath(new URL('../fixtures/security-singleton-plugin', import.meta.url));

function bundledJsHas(assetsDir: string, needle: string): boolean {
  return fs
    .readdirSync(path.join(assetsDir, 'assets'))
    .filter((name) => name.endsWith('.js'))
    .some((name) => fs.readFileSync(path.join(assetsDir, 'assets', name), 'utf8').includes(needle));
}

function filesBelow(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(entryPath) : [entryPath];
  });
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

interface InstalledSecuritySingletonPlugin {
  pluginRoot: string;
  physicalSecurityRoot: string;
  publicSecurityRoot: string;
}

/** Reproduces an installed plugin resolving its own physical security package copy. */
function installedSecuritySingletonPlugin(): InstalledSecuritySingletonPlugin {
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-security-singleton-'));
  cleanups.push(() => fs.rmSync(pluginRoot, { recursive: true, force: true }));
  fs.cpSync(securitySingletonFixtureRoot, pluginRoot, { recursive: true });

  const sourceManifestPath = path.join(securityPackageRoot, 'package.json');
  const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8')) as {
    version?: unknown;
    exports?: Record<string, unknown>;
  };
  if (typeof sourceManifest.version !== 'string') throw new Error('The security fixture needs a package version.');
  const physicalSecurityRoot = path.join(
    pluginRoot,
    'node_modules',
    '.pnpm',
    `@agimon-ai+doompi-web-security@${sourceManifest.version}`,
    'node_modules',
    '@agimon-ai',
    'doompi-web-security',
  );
  fs.mkdirSync(physicalSecurityRoot, { recursive: true });
  fs.copyFileSync(sourceManifestPath, path.join(physicalSecurityRoot, 'package.json'));
  fs.cpSync(path.join(securityPackageRoot, 'dist'), path.join(physicalSecurityRoot, 'dist'), { recursive: true });

  const wrapperPath = path.join(physicalSecurityRoot, 'dist', 'browser-probe.mjs');
  fs.writeFileSync(
    wrapperPath,
    "globalThis['__doompi_physical_security_copy__'] = true;\nexport * from './browser.mjs';\n",
  );
  const browserExport = sourceManifest.exports?.['./browser'];
  if (typeof browserExport !== 'object' || browserExport === null || Array.isArray(browserExport)) {
    throw new Error('The security fixture needs the ./browser export.');
  }
  (browserExport as Record<string, unknown>).import = './dist/browser-probe.mjs';
  fs.writeFileSync(path.join(physicalSecurityRoot, 'package.json'), `${JSON.stringify(sourceManifest, null, 2)}\n`);

  const publicSecurityRoot = path.join(pluginRoot, 'node_modules', '@agimon-ai', 'doompi-web-security');
  fs.mkdirSync(path.dirname(publicSecurityRoot), { recursive: true });
  fs.symlinkSync(physicalSecurityRoot, publicSecurityRoot, 'dir');
  return { pluginRoot, physicalSecurityRoot, publicSecurityRoot };
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
    // just a minor-mode declaration compiled into the bundle. No manifest
    // names a registrationOrder, so the install order is the plugin ids.
    expect(result.pluginIds).toEqual(['plan', 'subagents', 'workflows']);
    expect(notices.filter((message) => message.includes('skipped'))).toEqual([
      expect.stringMatching(/malformed.*skipped: .*kebab-case/),
      expect.stringMatching(/entryless.*skipped: .*client\.entry/),
    ]);
    expect(bundledJsHas(result.assetsDir, 'no subagent runs yet')).toBe(true);
    expect(fs.existsSync(path.join(result.assetsDir, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(result.assetsDir, 'webPlugins.server.json'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'webPlugins.server.json'))).toBe(true);

    const compositionScript = fs.readFileSync(path.join(result.pluginsDir, 'composition.js'), 'utf8');
    expect(fs.readFileSync(path.join(result.pluginsDir, 'index.html'), 'utf8')).not.toContain('<script');
    expect(compositionScript).toContain('DoomPiWebPluginComposition');
    expect(compositionScript).toContain('DoomPiWebPluginRuntime');
    expect(compositionScript).not.toContain('__doompi_physical_security_copy__');
    const clientManifest = JSON.parse(fs.readFileSync(path.join(result.pluginsDir, 'manifest.json'), 'utf8')) as Record<
      string,
      { file?: string; isEntry?: boolean }
    >;
    expect(Object.values(clientManifest)).toContainEqual(
      expect.objectContaining({ file: 'composition.js', isEntry: true }),
    );
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
    expect(channels.map((channel) => channel.frameType)).toEqual([
      'subagent_runs',
      'subagent_catalog',
      'workflow_runs',
      'workflow_catalog',
    ]);
  });

  it('resolves an installed plugin to the host sealed transport singleton', { timeout: 120_000 }, async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-security-bundle-'));
    cleanups.push(() => fs.rmSync(outDir, { recursive: true, force: true }));
    const installed = installedSecuritySingletonPlugin();

    expect(fs.realpathSync(installed.publicSecurityRoot)).toBe(fs.realpathSync(installed.physicalSecurityRoot));
    expect(fs.realpathSync(installed.physicalSecurityRoot)).not.toBe(fs.realpathSync(securityPackageRoot));

    const result = await bundleCockpitWeb({ pluginRoots: [installed.pluginRoot], outDir });

    expect(result.pluginIds).toContain('security-singleton-probe');
    expect(bundledJsHas(result.assetsDir, 'security-singleton-probe')).toBe(true);
    expect(bundledJsHas(result.assetsDir, '__doompi_physical_security_copy__')).toBe(false);
    expect(bundledJsHas(result.assetsDir, '@agimon-ai/doompi-web-security/browser')).toBe(false);
  });

  it('keeps a plugin worker runtime and its emitted assets inside the composition', { timeout: 120_000 }, async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-voice-bundle-'));
    cleanups.push(() => fs.rmSync(outDir, { recursive: true, force: true }));

    const result = await bundleCockpitWeb({ pluginRoots: [voiceRoot], outDir });
    const pluginFiles = filesBelow(result.pluginsDir);
    const bundledJavaScript = pluginFiles
      .filter((file) => file.endsWith('.js'))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    const compositionScript = fs.readFileSync(path.join(result.pluginsDir, 'composition.js'), 'utf8');

    expect(result.pluginIds).toEqual(['voice']);
    expect(bundledJavaScript).toContain('onnxruntime');
    expect(bundledJavaScript).not.toContain('DoomPiWebPluginRuntime.onnxruntime');
    expect(pluginFiles.filter((file) => file.endsWith('.js')).length).toBeGreaterThan(1);
    expect(pluginFiles.some((file) => file.endsWith('.onnx'))).toBe(true);
    expect(pluginFiles.some((file) => file.endsWith('.css'))).toBe(true);
    expect(compositionScript).toContain('assets/');
    expect(compositionScript).toContain('document.currentScript');
    expect(compositionScript).not.toContain('new URL(`/assets/');
    expect(compositionScript).not.toContain('../models/silero_vad_v6.2.1.onnx');
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
