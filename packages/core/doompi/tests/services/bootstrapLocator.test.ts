import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readBootstrapPointer,
  readBootstrapStatus,
  readBundleStatus,
  readStartupBootstrapStatus,
} from '../../src/adapters/bootstrapLocator.ts';
import {
  publishSyncRegistration,
  SYNC_REGISTRATION_VERSION,
  syncStateSha256,
} from '../../src/adapters/syncRegistration.ts';
import { resolveSyncLocation, syncGenerationDirectory } from '../../src/adapters/syncLocation.ts';
import {
  BUNDLED_PRECOMPILE_STRATEGY,
  PRECOMPILE_STATE_VERSION,
  SYNC_STATE_VERSION,
} from '../../src/adapters/syncStateContract.ts';
import { testMcpProjection } from '../helpers/mcpProjection.ts';

/** Digest a compiler manifest must now record so freshness is judged by content. */
function sha256Of(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * The sync-state contract, read from the side that has to survive a bad file.
 *
 * `packageBootstrap` turns every rejection here into a "run doompi sync" warning
 * rather than an extension load failure, so each message is user-facing and each
 * malformed shape has to be rejected rather than half-accepted.
 */

const roots: string[] = [];
const TEST_COMPOSITION_FINGERPRINT = 'a'.repeat(64);
const INACTIVE_COMPOSITION_FINGERPRINT = 'b'.repeat(64);

function temporaryRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-locator-')));
  roots.push(root);
  return root;
}

function homeFor(root: string): string {
  return path.join(root, 'home');
}

function validState(root: string): Record<string, unknown> {
  const location = resolveSyncLocation(root, homeFor(root));
  return {
    version: SYNC_STATE_VERSION,
    root,
    identity: location.identity,
    inputsHash: 'hash',
    compositionFingerprint: TEST_COMPOSITION_FINGERPRINT,
    selection: { majorMode: 'copilot', domains: ['default'], preset: 'default' },
    env: {},
    fileState: { profileEnvironment: {}, pluginHooks: [], mcpProjection: testMcpProjection(root) },
    resolved: {},
    baseline: { themePath: '/tmp/theme.json' },
  };
}

function generationDirectory(root: string): string {
  return syncGenerationDirectory(resolveSyncLocation(root, homeFor(root)), 'test-generation');
}

function writeState(root: string, state: unknown): void {
  const location = resolveSyncLocation(root, homeFor(root));
  const generationRoot = generationDirectory(root);
  const statePath = path.join(generationRoot, 'state.json');
  const apiDirectory = path.join(generationRoot, 'api');
  const packageRoot = path.join(root, 'doompi-package');
  const entry = path.join(packageRoot, 'dist', 'extensions', 'pi.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.mkdirSync(apiDirectory, { recursive: true });
  fs.writeFileSync(entry, 'export default () => undefined;\n');
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@agimon-ai/doompi', version: 'test', pi: { extensions: ['./dist/extensions/pi.mjs'] } }),
  );
  fs.writeFileSync(statePath, JSON.stringify(state));
  publishSyncRegistration(
    root,
    {
      version: SYNC_REGISTRATION_VERSION,
      root: location.root,
      identity: location.identity,
      generation: 'test-generation',
      generationRoot,
      statePath,
      stateSha256: syncStateSha256(statePath),
      webDirectory: null,
      apiDirectory,
      package: { root: packageRoot, version: 'test', manifestPath: path.join(packageRoot, 'package.json'), entry },
    },
    homeFor(root),
  );
}

/** A root whose state carries the given override, ready to read back. */
function stateWith(overrides: Record<string, unknown>): string {
  const root = temporaryRoot();
  writeState(root, { ...validState(root), ...overrides });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('readBootstrapState contract', () => {
  it('reports nothing for a repository that has never been synced', () => {
    expect(readBootstrapPointer(temporaryRoot())).toBeUndefined();
    expect(readBootstrapStatus(temporaryRoot())).toEqual({ bootstrap: undefined, fresh: false });
  });

  it('rejects a state document that is not an object', () => {
    const root = temporaryRoot();
    writeState(root, ['not', 'an', 'object']);

    expect(() => readBootstrapPointer(root, homeFor(root))).toThrow('must be an object');
  });

  it('rejects a state that belongs to another repository', () => {
    const root = stateWith({ root: path.join(os.tmpdir(), 'some-other-repository') });

    expect(() => readBootstrapPointer(root, homeFor(root))).toThrow('belongs to a different repository');
  });

  it.each([
    { field: 'root and inputsHash', overrides: { inputsHash: 7 }, message: 'requires string root and inputsHash' },
    { field: 'selection', overrides: { selection: { domains: [] } }, message: 'requires a selection with a majorMode' },
    { field: 'baseline', overrides: { baseline: {} }, message: 'requires a baseline with a themePath' },
    { field: 'env', overrides: { env: [] }, message: 'requires env to be an object' },
    { field: 'resolved', overrides: { resolved: 'none' }, message: 'requires resolved to be an object' },
    { field: 'compiled', overrides: { compiled: 'none' }, message: 'requires compiled to be an object' },
    { field: 'bundles', overrides: { bundles: [] }, message: 'requires bundles to be an object' },
  ])('rejects a malformed $field', ({ overrides, message }) => {
    const root = stateWith(overrides);
    expect(() => readBootstrapPointer(root, homeFor(root))).toThrow(message);
  });

  it('rejects a precompile record that does not describe a build', () => {
    const root = stateWith({ precompile: { version: PRECOMPILE_STATE_VERSION, strategy: 'handmade', manifests: [] } });

    expect(() => readBootstrapPointer(root, homeFor(root))).toThrow('invalid precompile record');
  });

  it('confines the generated bootstrap to the directory sync owns', () => {
    const root = stateWith({ bootstrap: path.join(os.tmpdir(), 'escaped-bootstrap.mjs') });

    expect(() => readBootstrapPointer(root, homeFor(root))).toThrow('references generated material outside');
  });
});

describe('readBootstrapStatus freshness', () => {
  const entry = path.resolve(import.meta.dirname, '../../src/extensions/entries/doom.ts');

  function compilerManifest(output: string, entries: string[]): Record<string, unknown> {
    return {
      output,
      artifacts: [],
      entries,
      inputs: entries.map((input) => {
        const stat = fs.statSync(input);
        return { path: input, size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha256Of(input) };
      }),
    };
  }

  function bundledState(
    root: string,
    overrides: Record<string, unknown> = {},
  ): { bootstrap: string; bundle: string; bootstrapManifest: string; bundleManifest: string } {
    const generatedDirectory = generationDirectory(root);
    const bootstrap = path.join(generatedDirectory, 'dist', 'bootstrap.mjs');
    const bundle = path.join(generatedDirectory, 'dist', 'copilot.mjs');
    const bootstrapManifest = path.join(generatedDirectory, 'cache', 'bootstrap.json');
    const bundleManifest = path.join(generatedDirectory, 'cache', 'copilot.json');
    for (const filePath of [bootstrap, bundle, bootstrapManifest, bundleManifest]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    fs.writeFileSync(bootstrap, 'export default () => undefined;\n');
    fs.writeFileSync(bundle, 'export default () => undefined;\n');
    fs.writeFileSync(bootstrapManifest, JSON.stringify(compilerManifest(bootstrap, [entry])));
    fs.writeFileSync(bundleManifest, JSON.stringify(compilerManifest(bundle, [entry])));
    writeState(root, {
      ...validState(root),
      bootstrap,
      bundles: { [TEST_COMPOSITION_FINGERPRINT]: bundle },
      precompile: {
        version: PRECOMPILE_STATE_VERSION,
        strategy: BUNDLED_PRECOMPILE_STRATEGY,
        bootstrapEntry: entry,
        bootstrapManifest,
        bundleManifests: { [TEST_COMPOSITION_FINGERPRINT]: bundleManifest },
        ...overrides,
      },
    });
    return { bootstrap, bundle, bootstrapManifest, bundleManifest };
  }

  it('accepts a fresh bundle-only bootstrap and mode composition', () => {
    const root = temporaryRoot();
    const { bootstrap } = bundledState(root);

    expect(readBootstrapStatus(root, entry, homeFor(root))).toEqual({ bootstrap, fresh: true });
  });

  it('rejects output built for a different package entry or precompile contract', () => {
    const root = temporaryRoot();
    const { bootstrap } = bundledState(root);
    const otherInstall = path.join(os.tmpdir(), 'other-doompi', 'dist', 'extensions', 'entries', 'doom.mjs');

    expect(readBootstrapStatus(root, otherInstall, homeFor(root))).toEqual({ bootstrap, fresh: false });

    bundledState(root, { version: PRECOMPILE_STATE_VERSION - 1 });
    expect(() => readBootstrapStatus(root, entry, homeFor(root))).toThrow('invalid precompile record');
  });

  it('rejects missing or composition-mismatched bundle manifests', () => {
    const root = temporaryRoot();
    bundledState(root, { bundleManifests: {} });
    expect(() => readBootstrapStatus(root, entry, homeFor(root))).toThrow('invalid precompile record');

    bundledState(root, { bootstrapManifest: '/missing/bootstrap.json' });
    expect(readBootstrapStatus(root, entry, homeFor(root)).fresh).toBe(false);

    bundledState(root, {
      bundleManifests: { [TEST_COMPOSITION_FINGERPRINT]: '/missing/copilot.json' },
    });
    expect(readBootstrapStatus(root, entry, homeFor(root)).fresh).toBe(false);
  });

  it('validates only the selected bundle at launch while the full check catches inactive corruption', () => {
    const root = temporaryRoot();
    const { bootstrap, bundle, bootstrapManifest, bundleManifest } = bundledState(root);
    const generatedDirectory = generationDirectory(root);
    const inactiveBundle = path.join(generatedDirectory, 'dist', 'minimal.mjs');
    const inactiveManifest = path.join(generatedDirectory, 'cache', 'minimal.json');
    const inactiveInput = path.join(root, 'minimal-entry.mjs');
    fs.writeFileSync(inactiveInput, 'export default () => undefined;\n');
    fs.writeFileSync(inactiveBundle, 'export default () => undefined;\n');
    fs.writeFileSync(inactiveManifest, JSON.stringify(compilerManifest(inactiveBundle, [inactiveInput])));
    writeState(root, {
      ...validState(root),
      bootstrap,
      bundles: {
        [TEST_COMPOSITION_FINGERPRINT]: bundle,
        [INACTIVE_COMPOSITION_FINGERPRINT]: inactiveBundle,
      },
      precompile: {
        version: PRECOMPILE_STATE_VERSION,
        strategy: BUNDLED_PRECOMPILE_STRATEGY,
        bootstrapEntry: entry,
        bootstrapManifest,
        bundleManifests: {
          [TEST_COMPOSITION_FINGERPRINT]: bundleManifest,
          [INACTIVE_COMPOSITION_FINGERPRINT]: inactiveManifest,
        },
      },
    });
    fs.appendFileSync(inactiveInput, '// stale\n');

    expect(readStartupBootstrapStatus(root, entry, homeFor(root))).toEqual({ bootstrap, fresh: true });
    expect(readBundleStatus(root, TEST_COMPOSITION_FINGERPRINT, homeFor(root))).toEqual({ bundle, fresh: true });
    expect(readBundleStatus(root, INACTIVE_COMPOSITION_FINGERPRINT, homeFor(root))).toEqual({
      bundle: inactiveBundle,
      fresh: false,
    });
    expect(readBootstrapStatus(root, entry, homeFor(root))).toEqual({ bootstrap, fresh: false });
  });
});
