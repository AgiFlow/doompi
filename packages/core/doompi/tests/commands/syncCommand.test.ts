import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { piExtensionAliasPath, writePiExtensionAlias } from '../../src/adapters/piExtensionAlias';
import { PI_DISPATCHER_VERSION } from '../../src/adapters/piExtensionDispatcher';
import { DUPLICATE_REGISTRATION_DRIFT } from '../../src/adapters/projectPiSettings';
import { resolveSyncLocation, syncGenerationDirectory } from '../../src/adapters/syncLocation';
import {
  publishSyncRegistration,
  readSyncRegistration,
  SYNC_REGISTRATION_VERSION,
  syncStateSha256,
} from '../../src/adapters/syncRegistration.ts';
import {
  collectDrift,
  formatSyncResult,
  recordedEnvironment,
  SyncCommand,
  selectionCompositionFingerprint,
  selectionEnvironment,
  toSelection,
} from '../../src/commands/syncCommand';
import { DEFAULT_THEME, DEFAULT_THEME_NAME } from '@agimon-ai/doompi-ui/theme';
import { AMBIENT_EXTENSION_FILTER, readPiSettings, writePiSettings } from '../../src/exports/services/piSettings';
import {
  computeInputsHash,
  readSyncState,
  recordResolvedEntries,
  SYNC_STATE_VERSION,
  type SyncSelection,
  type SyncState,
  writeSyncState,
} from '../../src/exports/services/syncState';
import { createLayerResolvers } from '../../src/services/extensionAssembler.ts';
import { testMcpProjection } from '../helpers/mcpProjection.ts';

const mocks = vi.hoisted(() => ({
  readBootstrapStatus: vi.fn(() => ({ bootstrap: '/generated/bootstrap.mjs', fresh: true })),
  buildSyncedRuntime: vi.fn(
    async (
      _repoRoot: string,
      _environment: NodeJS.ProcessEnv,
      _homeDirectory: string,
      options: { state: SyncState },
    ) => ({
      bootstrap: '/generated/bootstrap.mjs',
      bundles: {},
      bundleManifests: {},
      state: options.state,
    }),
  ),
  ensureLayerPackages: vi.fn(async () => [] as string[]),
  missingLayerPackageSpecifiers: vi.fn(() => [] as string[]),
}));

vi.mock('../../src/adapters/bootstrapLocator.ts', () => ({
  readBootstrapStatus: mocks.readBootstrapStatus,
}));
vi.mock('../../src/adapters/syncedRuntimeBuilder.ts', () => ({
  buildSyncedRuntime: mocks.buildSyncedRuntime,
}));
vi.mock('../../src/adapters/layerPackageInstaller.ts', () => ({
  ensureLayerPackages: mocks.ensureLayerPackages,
  missingLayerPackageSpecifiers: mocks.missingLayerPackageSpecifiers,
}));

const LAYERS = `layers:
  style-system:
    extensions: [styleSystem]
defaultMajorMode: copilot
majorMode:
  copilot: [style-system]
  minimal: []
`;
const SELECTION: SyncSelection = { majorMode: 'copilot', domains: ['default'], preset: 'default' };
const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '../../../../..');
const temporaryRoots: string[] = [];

function makeRepository(config = 'projectTrust: ask\n'): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-sync-command-')));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
  fs.writeFileSync(path.join(root, '.doom', 'modes.yaml'), LAYERS);
  fs.writeFileSync(
    path.join(root, '.doom', 'domains.yaml'),
    'defaultDomains: [default]\ndomains:\n  default:\n    plugins: []\n',
  );
  fs.writeFileSync(path.join(root, '.doom', 'config.yaml'), config);
  initializePiFixture(root);
  return root;
}

function makeGitRepositoryWithPersonalConfig(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-sync-command-')));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const configDirectory = path.join(homeFor(root), '.pi', '.doom');
  fs.mkdirSync(configDirectory, { recursive: true });
  fs.writeFileSync(path.join(configDirectory, 'modes.yaml'), LAYERS);
  fs.writeFileSync(
    path.join(configDirectory, 'domains.yaml'),
    'defaultDomains: [default]\ndomains:\n  default:\n    plugins: []\n',
  );
  fs.writeFileSync(path.join(configDirectory, 'config.yaml'), 'projectTrust: ask\n');
  initializePiFixture(root);
  return root;
}

function makeGlobalConfiguration(): {
  root: string;
  homeDirectory: string;
  currentDirectory: string;
  environment: NodeJS.ProcessEnv;
} {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-sync-global-')));
  temporaryRoots.push(fixture);
  const homeDirectory = path.join(fixture, 'home');
  const root = path.join(homeDirectory, '.pi', '.doom');
  const currentDirectory = path.join(fixture, 'Documents');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(currentDirectory, { recursive: true });
  fs.writeFileSync(path.join(root, 'modes.yaml'), LAYERS);
  fs.writeFileSync(
    path.join(root, 'domains.yaml'),
    'defaultDomains: [default]\ndomains:\n  default:\n    plugins: []\n',
  );
  fs.writeFileSync(path.join(root, 'config.yaml'), 'projectTrust: ask\n');
  initializePiFixture(root);
  return {
    root,
    homeDirectory,
    currentDirectory,
    environment: { HOME: homeDirectory, PI_CODING_AGENT_DIR: agentDirectory(root) },
  };
}
function agentDirectory(root: string): string {
  return path.join(root, '.pi-user');
}

function homeFor(root: string): string {
  return path.join(root, 'home');
}

function environmentFor(root: string, values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { DOOMPI_ROOT: root, HOME: homeFor(root), PI_CODING_AGENT_DIR: agentDirectory(root), ...values };
}

function initializePiFixture(root: string): void {
  const packageScope = path.join(root, 'node_modules', '@agimon-ai');
  fs.mkdirSync(packageScope, { recursive: true });
  const linkPackage = (packageDirectory: string): void => {
    const manifestPath = path.join(packageDirectory, 'package.json');
    if (!fs.existsSync(manifestPath)) return;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: unknown };
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@agimon-ai/')) return;
    fs.symlinkSync(packageDirectory, path.join(packageScope, manifest.name.slice('@agimon-ai/'.length)), 'dir');
  };
  for (const group of ['core', 'default', 'minor', 'clients']) {
    const groupDirectory = path.join(WORKSPACE_ROOT, 'packages', group);
    for (const entry of fs.readdirSync(groupDirectory, { withFileTypes: true })) {
      if (entry.isDirectory()) linkPackage(path.join(groupDirectory, entry.name));
    }
  }
  const layersDirectory = path.join(WORKSPACE_ROOT, 'layers');
  for (const layer of fs.readdirSync(layersDirectory, { withFileTypes: true })) {
    if (!layer.isDirectory()) continue;
    const layerDirectory = path.join(layersDirectory, layer.name);
    for (const entry of fs.readdirSync(layerDirectory, { withFileTypes: true })) {
      if (entry.isDirectory()) linkPackage(path.join(layerDirectory, entry.name));
    }
  }
  const userDirectory = agentDirectory(root);
  const themePath = path.join(userDirectory, 'themes', `${DEFAULT_THEME_NAME}.json`);
  fs.mkdirSync(path.dirname(themePath), { recursive: true });
  fs.writeFileSync(themePath, `${JSON.stringify(DEFAULT_THEME, null, 2)}\n`);
  writePiSettings(userDirectory, { themePath, themeName: DEFAULT_THEME_NAME });
  writePiExtensionAlias(userDirectory);
}

/** State matching what a sync of this repository would have produced. */
async function writeMatchingState(root: string): Promise<SyncState> {
  const userDirectory = agentDirectory(root);
  const homeDirectory = homeFor(root);
  const location = resolveSyncLocation(root, homeDirectory);
  const generation = 'test-generation';
  const generationRoot = syncGenerationDirectory(location, generation);
  const apiDirectory = path.join(generationRoot, 'api');
  const themePath = path.join(userDirectory, 'themes', `${DEFAULT_THEME_NAME}.json`);
  fs.mkdirSync(apiDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(themePath), { recursive: true });
  fs.writeFileSync(themePath, `${JSON.stringify(DEFAULT_THEME, null, 2)}\n`);
  const state: SyncState = {
    version: SYNC_STATE_VERSION,
    root,
    identity: location.identity,
    inputsHash: computeInputsHash(root, SELECTION, homeDirectory),
    compositionFingerprint: selectionCompositionFingerprint(
      root,
      {
        agents: true,
        hooks: true,
        majorMode: SELECTION.majorMode,
        mcp: true,
        preset: 'default',
      },
      homeDirectory,
    ),
    selection: SELECTION,
    env: {},
    fileState: { profileEnvironment: {}, pluginHooks: [], mcpProjection: testMcpProjection(root) },
    resolved: recordResolvedEntries(loadMajorModesConfig(root, homeDirectory), createLayerResolvers(root)),
    baseline: { themePath, themeName: DEFAULT_THEME_NAME },
  };
  const statePath = await writeSyncState(root, state, homeDirectory, path.join(generationRoot, 'state.json'));
  const packageRoot = fs.realpathSync(path.resolve(import.meta.dirname, '../..'));
  const manifestPath = path.join(packageRoot, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    version: string;
    pi: { extensions: string[] };
  };
  publishSyncRegistration(
    root,
    {
      version: SYNC_REGISTRATION_VERSION,
      root,
      identity: location.identity,
      generation,
      generationRoot,
      statePath,
      stateSha256: syncStateSha256(statePath),
      webDirectory: null,
      apiDirectory,
      package: {
        root: packageRoot,
        version: manifest.version,
        manifestPath,
        entry: fs.realpathSync(path.resolve(packageRoot, manifest.pi.extensions[0])),
      },
    },
    homeDirectory,
  );
  writePiSettings(userDirectory, state.baseline);
  writePiExtensionAlias(userDirectory);
  return state;
}

function capture(): { output: { write(chunk: string): boolean }; text(): string } {
  const chunks: string[] = [];
  return {
    output: {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
    text: () => chunks.join(''),
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('selection defaults', () => {
  it('takes the repository selection as the default, the way init.el does', () => {
    const root = makeRepository(
      'projectTrust: ask\nselection:\n  majorMode: dev\n  domains: [marketing]\n  profile: mara\n',
    );

    expect(selectionEnvironment(root, {})).toMatchObject({
      DOOMPI_MAJOR_MODE: 'dev',
      DOOMPI_DOMAINS: 'marketing',
      DOOMPI_PROFILE: 'mara',
    });
  });

  it('lets an exported variable win over the declared default', () => {
    const root = makeRepository('projectTrust: ask\nselection:\n  majorMode: dev\n');

    expect(selectionEnvironment(root, { DOOMPI_MAJOR_MODE: 'minimal' }).DOOMPI_MAJOR_MODE).toBe('minimal');
  });

  it('changes nothing for a repository that declares no selection', () => {
    const root = makeRepository();

    expect(selectionEnvironment(root, { PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });

  it('uses modes.yaml as the fallback when config.yaml declares no selection', async () => {
    const root = makeRepository();
    fs.writeFileSync(
      path.join(root, '.doom', 'modes.yaml'),
      LAYERS.replace('defaultMajorMode: copilot', 'defaultMajorMode: minimal'),
    );
    await writeMatchingState(root);
    const { output, text } = capture();

    const code = await new SyncCommand().execute(['sync', '--check'], environmentFor(root), root, output);

    expect(code).toBe(1);
    expect(text()).toContain('selection changed since the last sync');
  });

  it('uses multiple defaults from domains.yaml when config.yaml declares no selection', async () => {
    const root = makeRepository();
    fs.writeFileSync(
      path.join(root, '.doom', 'domains.yaml'),
      'defaultDomains: [development, qa]\ndomains:\n  development:\n    plugins: []\n  qa:\n    plugins: []\n',
    );
    await writeMatchingState(root);
    const { output, text } = capture();

    const code = await new SyncCommand().execute(['sync', '--check'], environmentFor(root), root, output);

    expect(code).toBe(1);
    expect(text()).toContain('selection changed since the last sync');
  });
});

describe('recorded environment', () => {
  it('records the harness variables and nothing else the machine happens to carry', () => {
    const recorded = recordedEnvironment({
      DOOMPI_MAJOR_MODE: 'dev',
      CLAUDE_PROJECT_DIR: '/repo',
      AWS_SECRET_ACCESS_KEY: 'nope',
      HOME: '/home/someone',
    });

    expect(recorded).toEqual({ DOOMPI_MAJOR_MODE: 'dev', CLAUDE_PROJECT_DIR: '/repo' });
  });

  it('drops the launcher-only values a synced session must not inherit', () => {
    const recorded = recordedEnvironment({
      DOOMPI_MAJOR_MODE: 'dev',
      DOOMPI_TEMP_DIR: '/tmp/doom-pi-123',
      DOOMPI_CHILD_EXTENSIONS: '["/a"]',
      PI_SUBAGENT_PI_BINARY: '/repo/pi.sh',
    });

    expect(recorded).toEqual({ DOOMPI_MAJOR_MODE: 'dev' });
  });
});

describe('drift', () => {
  it('reports a repository that was never synced', () => {
    expect(collectDrift(makeRepository(), SELECTION, undefined)).toEqual(['no sync state: run doompi sync']);
  });

  it('sees no drift right after a matching sync', async () => {
    const root = makeRepository();
    const state = await writeMatchingState(root);

    expect(collectDrift(root, SELECTION, state, environmentFor(root))).toEqual([]);
  });

  it('separates a selection change from a config change', async () => {
    const root = makeRepository();
    const state = await writeMatchingState(root);

    expect(collectDrift(root, { ...SELECTION, majorMode: 'minimal' }, state, environmentFor(root))).toEqual([
      'selection changed since the last sync',
    ]);
  });

  it('notices an edit to .doom', async () => {
    const root = makeRepository();
    const state = await writeMatchingState(root);
    fs.appendFileSync(path.join(root, '.doom', 'modes.yaml'), '\n# edited\n');

    expect(collectDrift(root, SELECTION, state, environmentFor(root))).toContain('.doom configuration changed');
  });

  it('checks every precompiled bundle in diagnostic mode', async () => {
    const root = makeRepository();
    const state = await writeMatchingState(root);
    mocks.readBootstrapStatus.mockReturnValueOnce({ bootstrap: '/generated/bootstrap.mjs', fresh: false });

    expect(collectDrift(root, SELECTION, state, environmentFor(root))).toContain(
      'precompiled runtime is missing or stale',
    );
  });

  it('notices user settings and theme drift', async () => {
    const root = makeRepository();
    const state = await writeMatchingState(root);
    fs.writeFileSync(path.join(agentDirectory(root), 'settings.json'), '{"quietStartup": false}\n');
    fs.writeFileSync(state.baseline.themePath, '{}\n');

    const drift = collectDrift(root, SELECTION, state, environmentFor(root));
    expect(drift).toContain('Pi user settings are out of date; run doompi init');
    expect(drift).toContain('Pi user theme is out of date; run doompi init');
  });

  it('notices a duplicate registration in the project settings', async () => {
    const root = makeRepository();
    const state = await writeMatchingState(root);
    const projectSettingsPath = path.join(root, '.pi', 'settings.json');
    fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
    fs.writeFileSync(projectSettingsPath, `${JSON.stringify({ extensions: ['@agimon-ai/doompi'] })}\n`);

    expect(collectDrift(root, SELECTION, state, environmentFor(root))).toContain(DUPLICATE_REGISTRATION_DRIFT);
  });

  it('notices a missing user package alias', async () => {
    const root = makeRepository();
    const state = await writeMatchingState(root);
    fs.rmSync(piExtensionAliasPath(agentDirectory(root)), { recursive: true, force: true });

    expect(collectDrift(root, SELECTION, state, environmentFor(root))).toContain(
      'Pi user dispatcher is out of date; run doompi init',
    );
  });

  it('ignores persisted managed values when DPI supplies the settings overlay', async () => {
    const root = makeRepository();
    const state = await writeMatchingState(root);
    fs.writeFileSync(path.join(agentDirectory(root), 'settings.json'), '{"theme":"user-theme"}\n');
    const projectSettingsPath = path.join(root, '.pi', 'settings.json');
    fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
    fs.writeFileSync(projectSettingsPath, '{"extensions":["@agimon-ai/doompi"]}\n');

    expect(collectDrift(root, SELECTION, state, environmentFor(root), 'embedded')).toEqual([]);
  });
});

// Every case here stages and precompiles a real matrix on disk. That costs
// about a second per sync when the machine is idle and several times that when
// the rest of the suite is running beside it, so the default 5s timeout reports
// load as a failure. The suite timeout covers the whole block, including the
// cases that sync three times in a row.
describe('doompi sync', { timeout: 30_000 }, () => {
  it('syncs personal configuration into a Git checkout with no local .doom directory', async () => {
    const root = makeGitRepositoryWithPersonalConfig();
    const homeDirectory = homeFor(root);
    vi.stubEnv('HOME', homeDirectory);
    const environment = { HOME: homeDirectory, PI_CODING_AGENT_DIR: agentDirectory(root) };
    const { output, text } = capture();

    const code = await new SyncCommand().execute(['sync'], environment, root, output);

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(root, '.doom'))).toBe(false);
    expect(text()).toContain('mode:     copilot');
    expect(readSyncState(root, homeDirectory)?.selection).toEqual(SELECTION);
  });

  it('publishes the global composition when invoked outside a repository', async () => {
    const fixture = makeGlobalConfiguration();
    vi.stubEnv('HOME', fixture.homeDirectory);
    const { output, text } = capture();

    const code = await new SyncCommand().execute(['sync'], fixture.environment, fixture.currentDirectory, output);

    expect(code).toBe(0);
    expect(readSyncState(fixture.root, fixture.homeDirectory)?.root).toBe(fixture.root);
    expect(readSyncRegistration(fixture.root, fixture.homeDirectory)?.root).toBe(fixture.root);
    expect(text()).toContain('mode:     copilot');
  });

  it('stages and precompiles the matrix before registering DoomPi in Pi user settings', async () => {
    const root = makeRepository();
    const environment = environmentFor(root);
    const { output, text } = capture();

    const code = await new SyncCommand().execute(['sync'], environment, root, output);

    expect(code).toBe(0);
    expect(text()).toContain('mode:     copilot');
    const state = readSyncState(root, homeFor(root));
    expect(state?.selection).toEqual(SELECTION);
    expect(state?.env.DOOMPI_ROOT).toBe(root);
    expect(mocks.ensureLayerPackages).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: root,
        layers: expect.arrayContaining(['style-system']),
        environment,
      }),
    );
    expect(mocks.buildSyncedRuntime).toHaveBeenCalledWith(
      root,
      environment,
      homeFor(root),
      expect.objectContaining({ state: expect.any(Object), directory: expect.any(String) }),
    );
    expect(state?.baseline.themePath).toBe(path.join(agentDirectory(root), 'themes', `${DEFAULT_THEME_NAME}.json`));
    expect(fs.existsSync(state?.baseline.themePath ?? '')).toBe(true);
    expect(fs.existsSync(path.join(root, '.pi', 'doom'))).toBe(false);
    const location = resolveSyncLocation(root, homeFor(root));
    expect(fs.existsSync(location.registrationPath)).toBe(true);
    expect(fs.existsSync(location.statePath)).toBe(false);
    expect(readPiSettings(agentDirectory(root))).toMatchObject({
      quietStartup: true,
      extensions: ['@agimon-ai/doompi', AMBIENT_EXTENSION_FILTER],
      themes: [`themes/${DEFAULT_THEME_NAME}.json`],
    });
    const dispatcherPath = piExtensionAliasPath(agentDirectory(root));
    expect(fs.lstatSync(dispatcherPath).isDirectory()).toBe(true);
    expect(fs.lstatSync(dispatcherPath).isSymbolicLink()).toBe(false);

    const checked = capture();
    expect({
      code: await new SyncCommand().execute(['sync', '--check'], environment, root, checked.output),
      output: checked.text(),
    }).toEqual({ code: 0, output: 'doompi sync is up to date\n' });
    expect(mocks.buildSyncedRuntime).toHaveBeenCalledOnce();
  });

  it('stages DPI resources without mutating either normal settings file', async () => {
    const root = makeRepository();
    const globalSettingsPath = path.join(agentDirectory(root), 'settings.json');
    const projectSettingsPath = path.join(root, '.pi', 'settings.json');
    fs.mkdirSync(path.dirname(globalSettingsPath), { recursive: true });
    fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
    const globalSettings = '{"defaultModel":"sonnet","theme":"user-theme"}\n';
    const projectSettings = '{"defaultProvider":"anthropic","extensions":["./mine.ts"]}\n';
    fs.writeFileSync(globalSettingsPath, globalSettings);
    fs.writeFileSync(projectSettingsPath, projectSettings);
    const { output, text } = capture();

    const command = new SyncCommand({ settingsMode: 'embedded' });
    await expect(command.execute(['sync'], environmentFor(root), root, output)).resolves.toBe(0);

    expect(fs.readFileSync(globalSettingsPath, 'utf8')).toBe(globalSettings);
    expect(fs.readFileSync(projectSettingsPath, 'utf8')).toBe(projectSettings);
    expect(fs.existsSync(piExtensionAliasPath(agentDirectory(root)))).toBe(true);
    expect(text()).not.toContain('settings:');
    expect(text()).toContain('Run dpi from the repository root');

    const checked = capture();
    await expect(command.execute(['sync', '--check'], environmentFor(root), root, checked.output)).resolves.toBe(0);
  });

  it('removes the duplicate project registration and preserves unrelated project settings', async () => {
    const root = makeRepository();
    const projectSettingsPath = path.join(root, '.pi', 'settings.json');
    fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
    fs.writeFileSync(
      projectSettingsPath,
      `${JSON.stringify({
        extensions: ['@agimon-ai/doompi', './mine.ts'],
        themes: [`doom/${DEFAULT_THEME_NAME}.json`, './mine.json'],
        theme: DEFAULT_THEME_NAME,
        quietStartup: true,
        defaultModel: 'sonnet',
      })}\n`,
    );
    const projectAliasPath = piExtensionAliasPath(path.join(root, '.pi'));
    fs.mkdirSync(path.dirname(projectAliasPath), { recursive: true });
    fs.symlinkSync(path.resolve(import.meta.dirname, '../..'), projectAliasPath, 'dir');

    const { output, text } = capture();
    await new SyncCommand().execute(['sync'], environmentFor(root), root, output);

    expect(JSON.parse(fs.readFileSync(projectSettingsPath, 'utf8'))).toEqual({
      extensions: ['./mine.ts'],
      themes: [`doom/${DEFAULT_THEME_NAME}.json`, './mine.json'],
      theme: DEFAULT_THEME_NAME,
      quietStartup: true,
      defaultModel: 'sonnet',
    });
    expect(text()).toContain('removed duplicate registration');
    // The alias only existed to resolve the registration that just went away.
    expect(fs.existsSync(piExtensionAliasPath(path.join(root, '.pi')))).toBe(false);
  });

  it('self-heals a stale but upgradeable Pi dispatcher and reports the repair', async () => {
    const root = makeRepository();
    const dispatcherPath = piExtensionAliasPath(agentDirectory(root));
    fs.writeFileSync(
      path.join(dispatcherPath, 'package.json'),
      `${JSON.stringify({ name: '@agimon-ai/doompi', doompiDispatcher: 1 })}\n`,
    );

    const { output, text } = capture();
    const code = await new SyncCommand().execute(['sync'], environmentFor(root), root, output);

    expect(code).toBe(0);
    expect(text()).toContain('repair:   upgraded Pi user dispatcher from protocol 1 to 2');
    const manifest = JSON.parse(fs.readFileSync(path.join(dispatcherPath, 'package.json'), 'utf8')) as {
      doompiDispatcher?: unknown;
    };
    expect(manifest.doompiDispatcher).toBe(PI_DISPATCHER_VERSION);
  });

  it('refuses to repair an unmanaged dispatcher path and names the real condition', async () => {
    const root = makeRepository();
    const dispatcherPath = piExtensionAliasPath(agentDirectory(root));
    fs.rmSync(dispatcherPath, { recursive: true, force: true });
    fs.mkdirSync(dispatcherPath, { recursive: true });

    await expect(new SyncCommand().execute(['sync'], environmentFor(root), root, capture().output)).rejects.toThrow(
      'Pi user dispatcher is out of date; run doompi init',
    );
    expect(fs.existsSync(path.join(dispatcherPath, 'package.json'))).toBe(false);
  });

  it('names stale user settings instead of claiming the integration is uninitialized', async () => {
    const root = makeRepository();
    fs.writeFileSync(path.join(agentDirectory(root), 'settings.json'), '{"extensions":[]}\n');

    await expect(new SyncCommand().execute(['sync'], environmentFor(root), root, capture().output)).rejects.toThrow(
      'Pi user settings are out of date; run doompi init',
    );
  });
  it('drops a project registration key that empties out and leaves the root marker in place', async () => {
    const root = makeRepository();
    const projectSettingsPath = path.join(root, '.pi', 'settings.json');
    fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
    fs.writeFileSync(projectSettingsPath, `${JSON.stringify({ packages: ['@agimon-ai/doompi'] })}\n`);

    await new SyncCommand().execute(['sync'], environmentFor(root), root, capture().output);

    expect(JSON.parse(fs.readFileSync(projectSettingsPath, 'utf8'))).toEqual({});
    expect(fs.existsSync(projectSettingsPath)).toBe(true);

    const checked = capture();
    expect(await new SyncCommand().execute(['sync', '--check'], environmentFor(root), root, checked.output)).toBe(0);
  });

  it('keeps published generations and live sessions while activating a replacement', async () => {
    const root = makeRepository();
    const { output } = capture();
    const homeDirectory = homeFor(root);
    await new SyncCommand().execute(['sync'], environmentFor(root), root, output);
    const first = readSyncRegistration(root, homeDirectory);
    expect(first).toBeDefined();
    const publishedMarker = path.join(first!.generationRoot, 'published-marker');
    const live = path.join(resolveSyncLocation(root, homeDirectory).directory, 'run', '1234');
    fs.writeFileSync(publishedMarker, 'from the published generation');
    fs.mkdirSync(live, { recursive: true });

    await new SyncCommand().execute(['sync', '--force'], environmentFor(root), root, output);

    const second = readSyncRegistration(root, homeDirectory);
    expect(second?.generation).not.toBe(first?.generation);
    expect(fs.existsSync(publishedMarker)).toBe(true);
    expect(fs.existsSync(live)).toBe(true);
  });

  it('publishes nothing when a second sync finds the same inputs', async () => {
    const root = makeRepository();
    const homeDirectory = homeFor(root);
    await new SyncCommand().execute(['sync'], environmentFor(root), root, capture().output);
    const first = readSyncRegistration(root, homeDirectory);

    const { output, text } = capture();
    await new SyncCommand().execute(['sync'], environmentFor(root), root, output);

    // Republishing an identical generation moves the registration, so every
    // attached cockpit reloads and the previous generation becomes garbage.
    const second = readSyncRegistration(root, homeDirectory);
    expect(second?.generation).toBe(first?.generation);
    expect(text()).toContain('already up to date');
  });

  it('prunes generations the published one replaced', async () => {
    const root = makeRepository();
    const homeDirectory = homeFor(root);
    const generations: string[] = [];
    for (let run = 0; run < 3; run += 1) {
      await new SyncCommand().execute(['sync', '--force'], environmentFor(root), root, capture().output);
      const registration = readSyncRegistration(root, homeDirectory);
      if (registration) generations.push(registration.generationRoot);
    }

    // The published generation and the one before it survive, because a hub
    // that resolved its assets a moment ago may still be reading them.
    expect(fs.existsSync(generations[2] ?? '')).toBe(true);
    expect(fs.existsSync(generations[1] ?? '')).toBe(true);
    expect(fs.existsSync(generations[0] ?? '')).toBe(false);
  });

  it('keeps concurrent repositories isolated across a repeated sync', async () => {
    const repoA = makeRepository();
    const repoB = makeRepository();
    fs.writeFileSync(
      path.join(repoB, '.doom', 'modes.yaml'),
      LAYERS.replace('defaultMajorMode: copilot', 'defaultMajorMode: minimal'),
    );
    const sharedHome = path.join(repoA, 'shared-home');
    const sharedAgentDirectory = agentDirectory(repoA);
    const environmentA = {
      HOME: sharedHome,
      PI_CODING_AGENT_DIR: sharedAgentDirectory,
      DOOMPI_ROOT: repoA,
    };
    const environmentB = { ...environmentA, DOOMPI_ROOT: repoB };

    await Promise.all([
      new SyncCommand().execute(['sync'], environmentA, repoA, capture().output),
      new SyncCommand().execute(['sync'], environmentB, repoB, capture().output),
    ]);

    const registrationA = readSyncRegistration(repoA, sharedHome);
    const registrationB = readSyncRegistration(repoB, sharedHome);
    expect(registrationA?.generationRoot).not.toBe(registrationB?.generationRoot);
    expect(readSyncState(repoA, sharedHome)?.selection.majorMode).toBe('copilot');
    expect(readSyncState(repoB, sharedHome)?.selection.majorMode).toBe('minimal');
    const registrationBBytes = fs.readFileSync(resolveSyncLocation(repoB, sharedHome).registrationPath);
    const stateBBytes = fs.readFileSync(registrationB!.statePath);

    await new SyncCommand().execute(['sync'], environmentA, repoA, capture().output);

    expect(fs.readFileSync(resolveSyncLocation(repoB, sharedHome).registrationPath)).toEqual(registrationBBytes);
    expect(fs.readFileSync(registrationB!.statePath)).toEqual(stateBBytes);
    expect(fs.existsSync(registrationB!.apiDirectory)).toBe(true);
    if (registrationB!.webDirectory !== null) expect(fs.existsSync(registrationB!.webDirectory)).toBe(true);
  });
});

describe('doompi sync --check', () => {
  it('reports every configured package that is not installed without installing it', async () => {
    const root = makeRepository();
    mocks.missingLayerPackageSpecifiers.mockReturnValueOnce([
      '@scope/default-package',
      '@scope/inactive-layer-package',
    ]);
    const { output, text } = capture();

    const code = await new SyncCommand().execute(['sync', '--check'], environmentFor(root), root, output);

    expect(code).toBe(1);
    expect(text()).toContain('configured package is not installed: @scope/default-package');
    expect(text()).toContain('configured package is not installed: @scope/inactive-layer-package');
    expect(mocks.ensureLayerPackages).not.toHaveBeenCalled();
  });

  it('exits zero and says so when the synced config is current', async () => {
    const root = makeRepository();
    await writeMatchingState(root);
    const { output, text } = capture();

    const code = await new SyncCommand().execute(['sync', '--check'], environmentFor(root), root, output);

    expect(code).toBe(0);
    expect(text()).toContain('up to date');
  });

  it('exits non-zero when the registration belongs to another repository', async () => {
    const root = makeRepository();
    await writeMatchingState(root);
    const registrationPath = resolveSyncLocation(root, homeFor(root)).registrationPath;
    const registration = JSON.parse(fs.readFileSync(registrationPath, 'utf8')) as {
      identity: { repositoryId: string };
    };
    registration.identity.repositoryId = 'foreign-repository';
    fs.writeFileSync(registrationPath, JSON.stringify(registration));
    const { output, text } = capture();

    const code = await new SyncCommand().execute(['sync', '--check'], environmentFor(root), root, output);

    expect(code).toBe(1);
    expect(text()).toContain('belongs to another repository or worktree');
  });

  it('exits non-zero and names the drift', async () => {
    const root = makeRepository();
    await writeMatchingState(root);
    fs.appendFileSync(path.join(root, '.doom', 'modes.yaml'), '\n# edited\n');
    const { output, text } = capture();

    const code = await new SyncCommand().execute(['sync', '--check'], environmentFor(root), root, output);

    expect(code).toBe(1);
    expect(text()).toContain('.doom configuration changed');
  });

  it('claims only the sync subcommand', () => {
    const command = new SyncCommand();

    expect(command.matches(['sync', '--check'])).toBe(true);
    expect(command.matches(['--explain'])).toBe(false);
  });
});

describe('summary', () => {
  const result = {
    statePath: '/repo/.pi/doom/state.json',
    settingsPath: '/home/user/.pi/agent/settings.json',
    selection: SELECTION,
    mcpServers: ['code-intel'],
    skillCount: 3,
    agentCount: 2,
  };

  it('reports what was staged globally and locally', () => {
    const summary = formatSyncResult(result);
    expect(summary).toContain('mcp:      code-intel');
    expect(summary).toContain('/home/user/.pi/agent/settings.json');
    expect(summary).not.toContain('/trust');
  });
});

describe('toSelection', () => {
  it('keeps only the axes a sync pins', () => {
    expect(toSelection({ majorMode: 'dev', domains: ['a'], profile: 'p', preset: 'kimi' })).toEqual({
      majorMode: 'dev',
      domains: ['a'],
      profile: 'p',
      preset: 'kimi',
    });
  });
});
