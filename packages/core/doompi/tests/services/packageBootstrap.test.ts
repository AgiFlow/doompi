import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findSyncedRoot, readBootstrapPointer, readBootstrapStatus } from '../../src/adapters/bootstrapLocator.ts';
import { syncStatePath } from '../../src/adapters/syncState.ts';
import { resolveSyncLocation } from '../../src/adapters/syncLocation.ts';
import {
  BUNDLED_PRECOMPILE_STRATEGY,
  PRECOMPILE_STATE_VERSION,
  SYNC_STATE_VERSION,
} from '../../src/adapters/syncStateContract.ts';
import { testMcpProjection } from '../helpers/mcpProjection.ts';

const roots: string[] = [];
const TEST_COMPOSITION_FINGERPRINT = 'a'.repeat(64);

function temporaryRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-bootstrap-')));
  roots.push(root);
  return root;
}

function validState(root: string, bootstrap?: string): Record<string, unknown> {
  return {
    version: SYNC_STATE_VERSION,
    root,
    identity: resolveSyncLocation(root).identity,
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

function writeState(root: string, state: unknown): void {
  const statePath = syncStatePath(root);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state));
}

function writeFreshBuild(root: string): { artifact: string; input: string; manifest: string } {
  const generatedDirectory = resolveSyncLocation(root).directory;
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
      inputs: [{ path: input, size: stat.size, mtimeMs: stat.mtimeMs }],
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

    expect(findSyncedRoot(nested)).toBe(root);
  });

  it('keeps the nearest unsynced repository from inheriting parent state', () => {
    const parent = temporaryRoot();
    const child = path.join(parent, 'child');
    fs.mkdirSync(path.join(parent, '.doom'), { recursive: true });
    fs.mkdirSync(path.join(child, '.doom'), { recursive: true });
    writeState(parent, validState(parent));

    expect(findSyncedRoot(child)).toBeUndefined();
  });

  it('reads a confined bootstrap pointer after validating state', () => {
    const root = temporaryRoot();
    const bootstrap = path.join(resolveSyncLocation(root).directory, 'dist', 'bootstrap.mjs');
    writeState(root, validState(root, bootstrap));

    expect(readBootstrapPointer(root)).toBe(bootstrap);
  });

  it('accepts fresh compiler fingerprints without loading the compiler', () => {
    const root = temporaryRoot();
    const { artifact, input } = writeFreshBuild(root);

    expect(readBootstrapStatus(root, input)).toEqual({ bootstrap: artifact, fresh: true });
  });

  it('marks output stale when an input changes or an artifact disappears', () => {
    const root = temporaryRoot();
    const { artifact, input } = writeFreshBuild(root);
    fs.appendFileSync(input, 'edited\n');

    expect(readBootstrapStatus(root, input)).toEqual({ bootstrap: artifact, fresh: false });

    writeFreshBuild(root);
    fs.rmSync(artifact);
    expect(readBootstrapStatus(root, input)).toEqual({ bootstrap: artifact, fresh: false });
  });

  it('treats a synchronized state with no build record as a cache miss', () => {
    const root = temporaryRoot();
    writeState(root, validState(root));

    expect(readBootstrapStatus(root)).toEqual({ bootstrap: undefined, fresh: false });
  });

  it('rejects malformed, stale, and unconfined state', () => {
    const root = temporaryRoot();
    const statePath = syncStatePath(root);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{');
    expect(() => readBootstrapPointer(root)).toThrow('is not valid JSON');

    writeState(root, { ...validState(root), version: SYNC_STATE_VERSION - 1 });
    expect(() => readBootstrapPointer(root)).toThrow(`expected ${SYNC_STATE_VERSION}`);

    writeState(root, validState(root, '/tmp/generated-bootstrap.mjs'));
    expect(() => readBootstrapPointer(root)).toThrow('references generated material outside');
  });
});
