import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMajorModesConfig, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import { extensionToolSource } from '@agimon-ai/doompi-ui/extensionName';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireCompositionClaim } from '../../src/adapters/compositionState';
import { resolveSyncLocation } from '../../src/adapters/syncLocation';
import { HARNESS_STATE_POINTER, readHarnessState, resetHarnessStore } from '../../src/exports/config/harnessState';
import {
  alreadyComposed,
  applyStartupFlags,
  COMPOSED_ENV,
  cleanupRunDirectory,
  composeDoomSession,
  composeLoadOrder,
  composeRuntimeLoadPlan,
  extensionsProvidedExternally,
  findSyncedRoot,
  loadComposedExtensions,
  MUTE_ENV,
  prepareRunDirectory,
  readStartupFlags,
  registerDoomFlags,
  startSyncedSession,
} from '../../src/exports/services/composer';
import {
  createMapResolvers,
  recordResolvedEntries,
  runDirectory,
  SYNC_STATE_VERSION,
  type SyncState,
  writeSyncState,
} from '../../src/exports/services/syncState';
import { BUNDLED_PRECOMPILE_STRATEGY, PRECOMPILE_STATE_VERSION } from '../../src/adapters/syncStateContract.ts';
import { assembleExtensions, PERSONA_ENTRY, resolveExtensionComposition } from '../../src/services/extensionAssembler';
import { testMcpProjection } from '../helpers/mcpProjection.ts';

const REPO_ROOT = path.resolve(__dirname, '..', 'fixtures', 'repository');
const TEST_COMPOSITION_FINGERPRINT = 'a'.repeat(64);
const majorModesConfig = loadMajorModesConfig(REPO_ROOT);
const configuredDefaultPackages = (majorModesConfig.default?.packages ?? []).map((entry) =>
  typeof entry === 'string' ? entry : entry.name,
);
const fakeResolvers = {
  ownEntry: (name: string) => `/own/${name}.ts`,
  packageEntry: (name: string) => `/pkg/${name}`,
  optionalPackageEntry: (name: string) => `/opt/${name}`,
  localEntry: (specifier: string, baseDirectory: string) => `/local/${baseDirectory}/${specifier}`,
};

const temporaryRoots: string[] = [];

function javascriptStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}
function makeRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-composer-')));
  temporaryRoots.push(root);
  return root;
}

function syncedState(root: string, overrides: Partial<SyncState> = {}): SyncState {
  return {
    version: SYNC_STATE_VERSION,
    root,
    identity: resolveSyncLocation(root).identity,
    inputsHash: 'hash',
    compositionFingerprint: TEST_COMPOSITION_FINGERPRINT,
    selection: { majorMode: 'dev', domains: ['development'], preset: 'default' },
    env: {},
    fileState: { profileEnvironment: {}, pluginHooks: [], mcpProjection: testMcpProjection(root) },
    resolved: recordResolvedEntries(majorModesConfig, fakeResolvers),
    baseline: { themePath: '/abs/theme.json', themeName: 'doom-pi-dark' },
    ...overrides,
  };
}

/** A real module on disk, because the loader imports rather than requires. */
function writeExtensionModule(directory: string, name: string, body: string): string {
  const modulePath = path.join(directory, `${name}.mjs`);
  fs.writeFileSync(modulePath, body);
  return modulePath;
}

function writeCompiledBundle(root: string, name: string): { bundle: string; input: string; manifest: string } {
  const generatedDirectory = resolveSyncLocation(root).directory;
  const bundle = path.join(generatedDirectory, 'dist', `${name}.mjs`);
  const input = path.join(root, `${name}-source.mjs`);
  const manifest = path.join(generatedDirectory, 'cache', `${name}.json`);
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(input, `export const source = ${javascriptStringLiteral(name)};\n`);
  fs.writeFileSync(
    bundle,
    `export default (pi) => pi.registerCommand(${javascriptStringLiteral(`${name}-loaded`)});\n`,
  );
  const stat = fs.statSync(input);
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      output: bundle,
      artifacts: [bundle],
      entries: [input],
      inputs: [{ path: input, size: stat.size, mtimeMs: stat.mtimeMs }],
    }),
  );
  return { bundle, input, manifest };
}

async function writeModeBundles(root: string): Promise<{
  copilot: ReturnType<typeof writeCompiledBundle>;
  minimal: ReturnType<typeof writeCompiledBundle>;
}> {
  fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.doom', 'modes.yaml'),
    [
      'layers:',
      '  feature:',
      '    extensions: [task]',
      'defaultMajorMode: copilot',
      'majorMode:',
      '  copilot: [feature]',
      '  minimal: []',
      '',
    ].join('\n'),
  );
  const config = loadMajorModesConfig(root);
  const state = syncedState(root, {
    selection: { majorMode: 'copilot', domains: ['development'], preset: 'default' },
    env: { DOOMPI_ROOT: root, DOOMPI_MAJOR_MODE: 'copilot', DOOMPI_LAYERS: 'feature' },
    resolved: recordResolvedEntries(config, fakeResolvers),
  });
  const resolvers = createMapResolvers(state.resolved);
  const fingerprintFor = (majorMode: string): string => {
    const environment = {
      ...state.env,
      DOOMPI_MAJOR_MODE: majorMode,
      DOOMPI_LAYERS: resolveLayers(config, majorMode).join(','),
    };
    const harness = readHarnessState(environment);
    return resolveExtensionComposition({
      agents: harness.agents,
      autoStop: false,
      preset: state.selection.preset,
      personaEntry: resolvers.packageEntry(PERSONA_ENTRY),
      majorMode,
      layers: [...harness.layers],
      majorModesConfig: config,
      resolvers,
      mute: false,
    }).fingerprint;
  };
  const copilotFingerprint = fingerprintFor('copilot');
  const minimalFingerprint = fingerprintFor('minimal');
  const copilot = writeCompiledBundle(root, 'copilot');
  const minimal = writeCompiledBundle(root, 'minimal');
  const generatedDirectory = resolveSyncLocation(root).directory;
  await writeSyncState(root, {
    ...state,
    compositionFingerprint: copilotFingerprint,
    bundles: {
      [copilotFingerprint]: copilot.bundle,
      [minimalFingerprint]: minimal.bundle,
    },
    precompile: {
      version: PRECOMPILE_STATE_VERSION,
      strategy: BUNDLED_PRECOMPILE_STRATEGY,
      bootstrapEntry: path.join(root, 'doom-entry.mjs'),
      bootstrapManifest: path.join(generatedDirectory, 'cache', 'bootstrap.json'),
      bundleManifests: {
        [copilotFingerprint]: copilot.manifest,
        [minimalFingerprint]: minimal.manifest,
      },
    },
  });
  return { copilot, minimal };
}

function environmentFor(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DOOMPI_ROOT: REPO_ROOT,
    DOOMPI_MAJOR_MODE: 'copilot',
    DOOMPI_LAYERS: resolveLayers(majorModesConfig, 'copilot').join(','),
    ...overrides,
  };
}

afterEach(() => {
  // The store caches for the life of a process, which a test suite is not.
  resetHarnessStore();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('findSyncedRoot', () => {
  it('prefers the working directory, the only place Pi reads .pi from', async () => {
    const root = makeRoot();
    await writeSyncState(root, syncedState(root));

    expect(findSyncedRoot(root)).toBe(root);
  });

  it('reports nothing for a directory that was never synced', () => {
    expect(findSyncedRoot(makeRoot())).toBeUndefined();
  });
});

describe('startSyncedSession', () => {
  it('leaves an inherited value alone, so a launcher run stays authoritative', async () => {
    const root = makeRoot();
    const environment: NodeJS.ProcessEnv = { DOOMPI_MAJOR_MODE: 'marketing' };

    const harness = await startSyncedSession(
      syncedState(root, { env: { DOOMPI_MAJOR_MODE: 'copilot', DOOMPI_ROOT: root } }),
      root,
      environment,
    );

    expect(harness.majorMode).toBe('marketing');
    expect(harness.root).toBe(root);
    await cleanupRunDirectory(root);
  });

  it('opens a state file this process owns and points the environment at it', async () => {
    const root = makeRoot();
    const environment: NodeJS.ProcessEnv = {};
    const pinnedProjection = testMcpProjection(root, path.join(root, '.pinned-mcp-staging'));

    const harness = await startSyncedSession(
      syncedState(root, {
        env: { DOOMPI_ROOT: root },
        fileState: { profileEnvironment: {}, pluginHooks: [], mcpProjection: pinnedProjection },
      }),
      root,
      environment,
    );

    expect(environment[HARNESS_STATE_POINTER]).toBe(path.join(runDirectory(root), 'harness-state.json'));
    // The session directory, not the pinned baseline: a live switch writes here.
    expect(harness.temporaryDirectory).toBe(runDirectory(root));
    expect(harness.mcpProjection).toEqual({ ...pinnedProjection, stagingDirectory: runDirectory(root) });
    expect(harness.mcpProjection?.fingerprint).toBe(pinnedProjection.fingerprint);
    await cleanupRunDirectory(root);
  });

  it('applies the profile environment defaults the launcher would have exported', async () => {
    const root = makeRoot();
    const environment: NodeJS.ProcessEnv = {};

    // Recorded as file state, since no variable carries it any more.
    await startSyncedSession(
      syncedState(root, {
        fileState: {
          profileEnvironment: { PERSONA_TONE: 'dry' },
          pluginHooks: [],
          mcpProjection: testMcpProjection(root),
        },
      }),
      root,
      environment,
    );

    expect(environment.PERSONA_TONE).toBe('dry');
    await cleanupRunDirectory(root);
  });
});

describe('startup flags', () => {
  it('reads the values Pi hands over too late to compose with', () => {
    expect(readStartupFlags(['--major-mode', 'dev', '--domains', 'a, b', '--mute'])).toEqual({
      majorMode: 'dev',
      domains: ['a', 'b'],
      profile: undefined,
      mute: true,
      removedLayer: false,
    });
  });

  it('reads the inline form Pi also accepts', () => {
    expect(readStartupFlags(['--profile=product-agiflow']).profile).toBe('product-agiflow');
  });

  it('notices the removed --layer flag instead of ignoring it', () => {
    expect(readStartupFlags(['--layer', 'dev']).removedLayer).toBe(true);
    expect(readStartupFlags(['--layer', 'dev']).majorMode).toBeUndefined();
  });

  it('reports no flags for a bare session', () => {
    expect(readStartupFlags([])).toEqual({
      majorMode: undefined,
      domains: undefined,
      profile: undefined,
      mute: false,
      removedLayer: false,
    });
  });

  it('registers each flag so Pi accepts it instead of reporting an unknown option', () => {
    const registerFlag = vi.fn();

    registerDoomFlags({ registerFlag });

    expect(registerFlag.mock.calls.map(([name]) => name)).toEqual(['major-mode', 'domains', 'profile', 'mute']);
  });
});

describe('run directory', () => {
  it('points harness state at a per-process directory instead of the baseline', async () => {
    const root = makeRoot();
    const environment: NodeJS.ProcessEnv = {};

    const directory = await prepareRunDirectory(root, environment);

    expect(directory).toBe(runDirectory(root));
    expect(environment.DOOMPI_TEMP_DIR).toBe(directory);
    expect(fs.existsSync(directory)).toBe(true);

    await cleanupRunDirectory(root);
    expect(fs.existsSync(directory)).toBe(false);
  });
});

describe('composeLoadOrder', () => {
  it('seeds compatibility feature order directly in each major mode', () => {
    expect(resolveLayers(majorModesConfig, 'minimal')).toEqual(['team', 'task']);
    expect(resolveLayers(majorModesConfig, 'copilot')).toEqual(['team', 'ask-user', 'task', 'vibe-lint']);
  });

  it('loads in canonical Pi factory activation order', async () => {
    const environment = environmentFor();
    const state = syncedState(REPO_ROOT);
    const harness = readHarnessState(environment);

    const order = await composeLoadOrder(state, harness, environment);

    const resolvers = createMapResolvers(state.resolved);
    const assembled = assembleExtensions({
      agents: harness.agents,
      autoStop: false,
      mute: false,
      preset: 'default',
      personaEntry: resolvers.packageEntry('@agimon-ai/doompi-profile/extensions/persona'),
      layers: [...harness.layers],
      majorModesConfig,
      resolvers,
    });
    expect(order).toEqual(assembled);
    expect(order.filter((entry) => entry === '/pkg/@agimon-ai/vibe-lint')).toHaveLength(1);
  });

  it('selects synchronized artifacts by canonical composition fingerprint', async () => {
    const environment = environmentFor();
    const harness = readHarnessState(environment);
    const unresolved = await composeRuntimeLoadPlan(syncedState(REPO_ROOT), harness, environment);
    const state = syncedState(REPO_ROOT, {
      bundles: { [unresolved.fingerprint]: '/sync/dev.mjs' },
    });

    const plan = await composeRuntimeLoadPlan(state, harness, environment);

    expect(plan).toEqual({
      entries: ['/sync/dev.mjs'],
      fingerprint: unresolved.fingerprint,
    });
  });

  it('drops the notification extension when the session was started muted', async () => {
    const loud = environmentFor();
    const muted = environmentFor({ [MUTE_ENV]: '1' });

    const withNotifications = await composeLoadOrder(syncedState(REPO_ROOT), readHarnessState(loud), loud);
    const withoutNotifications = await composeLoadOrder(syncedState(REPO_ROOT), readHarnessState(muted), muted);

    expect(withNotifications).toContain('/pkg/@agimon-ai/doompi-notification/extensions/pi');
    expect(withoutNotifications).not.toContain('/pkg/@agimon-ai/doompi-notification/extensions/pi');
  });

  it('publishes the child extension set detached subagents inherit', async () => {
    const environment = environmentFor();

    await composeLoadOrder(syncedState(REPO_ROOT), readHarnessState(environment), environment);

    const childExtensions = JSON.parse(environment.DOOMPI_CHILD_EXTENSIONS ?? '[]') as string[];
    expect(childExtensions).toEqual([
      '/own/cordisHost.ts',
      '/pkg/@agimon-ai/doompi-config/extensions/pi',
      ...configuredDefaultPackages.map((name) => `/pkg/${name}`),
      '/pkg/@agimon-ai/doompi-team',
      '/pkg/@agimon-ai/doompi-user-feedback',
      '/pkg/@agimon-ai/doompi-task',
      '/pkg/@agimon-ai/vibe-lint',
      '/pkg/@agimon-ai/doompi-profile/extensions/persona',
      '/own/cordisFinalizer.ts',
    ]);
    expect(environment.DOOMPI_CORDIS_HOST_REQUIRED).toBe('1');
  });
});

describe('loadComposedExtensions', () => {
  it('keeps imports serial when the concurrent trial fails the readiness gate', async () => {
    const directory = makeRoot();
    const stateKey = `doompi-import-overlap-${path.basename(directory)}`;
    const first = writeExtensionModule(
      directory,
      'overlap-first',
      [
        `const stateKey = Symbol.for(${JSON.stringify(stateKey)});`,
        'const state = globalThis[stateKey] ??= { started: [] };',
        "state.started.push('first');",
        'const deadline = Date.now() + 250;',
        "while (!state.started.includes('second') && Date.now() < deadline) {",
        '  await new Promise((resolve) => setTimeout(resolve, 5));',
        '}',
        "const overlapped = state.started.includes('second');",
        "export default (pi) => pi.registerCommand(overlapped ? 'first-overlapped' : 'first-serial');",
      ].join('\n'),
    );
    const second = writeExtensionModule(
      directory,
      'overlap-second',
      [
        `const stateKey = Symbol.for(${JSON.stringify(stateKey)});`,
        'const state = globalThis[stateKey] ??= { started: [] };',
        "state.started.push('second');",
        "export default (pi) => pi.registerCommand('second');",
      ].join('\n'),
    );
    const registerCommand = vi.fn();
    const problems: string[] = [];

    const loaded = await loadComposedExtensions(
      { registerCommand } as unknown as ExtensionAPI,
      [first, second],
      problems,
    );

    expect(registerCommand.mock.calls.map(([name]) => name)).toEqual(['first-serial', 'second']);
    expect(loaded).toEqual([first, second]);
    expect(problems).toEqual([]);
  });

  it('activates each factory before importing the next entry', async () => {
    const directory = makeRoot();
    const eventsPath = path.join(directory, 'import-events.log');
    const first = writeExtensionModule(
      directory,
      'phase-first',
      [
        "import fs from 'node:fs';",
        `const eventsPath = ${JSON.stringify(eventsPath)};`,
        "fs.appendFileSync(eventsPath, 'import:first\\n');",
        "export default () => fs.appendFileSync(eventsPath, 'factory:first\\n');",
      ].join('\n'),
    );
    const second = writeExtensionModule(
      directory,
      'phase-second',
      [
        "import fs from 'node:fs';",
        `const eventsPath = ${JSON.stringify(eventsPath)};`,
        "fs.appendFileSync(eventsPath, 'import:second\\n');",
        'await new Promise((resolve) => setTimeout(resolve, 30));',
        "fs.appendFileSync(eventsPath, 'import:second:done\\n');",
        "export default () => fs.appendFileSync(eventsPath, 'factory:second\\n');",
      ].join('\n'),
    );
    const problems: string[] = [];

    await loadComposedExtensions({} as ExtensionAPI, [first, second], problems);

    const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    expect(events).toEqual(['import:first', 'factory:first', 'import:second', 'import:second:done', 'factory:second']);
    expect(problems).toEqual([]);
  });

  it('hands every factory the same Pi API, in order', async () => {
    const directory = makeRoot();
    const first = writeExtensionModule(directory, 'first', 'export default (pi) => pi.registerCommand("first");');
    const second = writeExtensionModule(directory, 'second', 'export default (pi) => pi.registerCommand("second");');
    const registerCommand = vi.fn();
    const problems: string[] = [];

    const loaded = await loadComposedExtensions(
      { registerCommand } as unknown as ExtensionAPI,
      [first, second],
      problems,
    );

    expect(registerCommand.mock.calls.map(([name]) => name)).toEqual(['first', 'second']);
    expect(loaded).toEqual([first, second]);
    expect(problems).toEqual([]);
  });

  it('records tool ownership for extensions loaded without a precompiled set', async () => {
    const directory = makeRoot();
    const first = writeExtensionModule(
      directory,
      'source-first',
      'export default (pi) => pi.registerTool({ name: "composed_source_first" });',
    );
    const second = writeExtensionModule(
      directory,
      'source-second',
      'export default (pi) => pi.registerTool({ name: "composed_source_second" });',
    );
    const problems: string[] = [];

    const pi = { registerTool: vi.fn() } as unknown as ExtensionAPI;
    await loadComposedExtensions(pi, [first, second], problems);

    expect(extensionToolSource(pi, 'composed_source_first')).toBe(first);
    expect(extensionToolSource(pi, 'composed_source_second')).toBe(second);
    expect(problems).toEqual([]);
  });

  it('keeps later same-name tool definitions and provenance without a precompiled set', async () => {
    const directory = makeRoot();
    const first = writeExtensionModule(
      directory,
      'replacement-first',
      [
        'export default (pi) => {',
        '  pi.registerTool({ name: "read", description: "first read" });',
        '  pi.registerTool({ name: "edit", description: "first edit" });',
        '};',
      ].join('\n'),
    );
    const second = writeExtensionModule(
      directory,
      'replacement-second',
      [
        'export default (pi) => {',
        '  pi.registerTool({ name: "read", description: "second read" });',
        '  pi.registerTool({ name: "edit", description: "second edit" });',
        '};',
      ].join('\n'),
    );
    const tools = new Map<string, { name: string; description: string }>();
    const pi = {
      registerTool(tool: { name: string; description: string }) {
        tools.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI;
    const problems: string[] = [];

    await loadComposedExtensions(pi, [first, second], problems);

    expect(tools).toEqual(
      new Map([
        ['read', { name: 'read', description: 'second read' }],
        ['edit', { name: 'edit', description: 'second edit' }],
      ]),
    );
    expect(extensionToolSource(pi, 'read')).toBe(second);
    expect(extensionToolSource(pi, 'edit')).toBe(second);
    expect(problems).toEqual([]);
  });

  it('keeps import and factory failures ordered without losing later entries', async () => {
    const directory = makeRoot();
    const importBroken = writeExtensionModule(
      directory,
      'import-broken',
      'await new Promise((resolve) => setTimeout(resolve, 30)); throw new Error("import boom");',
    );
    const factoryBroken = writeExtensionModule(
      directory,
      'factory-broken',
      'export default () => { throw new Error("factory boom"); };',
    );
    const notAFactory = writeExtensionModule(directory, 'plain', 'export default { activate: true };');
    const working = writeExtensionModule(directory, 'working', 'export default (pi) => pi.registerCommand("ok");');
    const registerCommand = vi.fn();
    const problems: string[] = [];

    const loaded = await loadComposedExtensions(
      { registerCommand } as unknown as ExtensionAPI,
      [importBroken, factoryBroken, notAFactory, working],
      problems,
    );

    expect(loaded).toEqual([working]);
    expect(registerCommand).toHaveBeenCalledWith('ok');
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('import boom');
    expect(problems[1]).toContain('factory boom');
    expect(problems[2]).toContain('does not export an extension factory');
  });
});

describe('applyStartupFlags', () => {
  it('switches the major mode through the same call the /mode command makes', async () => {
    const environment = environmentFor();
    const problems: string[] = [];
    vi.spyOn(process, 'env', 'get').mockReturnValue(environment);

    await applyStartupFlags(
      { majorMode: 'minimal', mute: false, removedLayer: false },
      majorModesConfig,
      REPO_ROOT,
      problems,
    );

    expect(problems).toEqual([]);
    expect(environment.DOOMPI_MAJOR_MODE).toBe('minimal');
    vi.restoreAllMocks();
  });

  it('reports the removed --layer flag rather than starting on the wrong mode', async () => {
    const environment = environmentFor();
    const problems: string[] = [];
    vi.spyOn(process, 'env', 'get').mockReturnValue(environment);

    await applyStartupFlags({ mute: false, removedLayer: true }, majorModesConfig, REPO_ROOT, problems);

    expect(problems).toEqual(['--layer was replaced by --major-mode']);
    vi.restoreAllMocks();
  });

  it('collects a bad value instead of throwing, which would drop the whole setup', async () => {
    const environment = environmentFor();
    const problems: string[] = [];
    vi.spyOn(process, 'env', 'get').mockReturnValue(environment);

    await applyStartupFlags(
      { majorMode: 'nope', profile: 'ghost', mute: false, removedLayer: false },
      majorModesConfig,
      REPO_ROOT,
      problems,
    );

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('--major-mode nope');
    expect(problems[1]).toContain('--profile ghost');
    vi.restoreAllMocks();
  });
});

describe('extensionsProvidedExternally', () => {
  const resolved = {
    'pkg:@agimon-ai/doompi-config/extensions/pi': path.join(REPO_ROOT, 'packages', 'cli', 'doompi', 'package.json'),
  };

  it('stands down when the launcher already passed the composed set', () => {
    const provided = Object.values(resolved);

    expect(extensionsProvidedExternally(['--extension', provided[0]!, '-p', 'hello'], resolved)).toBe(true);
  });

  it('still composes for an unrelated one-off extension', () => {
    expect(extensionsProvidedExternally(['-e', '/tmp/debug.ts'], resolved)).toBe(false);
  });

  it('composes for a plain session', () => {
    expect(extensionsProvidedExternally([], resolved)).toBe(false);
  });
});

describe('composeDoomSession', () => {
  it('loads nothing when the launcher already supplied the same extensions', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
    fs.writeFileSync(path.join(root, '.doom', 'modes.yaml'), 'layers: {}\nmajorMode:\n  dev: []\n');
    const entry = writeExtensionModule(root, 'every', 'export default (pi) => pi.registerCommand("loaded");');
    const state = syncedState(root, {
      resolved: { 'own:domains': entry },
      env: { DOOMPI_ROOT: root },
    });
    await writeSyncState(root, state);
    const registerCommand = vi.fn();

    const outcome = await composeDoomSession({ registerCommand } as unknown as ExtensionAPI, {
      cwd: root,
      argv: ['--extension', entry],
      environment: {},
    });

    expect(outcome.loaded).toEqual([]);
    expect(outcome.problems).toEqual([]);
    expect(registerCommand).not.toHaveBeenCalled();
  });

  it('asks for a sync instead of loading anything when the repository has no state', async () => {
    const pi = { registerFlag: vi.fn(), on: vi.fn() } as unknown as ExtensionAPI;

    const outcome = await composeDoomSession(pi, { cwd: makeRoot(), argv: [], environment: {} });

    expect(outcome.loaded).toEqual([]);
    expect(outcome.problems).toEqual([
      'doompi is configured for Pi but this repository was never synced. Run doompi sync.',
    ]);
  });

  it('validates the bundle selected after startup flags and ignores a stale inactive bundle', async () => {
    const root = makeRoot();
    const builds = await writeModeBundles(root);
    fs.appendFileSync(builds.copilot.input, '// stale inactive mode\n');
    const registerCommand = vi.fn();
    const environment: NodeJS.ProcessEnv = {};
    vi.spyOn(process, 'env', 'get').mockReturnValue(environment);

    const outcome = await composeDoomSession({ registerCommand } as unknown as ExtensionAPI, {
      cwd: root,
      argv: ['--major-mode', 'minimal'],
      environment,
    });

    expect(outcome.problems).toEqual([]);
    expect(outcome.loaded).toEqual([builds.minimal.bundle]);
    expect(registerCommand).toHaveBeenCalledWith('minimal-loaded');
    vi.restoreAllMocks();
    await cleanupRunDirectory(root);
  });

  it('fails closed before importing a stale selected bundle', async () => {
    const root = makeRoot();
    const builds = await writeModeBundles(root);
    fs.appendFileSync(builds.copilot.input, '// stale selected mode\n');
    const registerCommand = vi.fn();

    const outcome = await composeDoomSession({ registerCommand } as unknown as ExtensionAPI, {
      cwd: root,
      argv: [],
      environment: {},
    });

    expect(outcome.loaded).toEqual([]);
    expect(outcome.problems).toEqual(['doompi could not read its synchronized state. Run doompi sync.']);
    expect(registerCommand).not.toHaveBeenCalled();
    await cleanupRunDirectory(root);
  });

  it('hydrates, loads the set, and reports a config that moved on since the sync', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
    fs.writeFileSync(path.join(root, '.doom', 'modes.yaml'), 'layers: {}\nmajorMode:\n  dev: []\n');
    const entry = writeExtensionModule(root, 'every', 'export default (pi) => pi.registerCommand("loaded");');
    const everyEntryLoads = {
      ownEntry: () => entry,
      packageEntry: () => entry,
      optionalPackageEntry: () => entry,
      localEntry: () => entry,
    };
    await writeSyncState(
      root,
      syncedState(root, {
        env: { DOOMPI_ROOT: root, DOOMPI_MAJOR_MODE: 'copilot' },
        resolved: recordResolvedEntries(majorModesConfig, everyEntryLoads),
        inputsHash: 'recorded-before-an-edit',
      }),
    );
    const environment: NodeJS.ProcessEnv = {};
    const registerCommand = vi.fn();
    const pi = { registerCommand } as unknown as ExtensionAPI;

    const outcome = await composeDoomSession(pi, { cwd: root, argv: ['--mute'], environment });

    expect(outcome.problems).toEqual([]);
    expect(outcome.loaded.length).toBeGreaterThan(0);
    expect(outcome.stale).toBe(true);
    expect(environment[COMPOSED_ENV]).toBe('1');
    expect(environment[MUTE_ENV]).toBe('1');
    expect(environment.DOOMPI_TEMP_DIR).toBe(runDirectory(root));
    await cleanupRunDirectory(root);
  });

  it('marks the process so a reload does not re-apply the command line', () => {
    expect(alreadyComposed({})).toBe(false);
    expect(alreadyComposed({ [COMPOSED_ENV]: '1' })).toBe(true);
  });

  it('allows one composition per load cycle and releases for reload', () => {
    const releaseFirst = acquireCompositionClaim();
    expect(releaseFirst).toBeTypeOf('function');
    expect(acquireCompositionClaim()).toBeUndefined();

    releaseFirst?.();
    const releaseReload = acquireCompositionClaim();
    expect(releaseReload).toBeTypeOf('function');
    releaseReload?.();
  });
});
