import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { piExtensionAliasPath, writePiExtensionAlias } from '../../src/adapters/piExtensionAlias';
import { DUPLICATE_REGISTRATION_DRIFT } from '../../src/adapters/projectPiSettings';
import { resolveSyncLocation } from '../../src/adapters/syncLocation';
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
import { testMcpProjection } from '../helpers/mcpProjection.ts';

const mocks = vi.hoisted(() => ({
  readBootstrapStatus: vi.fn(() => ({ bootstrap: '/generated/bootstrap.mjs', fresh: true })),
  buildSyncedRuntime: vi.fn(async () => ({
    bootstrap: '/generated/bootstrap.mjs',
    bundles: {},
    bundleManifests: {},
  })),
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
  return root;
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

/** State matching what a sync of this repository would have produced. */
async function writeMatchingState(root: string): Promise<SyncState> {
  const userDirectory = agentDirectory(root);
  const themePath = path.join(userDirectory, 'themes', `${DEFAULT_THEME_NAME}.json`);
  fs.mkdirSync(path.dirname(themePath), { recursive: true });
  fs.writeFileSync(themePath, `${JSON.stringify(DEFAULT_THEME, null, 2)}\n`);
  const state: SyncState = {
    version: SYNC_STATE_VERSION,
    root,
    identity: resolveSyncLocation(root, homeFor(root)).identity,
    inputsHash: computeInputsHash(root, SELECTION, homeFor(root)),
    compositionFingerprint: selectionCompositionFingerprint(root, {
      agents: true,
      hooks: true,
      majorMode: SELECTION.majorMode,
      mcp: true,
      preset: 'default',
    }),
    selection: SELECTION,
    env: {},
    fileState: { profileEnvironment: {}, pluginHooks: [], mcpProjection: testMcpProjection(root) },
    resolved: recordResolvedEntries(loadMajorModesConfig(root)),
    baseline: { themePath, themeName: DEFAULT_THEME_NAME },
  };
  await writeSyncState(root, state, homeFor(root));
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
    expect(drift).toContain('Pi user settings are out of date');
    expect(drift).toContain('Pi user theme is out of date');
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
    fs.rmSync(piExtensionAliasPath(agentDirectory(root)), { force: true });

    expect(collectDrift(root, SELECTION, state, environmentFor(root))).toContain(
      'Pi user extension alias is out of date',
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

describe('doompi sync', () => {
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
    expect(mocks.ensureLayerPackages).toHaveBeenCalledWith({
      repoRoot: root,
      config: expect.any(Object),
      layers: ['style-system'],
      environment,
    });
    expect(mocks.buildSyncedRuntime).toHaveBeenCalledWith(root, environment, homeFor(root));
    expect(state?.baseline.themePath).toBe(path.join(agentDirectory(root), 'themes', `${DEFAULT_THEME_NAME}.json`));
    expect(fs.existsSync(state?.baseline.themePath ?? '')).toBe(true);
    expect(fs.existsSync(path.join(root, '.pi', 'doom'))).toBe(false);
    expect(fs.existsSync(resolveSyncLocation(root, homeFor(root)).statePath)).toBe(true);
    expect(readPiSettings(agentDirectory(root))).toMatchObject({
      quietStartup: true,
      extensions: ['@agimon-ai/doompi', AMBIENT_EXTENSION_FILTER],
      themes: [`themes/${DEFAULT_THEME_NAME}.json`],
    });
    const aliasPath = piExtensionAliasPath(agentDirectory(root));
    expect(fs.lstatSync(aliasPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(aliasPath)).toBe(fs.realpathSync(path.resolve(import.meta.dirname, '../..')));

    const checked = capture();
    expect(await new SyncCommand().execute(['sync', '--check'], environment, root, checked.output)).toBe(0);
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
    writePiExtensionAlias(path.join(root, '.pi'));

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

  it('clears what a previous selection staged but leaves live sessions alone', async () => {
    const root = makeRepository();
    const { output } = capture();
    await new SyncCommand().execute(['sync'], environmentFor(root), root, output);
    const generatedDirectory = resolveSyncLocation(root, homeFor(root)).directory;
    const stale = path.join(generatedDirectory, 'persona.md');
    const live = path.join(generatedDirectory, 'run', '1234');
    fs.writeFileSync(stale, 'from an earlier selection');
    fs.mkdirSync(live, { recursive: true });

    await new SyncCommand().execute(['sync'], environmentFor(root), root, output);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
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

  it('exits non-zero when sync state belongs to another repository', async () => {
    const root = makeRepository();
    const state = await writeMatchingState(root);
    fs.writeFileSync(
      resolveSyncLocation(root, homeFor(root)).statePath,
      JSON.stringify({ ...state, root: path.join(root, 'foreign-repository') }),
    );
    const { output, text } = capture();

    const code = await new SyncCommand().execute(['sync', '--check'], environmentFor(root), root, output);

    expect(code).toBe(1);
    expect(text()).toContain('belongs to a different repository');
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
