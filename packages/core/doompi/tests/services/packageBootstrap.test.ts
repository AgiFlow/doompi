import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findSyncedRoot, readBootstrapPointer, readBootstrapStatus } from '../../src/adapters/bootstrapLocator.ts';
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

const roots: string[] = [];
const TEST_COMPOSITION_FINGERPRINT = 'a'.repeat(64);

function temporaryRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-bootstrap-')));
  roots.push(root);
  return root;
}

function homeFor(root: string): string {
  return path.join(root, 'home');
}

function generationDirectory(root: string): string {
  return syncGenerationDirectory(resolveSyncLocation(root, homeFor(root)), 'test-generation');
}

function validState(root: string, bootstrap?: string): Record<string, unknown> {
  return {
    version: SYNC_STATE_VERSION,
    root,
    identity: resolveSyncLocation(root, homeFor(root)).identity,
    inputsHash: 'hash',
    compositionFingerprint: TEST_COMPOSITION_FINGERPRINT,
    selection: { majorMode: 'copilot', domains: ['default'], preset: 'default' },
    env: {},
    fileState: { profileEnvironment: {}, pluginHooks: [], mcpProjection: testMcpProjection(root) },
    resolved: {},
    baseline: { themePath: '/tmp/theme.json' },
    bootstrap,
  };
}

function writeStateText(root: string, text: string): void {
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
  fs.writeFileSync(statePath, text);
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

function writeState(root: string, state: unknown): void {
  writeStateText(root, JSON.stringify(state));
}

function writeFreshBuild(root: string): { artifact: string; input: string; manifest: string } {
  const generatedDirectory = generationDirectory(root);
  const artifact = path.join(generatedDirectory, 'dist', 'bootstrap.1234.mjs');
  const input = path.join(root, 'bootstrap-source.mjs');
  const manifest = path.join(generatedDirectory, 'cache', 'sets', 'bootstrap.json');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(artifact, 'export default () => undefined;\n');
  fs.writeFileSync(input, 'source\n');
  const stat = fs.statSync(input);
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      version: 'compiler-v1',
      entries: [input],
      output: artifact,
      artifacts: [artifact],
      inputs: [{ path: input, size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha256Of(input) }],
    }),
  );
  writeState(root, {
    ...validState(root, artifact),
    bundles: {},
    precompile: {
      version: PRECOMPILE_STATE_VERSION,
      strategy: BUNDLED_PRECOMPILE_STRATEGY,
      bootstrapEntry: input,
      bootstrapManifest: manifest,
      bundleManifests: {},
    },
  });
  return { artifact, input, manifest };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('package bootstrap locator', () => {
  it('finds synced state from a nested repository directory', () => {
    const root = temporaryRoot();
    const nested = path.join(root, 'packages', 'app');
    fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    writeState(root, validState(root));

    expect(findSyncedRoot(nested, homeFor(root))).toBe(root);
  });

  it('keeps the nearest unsynced repository from inheriting parent state', () => {
    const parent = temporaryRoot();
    const child = path.join(parent, 'child');
    fs.mkdirSync(path.join(parent, '.doom'), { recursive: true });
    fs.mkdirSync(path.join(child, '.doom'), { recursive: true });
    writeState(parent, validState(parent));

    expect(findSyncedRoot(child, homeFor(parent))).toBeUndefined();
  });

  it('reads a confined bootstrap pointer after validating state', () => {
    const root = temporaryRoot();
    const bootstrap = path.join(generationDirectory(root), 'dist', 'bootstrap.mjs');
    writeState(root, validState(root, bootstrap));

    expect(readBootstrapPointer(root, homeFor(root))).toBe(bootstrap);
  });

  it('accepts fresh compiler fingerprints without loading the compiler', () => {
    const root = temporaryRoot();
    const { artifact, input } = writeFreshBuild(root);

    expect(readBootstrapStatus(root, input, homeFor(root))).toEqual({ bootstrap: artifact, fresh: true });
  });

  it('marks output stale when an input changes or an artifact disappears', () => {
    const root = temporaryRoot();
    const { artifact, input } = writeFreshBuild(root);
    fs.appendFileSync(input, 'edited\n');

    expect(readBootstrapStatus(root, input, homeFor(root))).toEqual({ bootstrap: artifact, fresh: false });

    writeFreshBuild(root);
    fs.rmSync(artifact);
    expect(readBootstrapStatus(root, input, homeFor(root))).toEqual({ bootstrap: artifact, fresh: false });
  });

  it('treats a synchronized state with no build record as a cache miss', () => {
    const root = temporaryRoot();
    writeState(root, validState(root));

    expect(readBootstrapStatus(root, undefined, homeFor(root))).toEqual({ bootstrap: undefined, fresh: false });
  });

  it('rejects malformed, stale, and unconfined state', () => {
    const root = temporaryRoot();
    writeStateText(root, '{');
    expect(() => readBootstrapPointer(root, homeFor(root))).toThrow('is not valid JSON');

    writeState(root, { ...validState(root), version: SYNC_STATE_VERSION - 1 });
    expect(() => readBootstrapPointer(root, homeFor(root))).toThrow(`expected ${SYNC_STATE_VERSION}`);

    writeState(root, validState(root, '/tmp/generated-bootstrap.mjs'));
    expect(() => readBootstrapPointer(root, homeFor(root))).toThrow('references generated material outside');
  });
});
