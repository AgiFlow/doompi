import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { afterEach, describe, expect, it } from 'vitest';
import { computeWebSourcesHash } from '../../src/adapters/syncState.ts';
import { resolveSyncLocation, syncGenerationDirectory } from '../../src/adapters/syncLocation';
import {
  publishSyncRegistration,
  SYNC_REGISTRATION_VERSION,
  syncStateSha256,
} from '../../src/adapters/syncRegistration.ts';
import { BUNDLED_PRECOMPILE_STRATEGY, PRECOMPILE_STATE_VERSION } from '../../src/adapters/syncStateContract';
import {
  computeInputsHash,
  createMapResolvers,
  createRecordingResolvers,
  legacySyncStatePath,
  localEntryKey,
  localKey,
  localPackageNameKey,
  ownKey,
  packageEntryKey,
  packageKey,
  readLocatedSyncState,
  readMcpServerNames,
  readSyncState as readState,
  recordResolvedEntries,
  SYNC_STATE_VERSION,
  type SyncSelection,
  type SyncState,
  settingsRelativePath,
  runDirectory as stateRunDirectory,
  writeSyncState as writeState,
} from '../../src/exports/services/syncState';
import { testMcpProjection } from '../helpers/mcpProjection.ts';

const REPO_ROOT = path.resolve(__dirname, '..', 'fixtures', 'repository');
const SELECTION: SyncSelection = { majorMode: 'dev', domains: ['development'], preset: 'default' };
const TEST_COMPOSITION_FINGERPRINT = 'a'.repeat(64);
const VALID_PRECOMPILE = {
  version: PRECOMPILE_STATE_VERSION,
  strategy: BUNDLED_PRECOMPILE_STRATEGY,
  bootstrapEntry: '/a',
  bootstrapManifest: '/a.manifest.json',
  bundleManifests: { [TEST_COMPOSITION_FINGERPRINT]: '/a.manifest.json' },
} as const;

const temporaryRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-sync-state-'));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
  return root;
}

function homeFor(root: string): string {
  return path.join(root, 'home');
}

const TEST_GENERATION = 'test-generation';

function syncStatePath(root: string): string {
  const location = resolveSyncLocation(root, homeFor(root));
  return path.join(syncGenerationDirectory(location, TEST_GENERATION), 'state.json');
}

function readSyncState(root: string): SyncState | undefined {
  return readState(root, homeFor(root));
}

function publishTestRegistration(root: string, target: string): void {
  const home = homeFor(root);
  const location = resolveSyncLocation(root, home);
  const generationRoot = syncGenerationDirectory(location, TEST_GENERATION);
  const apiDirectory = path.join(generationRoot, 'api');
  const packageRoot = path.join(root, '.doompi-package');
  const manifestPath = path.join(packageRoot, 'package.json');
  const entry = path.join(packageRoot, 'pi.mjs');
  fs.mkdirSync(apiDirectory, { recursive: true });
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(entry, 'export default () => undefined;\n');
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ name: '@agimon-ai/doompi', version: 'test', pi: { extensions: ['./pi.mjs'] } })}\n`,
  );
  publishSyncRegistration(
    root,
    {
      version: SYNC_REGISTRATION_VERSION,
      root: location.root,
      identity: location.identity,
      generation: TEST_GENERATION,
      generationRoot,
      statePath: target,
      stateSha256: syncStateSha256(target),
      webDirectory: null,
      apiDirectory,
      package: {
        root: fs.realpathSync(packageRoot),
        version: 'test',
        manifestPath,
        entry,
      },
    },
    home,
  );
}

async function writeSyncState(root: string, value: SyncState): Promise<string> {
  const target = syncStatePath(root);
  const written = await writeState(root, value, homeFor(root), target);
  publishTestRegistration(root, written);
  return written;
}

function runDirectory(root: string, processId: number): string {
  return stateRunDirectory(root, processId, homeFor(root));
}

function state(root: string, overrides: Partial<SyncState> = {}): SyncState {
  return {
    version: SYNC_STATE_VERSION,
    root,
    identity: resolveSyncLocation(root, homeFor(root)).identity,
    inputsHash: computeInputsHash(root, SELECTION, homeFor(root)),
    compositionFingerprint: TEST_COMPOSITION_FINGERPRINT,
    selection: SELECTION,
    env: { DOOMPI_ROOT: root },
    fileState: { profileEnvironment: {}, pluginHooks: [], mcpProjection: testMcpProjection(root) },
    resolved: { [ownKey('domains')]: '/abs/domains.ts' },
    baseline: { themePath: '/abs/theme.json', themeName: 'doom-pi-dark' },
    ...overrides,
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('sync state file', () => {
  it('round-trips through disk', async () => {
    const root = makeRoot();
    const written = state(root);

    const statePath = await writeSyncState(root, written);

    expect(statePath).toBe(syncStatePath(root));
    expect(readSyncState(root)).toEqual(written);
  });

  it('refuses to write a current-version record with a cross-repository MCP projection', async () => {
    const root = makeRoot();
    const foreign = makeRoot();
    const written = state(root);

    await expect(
      writeSyncState(root, {
        ...written,
        fileState: { ...written.fileState, mcpProjection: testMcpProjection(foreign) },
      }),
    ).rejects.toThrow(/MCP projection belongs to another repository/);
  });

  it('refuses to write a precompile mapping that does not cover the published bundles', async () => {
    const root = makeRoot();
    const bundle = path.join(resolveSyncLocation(root, homeFor(root)).directory, 'dist', 'copilot.mjs');

    await expect(
      writeSyncState(root, {
        ...state(root),
        bundles: { [TEST_COMPOSITION_FINGERPRINT]: bundle },
        precompile: { ...VALID_PRECOMPILE, bundleManifests: {} },
      }),
    ).rejects.toThrow(/invalid precompile record/);
  });

  it('holds resolved environment values, so it is owner-readable only', async () => {
    const root = makeRoot();

    await writeSyncState(root, state(root));

    expect(fs.statSync(syncStatePath(root)).mode & 0o777).toBe(0o600);
  });

  it('reports no state rather than failing when the repository was never synced', () => {
    expect(readSyncState(makeRoot())).toBeUndefined();
  });

  it('rejects the last environment-coupled version instead of misreading it', async () => {
    const root = makeRoot();

    await writeRaw(root, state(root, { version: SYNC_STATE_VERSION - 1 }));

    expect(SYNC_STATE_VERSION).toBe(13);
    expect(() => readSyncState(root)).toThrow(/version 12/);
  });

  /** Writes a raw state file, bypassing the typed writer, to test the reader. */
  async function writeRaw(root: string, contents: unknown): Promise<void> {
    const target = syncStatePath(root);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const record =
      typeof contents === 'object' && contents !== null && !Array.isArray(contents)
        ? (contents as Record<string, unknown>)
        : undefined;
    const normalized = record
      ? {
          identity: resolveSyncLocation(root, homeFor(root)).identity,
          compositionFingerprint: TEST_COMPOSITION_FINGERPRINT,
          ...record,
          fileState: record.fileState ?? {
            profileEnvironment: {},
            pluginHooks: [],
            mcpProjection: testMcpProjection(root),
          },
        }
      : contents;
    fs.writeFileSync(target, typeof normalized === 'string' ? normalized : JSON.stringify(normalized));
    publishTestRegistration(root, target);
  }

  it('refuses a state file that is not valid JSON', async () => {
    const root = makeRoot();

    await writeRaw(root, '{ not json');

    expect(() => readSyncState(root)).toThrow(/not valid JSON/);
  });

  it('refuses a state file that is not an object', async () => {
    const root = makeRoot();

    await writeRaw(root, '"a string"');

    expect(() => readSyncState(root)).toThrow(/must be an object/);
  });

  it('refuses a state file with no string root or inputsHash', async () => {
    const root = makeRoot();

    await writeRaw(root, { version: SYNC_STATE_VERSION, root: 5, inputsHash: 'abc' });

    expect(() => readSyncState(root)).toThrow(/string root and inputsHash/);
  });

  it('refuses a state file whose selection carries no major mode', async () => {
    const root = makeRoot();

    await writeRaw(root, { version: SYNC_STATE_VERSION, root, inputsHash: 'abc', selection: {} });

    expect(() => readSyncState(root)).toThrow(/selection with a majorMode/);
  });

  it('refuses a state file whose baseline carries no theme path', async () => {
    const root = makeRoot();

    await writeRaw(root, {
      version: SYNC_STATE_VERSION,
      root,
      inputsHash: 'abc',
      selection: { majorMode: 'dev' },
      baseline: {},
    });

    expect(() => readSyncState(root)).toThrow(/baseline with a themePath/);
  });

  it('refuses a state file whose resolved map is not an object', async () => {
    const root = makeRoot();

    await writeRaw(root, {
      version: SYNC_STATE_VERSION,
      root,
      inputsHash: 'abc',
      selection: { majorMode: 'dev' },
      baseline: { themePath: '/abs/theme.json', themeName: 'doom-pi-dark' },
      env: {},
      resolved: 'nope',
    });

    expect(() => readSyncState(root)).toThrow(/resolved to be an object/);
  });

  it('defaults the optional selection fields a partial record omits', async () => {
    const root = makeRoot();

    await writeRaw(root, {
      version: SYNC_STATE_VERSION,
      root,
      inputsHash: 'abc',
      selection: { majorMode: 'dev', domains: ['a', 7, 'b'] },
      baseline: { themePath: '/abs/theme.json', themeName: 'doom-pi-dark' },
      env: {},
      resolved: {},
    });

    const parsed = readSyncState(root);

    expect(parsed?.selection).toEqual({ majorMode: 'dev', domains: ['a', 'b'], profile: undefined, preset: 'default' });
    expect(parsed?.fileState).toEqual({
      profileEnvironment: {},
      pluginHooks: [],
      mcpProjection: testMcpProjection(root),
    });
  });

  it('rejects a version-current record that omits the file-only MCP projection', async () => {
    const root = makeRoot();

    await writeRaw(root, {
      version: SYNC_STATE_VERSION,
      root,
      inputsHash: 'abc',
      selection: { majorMode: 'dev' },
      baseline: { themePath: '/abs/theme.json', themeName: 'doom-pi-dark' },
      env: {},
      resolved: {},
      fileState: { profileEnvironment: {}, pluginHooks: [] },
    });

    expect(() => readSyncState(root)).toThrow(/requires a valid MCP projection/);
  });

  /**
   * Every one of these is a state file a mismatched Doom Pi install could leave
   * behind, and the package entry turns each rejection into a "run doompi sync"
   * warning rather than a failed load, so none may be quietly half-accepted.
   */
  it.each([
    { field: 'compiled', value: 'nope', message: /compiled to be an object/ },
    { field: 'bundles', value: [], message: /bundles to be an object/ },
  ])('refuses a state file whose $field map is not an object', async ({ field, value, message }) => {
    const root = makeRoot();

    await writeRaw(root, {
      version: SYNC_STATE_VERSION,
      root,
      inputsHash: 'abc',
      selection: { majorMode: 'dev' },
      baseline: { themePath: '/abs/theme.json', themeName: 'doom-pi-dark' },
      env: {},
      resolved: {},
      [field]: value,
    });

    expect(() => readSyncState(root)).toThrow(message);
  });

  it.each([
    { case: 'not a record', precompile: 'native' },
    { case: 'a non-numeric version', precompile: { ...VALID_PRECOMPILE, version: 'four' } },
    { case: 'an obsolete version', precompile: { ...VALID_PRECOMPILE, version: PRECOMPILE_STATE_VERSION - 1 } },
    { case: 'an unknown strategy', precompile: { ...VALID_PRECOMPILE, strategy: 'handmade' } },
    { case: 'no bootstrap entry', precompile: { ...VALID_PRECOMPILE, bootstrapEntry: undefined } },
    { case: 'a non-string bootstrap manifest', precompile: { ...VALID_PRECOMPILE, bootstrapManifest: 7 } },
    { case: 'manifests that are not a map', precompile: { ...VALID_PRECOMPILE, bundleManifests: [] } },
    {
      case: 'a manifest entry that is not a string',
      precompile: { ...VALID_PRECOMPILE, bundleManifests: { [TEST_COMPOSITION_FINGERPRINT]: 9 } },
    },
    {
      case: 'a non-canonical composition fingerprint',
      precompile: { ...VALID_PRECOMPILE, bundleManifests: { 'not-a-fingerprint': '/a.manifest.json' } },
    },
  ])('refuses a precompile record with $case', async ({ precompile }) => {
    const root = makeRoot();

    await writeRaw(root, {
      version: SYNC_STATE_VERSION,
      root,
      inputsHash: 'abc',
      selection: { majorMode: 'dev' },
      baseline: { themePath: '/abs/theme.json', themeName: 'doom-pi-dark' },
      env: {},
      resolved: {},
      precompile,
    });

    expect(() => readSyncState(root)).toThrow(/invalid precompile record/);
  });

  it('reads back a complete bundle precompile record and drops a non-string bootstrap pointer', async () => {
    const root = makeRoot();
    const generatedDirectory = resolveSyncLocation(root, homeFor(root)).directory;
    const compiledPath = path.join(generatedDirectory, 'dist', 'copilot.mjs');
    const manifestPath = path.join(generatedDirectory, 'cache', 'sets', 'manifest.json');
    const bootstrapEntry = path.join(generatedDirectory, 'dist', 'entry.mjs');

    await writeRaw(root, {
      version: SYNC_STATE_VERSION,
      root,
      inputsHash: 'abc',
      selection: { majorMode: 'dev' },
      baseline: { themePath: '/abs/theme.json', themeName: 'doom-pi-dark' },
      env: {},
      resolved: {},
      bootstrap: 42,
      compiled: { copilot: compiledPath },
      bundles: { [TEST_COMPOSITION_FINGERPRINT]: compiledPath, broken: 7 },
      precompile: {
        version: PRECOMPILE_STATE_VERSION,
        strategy: BUNDLED_PRECOMPILE_STRATEGY,
        bootstrapEntry,
        bootstrapManifest: manifestPath,
        bundleManifests: { [TEST_COMPOSITION_FINGERPRINT]: manifestPath },
      },
    });

    const parsed = readSyncState(root);

    expect(parsed?.bootstrap).toBeUndefined();
    expect(parsed?.compiled).toEqual({ copilot: compiledPath });
    // A non-string value is dropped rather than rejected: the map is a cache.
    expect(parsed?.bundles).toEqual({ [TEST_COMPOSITION_FINGERPRINT]: compiledPath });
    expect(parsed?.precompile).toEqual({
      version: PRECOMPILE_STATE_VERSION,
      strategy: BUNDLED_PRECOMPILE_STRATEGY,
      bootstrapEntry,
      bootstrapManifest: manifestPath,
      bundleManifests: { [TEST_COMPOSITION_FINGERPRINT]: manifestPath },
    });
  });

  it('rejects obsolete native graph state', async () => {
    const root = makeRoot();

    await writeRaw(root, {
      ...state(root),
      nativeGraphs: { [TEST_COMPOSITION_FINGERPRINT]: '/obsolete/native.manifest.json' },
    });

    expect(() => readSyncState(root)).toThrow(/removed native graph state/);
  });
  it('prefers validated registered state over repository-local legacy state', async () => {
    const root = makeRoot();
    const home = homeFor(root);
    const globalState = state(root);
    await writeSyncState(root, globalState);
    const legacyPath = legacySyncStatePath(root);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({ ...globalState, inputsHash: 'legacy' }));

    const located = readLocatedSyncState(root, home);

    expect(located?.layout).toBe('global');
    expect(located?.state.inputsHash).toBe(globalState.inputsHash);
  });

  it('fails closed when registered state changes instead of falling back to legacy state', async () => {
    const root = makeRoot();
    const home = homeFor(root);
    const registeredPath = syncStatePath(root);
    await writeSyncState(root, state(root));
    const legacyPath = legacySyncStatePath(root);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify(state(root, { inputsHash: 'legacy' })));
    fs.writeFileSync(registeredPath, '{ malformed');

    expect(() => readLocatedSyncState(root, home)).toThrow(/mismatched state hash/);
  });

  it('ignores legacy state without writing or migrating it', () => {
    const root = makeRoot();
    const home = homeFor(root);
    const legacyPath = legacySyncStatePath(root);
    const legacy = { ...state(root, { version: 8 }), identity: undefined };
    const serialized = JSON.stringify(legacy, (_key, value) => (value === undefined ? undefined : value));
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, serialized);

    expect(readLocatedSyncState(root, home)).toBeUndefined();
    expect(fs.existsSync(syncStatePath(root))).toBe(false);
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(serialized);
  });
});

describe('web sources hash', () => {
  it('does not resolve package-name metadata relative to the process directory', () => {
    const first = makeRoot();
    const second = makeRoot();
    fs.writeFileSync(path.join(first, 'package.json'), '{"name":"first","version":"1.0.0"}');
    fs.writeFileSync(path.join(second, 'package.json'), '{"name":"second","version":"2.0.0"}');
    const resolved = { [localPackageNameKey('./plugin', '/repo')]: '@scope/plugin' };
    const originalDirectory = process.cwd();
    let firstHash: string;
    let secondHash: string;
    try {
      process.chdir(first);
      firstHash = computeWebSourcesHash(resolved);
      process.chdir(second);
      secondHash = computeWebSourcesHash(resolved);
    } finally {
      process.chdir(originalDirectory);
    }

    expect(secondHash).toBe(firstHash);
  });
});

describe('inputs hash', () => {
  it('changes when a .doom file changes', () => {
    const root = makeRoot();
    const before = computeInputsHash(root, SELECTION);

    fs.writeFileSync(path.join(root, '.doom', 'domains.yaml'), 'domains:\n  development:\n    plugins: []\n');

    expect(computeInputsHash(root, SELECTION)).not.toBe(before);
  });

  it('distinguishes an absent, empty, changed, and removed repository MCP config', () => {
    const root = makeRoot();
    const configPath = path.join(root, '.mcp.json');
    const absent = computeInputsHash(root, SELECTION);

    fs.writeFileSync(configPath, '');
    const empty = computeInputsHash(root, SELECTION);
    expect(empty).not.toBe(absent);

    fs.writeFileSync(configPath, '{"mcpServers":{"repo":{}}}');
    expect(computeInputsHash(root, SELECTION)).not.toBe(empty);

    fs.rmSync(configPath);
    expect(computeInputsHash(root, SELECTION)).toBe(absent);
  });

  it('hashes both MCP config formats only for selected MCP-enabled plugins', () => {
    const root = makeRoot();
    const home = homeFor(root);
    const pluginRoot = path.join(root, 'plugins');
    const selected = path.join(pluginRoot, 'selected');
    const excluded = path.join(pluginRoot, 'excluded');
    const unselected = path.join(pluginRoot, 'unselected');
    for (const [name, directory] of [
      ['selected', selected],
      ['excluded', excluded],
      ['unselected', unselected],
    ]) {
      const manifest = path.join(directory, '.codex-plugin', 'plugin.json');
      fs.mkdirSync(path.dirname(manifest), { recursive: true });
      fs.writeFileSync(manifest, JSON.stringify({ name }));
    }
    fs.writeFileSync(
      path.join(root, '.doom', 'domains.yaml'),
      `plugins:
  roots: [plugins]
domains:
  development:
    plugins:
      - selected
      - name: excluded
        mcp: false
  other:
    plugins: [unselected]
`,
    );
    const baseline = computeInputsHash(root, SELECTION, home);

    fs.writeFileSync(path.join(selected, '.mcp.json'), '{}');
    const legacy = computeInputsHash(root, SELECTION, home);
    expect(legacy).not.toBe(baseline);

    fs.writeFileSync(path.join(selected, 'mcp.json'), '{"mcpServers":{}}');
    const portable = computeInputsHash(root, SELECTION, home);
    expect(portable).not.toBe(legacy);

    fs.rmSync(path.join(selected, '.mcp.json'));
    expect(computeInputsHash(root, SELECTION, home)).not.toBe(portable);

    const selectedOnly = computeInputsHash(root, SELECTION, home);
    fs.writeFileSync(path.join(excluded, '.mcp.json'), '{"mcpServers":{"excluded":{}}}');
    fs.writeFileSync(path.join(unselected, 'mcp.json'), '{"mcpServers":{"unselected":{}}}');
    expect(computeInputsHash(root, SELECTION, home)).toBe(selectedOnly);
  });

  it('changes when discovered marketplace or plugin manifests change', () => {
    const root = makeRoot();
    const home = path.join(root, 'home');
    const marketplacePath = path.join(root, '.agents', 'plugins', 'marketplace.json');
    const pluginManifest = path.join(root, 'plugins', 'local', '.codex-plugin', 'plugin.json');
    fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
    fs.mkdirSync(path.dirname(pluginManifest), { recursive: true });
    fs.writeFileSync(
      marketplacePath,
      JSON.stringify({ name: 'repo', plugins: [{ name: 'remote', source: { source: 'npm', package: 'remote' } }] }),
    );
    fs.writeFileSync(pluginManifest, '{"name":"local","description":"before"}');
    fs.writeFileSync(path.join(root, '.doom', 'domains.yaml'), 'plugins:\n  roots: [plugins]\ndomains: {}\n');
    const before = computeInputsHash(root, SELECTION, home);

    fs.writeFileSync(pluginManifest, '{"name":"local","description":"after"}');
    expect(computeInputsHash(root, SELECTION, home)).not.toBe(before);
    const afterPlugin = computeInputsHash(root, SELECTION, home);

    fs.writeFileSync(
      marketplacePath,
      JSON.stringify({
        name: 'repo',
        plugins: [{ name: 'remote', source: { source: 'npm', package: 'remote' }, description: 'changed' }],
      }),
    );
    expect(computeInputsHash(root, SELECTION, home)).not.toBe(afterPlugin);
  });

  it('changes when discovered profiles or their persona files change', () => {
    const root = makeRoot();
    const home = path.join(root, 'home');
    const profilesRoot = path.join(root, 'personas');
    const editor = path.join(profilesRoot, 'editor');
    fs.mkdirSync(editor, { recursive: true });
    fs.writeFileSync(path.join(editor, 'profile.md'), 'Before.');
    fs.writeFileSync(path.join(root, '.doom', 'profiles.yaml'), 'profiles:\n  roots: [personas]\n  entries: {}\n');
    const before = computeInputsHash(root, SELECTION, home);

    fs.writeFileSync(path.join(editor, 'profile.md'), 'After.');
    expect(computeInputsHash(root, SELECTION, home)).not.toBe(before);
    const afterPersona = computeInputsHash(root, SELECTION, home);

    const reviewer = path.join(profilesRoot, 'reviewer');
    fs.mkdirSync(reviewer);
    fs.writeFileSync(path.join(reviewer, 'SOUL.md'), 'Review carefully.');
    expect(computeInputsHash(root, SELECTION, home)).not.toBe(afterPersona);
  });

  it('changes when the selection changes', () => {
    const root = makeRoot();

    expect(computeInputsHash(root, { ...SELECTION, majorMode: 'minimal' })).not.toBe(
      computeInputsHash(root, SELECTION),
    );
  });

  it('ignores the order domains were listed in', () => {
    const root = makeRoot();

    expect(computeInputsHash(root, { ...SELECTION, domains: ['b', 'a'] })).toBe(
      computeInputsHash(root, { ...SELECTION, domains: ['a', 'b'] }),
    );
  });
});

describe('resolution map', () => {
  const base = {
    ownEntry: (name: string) => `/own/${name}.ts`,
    packageEntry: (name: string) => `/pkg/${name}`,
    optionalPackageEntry: (name: string) => (name.includes('missing') ? undefined : `/opt/${name}`),
    localEntry: (specifier: string, baseDirectory: string) => `/local/${baseDirectory}/${specifier}`,
    localPackageName: () => '@scope/local',
  };

  it('records what it resolves and omits optional misses', () => {
    const recording = createRecordingResolvers(base);

    recording.ownEntry('domains');
    recording.packageEntry('@scope/present');
    recording.optionalPackageEntry('@scope/missing');

    expect(recording.resolved).toEqual({
      [ownKey('domains')]: '/own/domains.ts',
      [packageKey('@scope/present')]: '/pkg/@scope/present',
    });
  });

  it('records and replays every package manifest entry under stable indexed keys', () => {
    const packageName = '@scope/multi';
    const localSpecifier = './multi';
    const packageEntries = ['/pkg/multi/first.mjs', '/pkg/multi/second.mjs'];
    const localEntries = ['/local/multi/first.mjs', '/local/multi/second.mjs'];
    const recording = createRecordingResolvers({
      ...base,
      packageEntries: () => packageEntries,
      optionalPackageEntries: () => packageEntries,
      localEntries: () => localEntries,
    });

    expect(recording.packageEntries(packageName)).toEqual(packageEntries);
    expect(recording.localEntries(localSpecifier, '/repo')).toEqual(localEntries);
    expect(recording.resolved).toMatchObject({
      [packageEntryKey(packageName, 0)]: packageEntries[0],
      [packageEntryKey(packageName, 1)]: packageEntries[1],
      [localEntryKey(localSpecifier, '/repo', 0)]: localEntries[0],
      [localEntryKey(localSpecifier, '/repo', 1)]: localEntries[1],
    });

    const replay = createMapResolvers(recording.resolved);
    expect(replay.packageEntries?.(packageName)).toEqual(packageEntries);
    expect(replay.localEntries?.(localSpecifier, '/repo')).toEqual(localEntries);
  });

  it('records and replays a path-style extension selected through a layer', () => {
    const specifier = './extensions/custom.ts';
    const baseDirectory = '/repo';
    const expected = base.localEntry(specifier, baseDirectory);
    const resolved = recordResolvedEntries(
      {
        layers: { guardrails: { baseDirectory, extensions: [specifier] } },
        defaultMajorMode: 'copilot',
        majorMode: {},
      },
      base,
    );

    expect(resolved[localKey(specifier, baseDirectory)]).toBe(expected);
    expect(resolved[ownKey(specifier)]).toBeUndefined();
    expect(createMapResolvers(resolved).localEntries?.(specifier, baseDirectory)).toEqual([expected]);
  });

  it('records and replays the manifest identity of a local package', () => {
    const recording = createRecordingResolvers(base);

    expect(recording.localEntry('./extension', '/repo')).toBe('/local//repo/./extension');
    expect(recording.localPackageName?.('./extension', '/repo')).toBe('@scope/local');
    expect(recording.resolved).toEqual({
      [localKey('./extension', '/repo')]: '/local//repo/./extension',
      [localPackageNameKey('./extension', '/repo')]: '@scope/local',
    });

    const replay = createMapResolvers(recording.resolved);
    expect(replay.localEntry('./extension', '/repo')).toBe('/local//repo/./extension');
    expect(replay.localPackageName?.('./extension', '/repo')).toBe('@scope/local');
  });

  it('covers the default bundle and every layer, not just the selected major mode', () => {
    const majorModesConfig = loadMajorModesConfig(REPO_ROOT);

    const resolved = recordResolvedEntries(majorModesConfig, base);

    for (const entry of majorModesConfig.default?.packages ?? []) {
      const packageName = typeof entry === 'string' ? entry : entry.name;
      expect(resolved[packageKey(packageName)], `default package ${packageName}`).toBe(`/pkg/${packageName}`);
    }
    for (const [name, layer] of Object.entries(majorModesConfig.layers)) {
      for (const entry of layer.extensions ?? []) {
        expect(resolved[ownKey(entry)], `${name} extension ${entry}`).toBeDefined();
      }
    }
    expect(resolved[packageKey('@agimon-ai/doompi-team')]).toBe('/pkg/@agimon-ai/doompi-team');
    expect(resolved[packageKey('@agimon-ai/doompi-task')]).toBe('/pkg/@agimon-ai/doompi-task');
    expect(resolved[packageKey('@agimon-ai/doompi-team/extensions/doom')]).toBeUndefined();
    expect(resolved[packageKey('@agimon-ai/doompi-team/extensions/pi')]).toBeUndefined();
  });

  it('reads a synced map back and names what a stale map is missing', () => {
    const resolvers = createMapResolvers({ [ownKey('domains')]: '/own/domains.ts' });

    expect(resolvers.ownEntry('domains')).toBe('/own/domains.ts');
    expect(resolvers.optionalPackageEntry('@scope/absent')).toBeUndefined();
    expect(() => resolvers.packageEntry('@scope/absent')).toThrow(
      '@scope/absent is missing from the doompi sync state',
    );
  });
});

describe('paths', () => {
  it('keeps each process out of the synced baseline', () => {
    const root = makeRoot();

    expect(runDirectory(root, 4242)).toBe(path.join(resolveSyncLocation(root, homeFor(root)).directory, 'run', '4242'));
  });

  it('writes settings paths relative to .pi, which is what Pi resolves them against', () => {
    const root = makeRoot();

    expect(settingsRelativePath(root, path.join(root, 'packages', 'core', 'doompi', 'src', 'entries', 'doom.ts'))).toBe(
      '../packages/core/doompi/src/entries/doom.ts',
    );
  });

  it('keeps a path outside the repository absolute rather than climbing out with ..', () => {
    const root = makeRoot();
    const installed = path.join(path.dirname(root), 'global', 'doompi', 'entries', 'doom.mjs');

    expect(settingsRelativePath(root, installed)).toBe(installed);
  });

  it('reports no MCP servers for a config that was never generated', () => {
    expect(readMcpServerNames(path.join(makeRoot(), 'missing.json'))).toEqual([]);
  });
});
