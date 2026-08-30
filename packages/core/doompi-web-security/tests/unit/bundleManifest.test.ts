import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyBundleAsset, verifySignedBundleManifest } from '../../src/adapters/browserBundleVerifier.ts';
import { createBundleSigner } from '../../src/adapters/bundleSigner.ts';
import {
  BUNDLE_MANIFEST_VERSION,
  type BundleManifest,
  canonicalManifest,
  digestFor,
  isBundleManifest,
  isSignedBundleManifest,
} from '../../src/types/bundleManifest.ts';

let stateDir: string;
let assetsDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-sign-state-'));
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-sign-assets-'));
  fs.writeFileSync(path.join(assetsDir, 'index.html'), '<!doctype html><title>cockpit</title>');
  fs.mkdirSync(path.join(assetsDir, 'assets'));
  fs.writeFileSync(path.join(assetsDir, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(assetsDir, 'assets', 'app.js.map'), '{"version":3}');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

function manifest(assets: BundleManifest['assets']): BundleManifest {
  return { version: BUNDLE_MANIFEST_VERSION, revision: 1, builtAt: 5, assets };
}

function asset(assetPath = '/a.js') {
  return {
    path: assetPath,
    sha256: 'a'.repeat(64),
    byteLength: 1,
    contentType: 'text/javascript',
  };
}

describe('canonicalManifest', () => {
  it('is stable no matter what order the assets arrive in', () => {
    const a = manifest([asset('/b.js'), asset('/a.js')]);
    const b = manifest([...a.assets].reverse());
    expect(canonicalManifest(a)).toBe(canonicalManifest(b));
  });

  it('covers revision, digest, length, and content type', () => {
    const base = manifest([asset()]);
    expect(canonicalManifest({ ...base, revision: 2 })).not.toBe(canonicalManifest(base));
    expect(canonicalManifest(manifest([{ ...asset(), sha256: 'c'.repeat(64) }]))).not.toBe(canonicalManifest(base));
    expect(canonicalManifest(manifest([{ ...asset(), byteLength: 2 }]))).not.toBe(canonicalManifest(base));
    expect(canonicalManifest(manifest([{ ...asset(), contentType: 'application/javascript' }]))).not.toBe(
      canonicalManifest(base),
    );
  });
});

describe('strict manifest validation', () => {
  it('accepts only a complete v2 manifest and signed envelope', () => {
    const signed = createBundleSigner(stateDir).sign(assetsDir);
    expect(isBundleManifest(signed?.manifest)).toBe(true);
    expect(isSignedBundleManifest(signed)).toBe(true);
    expect(isSignedBundleManifest({ ...signed, extra: true })).toBe(false);
  });

  it.each([
    ['wrong version', { ...manifest([asset()]), version: 1 }],
    ['empty inventory', manifest([])],
    ['missing index', manifest([asset('/assets/app.js')])],
    ['non-finite timestamp', { ...manifest([asset()]), builtAt: Number.POSITIVE_INFINITY }],
    ['unsafe relative path', manifest([asset('a.js')])],
    ['unsafe traversal path', manifest([asset('/../a.js')])],
    ['unsafe encoded path separator', manifest([asset('/a\\b.js')])],
    ['duplicate path', manifest([asset(), asset()])],
    ['invalid byte length', manifest([{ ...asset(), byteLength: Number.NaN }])],
    ['invalid content type', manifest([{ ...asset(), contentType: 'text/html\nX: bad' }])],
    ['extra manifest field', { ...manifest([asset()]), extra: true }],
    ['extra asset field', { ...manifest([asset()]), assets: [{ ...asset(), extra: true }] }],
  ])('rejects %s', (_name, value) => {
    expect(isBundleManifest(value)).toBe(false);
  });
});

describe('the bundle signer', () => {
  it('produces a v2 signature WebCrypto accepts', async () => {
    const signed = createBundleSigner(stateDir).sign(assetsDir);
    if (signed === undefined) throw new Error('nothing signed');
    await expect(verifySignedBundleManifest(signed, signed.publicKey)).resolves.toEqual({
      ok: true,
      manifest: signed.manifest,
    });
  });

  it('records every servable file with byte length and content type, and skips source maps', () => {
    const signed = createBundleSigner(stateDir).sign(assetsDir);
    expect(signed?.manifest.assets).toEqual([
      expect.objectContaining({ path: '/assets/app.js', byteLength: 14, contentType: 'text/javascript' }),
      expect.objectContaining({ path: '/index.html', byteLength: 37, contentType: 'text/html' }),
    ]);
  });

  it('refreshes explicitly and persists monotonic revisions across restarts', () => {
    const signer = createBundleSigner(stateDir);
    const first = signer.sign(assetsDir);
    expect(signer.sign(assetsDir)).toBe(first);
    fs.writeFileSync(path.join(assetsDir, 'index.html'), 'changed');
    const second = signer.refresh(assetsDir);
    signer.invalidate(assetsDir);
    const third = createBundleSigner(stateDir).sign(assetsDir);
    expect([first?.manifest.revision, second?.manifest.revision, third?.manifest.revision]).toEqual([1, 2, 3]);
    expect(second?.manifest.assets.find((entry) => entry.path === '/index.html')?.byteLength).toBe(7);
  });

  it('keeps valid legacy keys while migrating state to an owner-only atomic revision record', () => {
    const firstKey = createBundleSigner(stateDir).publicKey();
    const keyPath = path.join(stateDir, 'signing.json');
    const stored = JSON.parse(fs.readFileSync(keyPath, 'utf8')) as Record<string, unknown>;
    delete stored.revision;
    fs.writeFileSync(keyPath, JSON.stringify(stored), { mode: 0o666 });
    expect(createBundleSigner(stateDir).publicKey()).toBe(firstKey);
    expect(JSON.parse(fs.readFileSync(keyPath, 'utf8'))).toMatchObject({ revision: 0, publicKey: firstKey });
    expect(fs.statSync(keyPath).mode & 0o077).toBe(0);
    expect(fs.statSync(stateDir).mode & 0o077).toBe(0);
  });

  it('fails closed rather than silently rotating malformed key state', () => {
    const keyPath = path.join(stateDir, 'signing.json');
    fs.writeFileSync(keyPath, '{"privateKey":"bad","publicKey":"bad","revision":9}');
    expect(() => createBundleSigner(stateDir)).toThrow(/invalid bundle signing private key/u);
    expect(fs.readFileSync(keyPath, 'utf8')).toContain('"revision":9');
  });

  it('fails closed when the asset walk encounters a symbolic link', () => {
    fs.symlinkSync(path.join(assetsDir, 'index.html'), path.join(assetsDir, 'linked.html'));
    expect(() => createBundleSigner(stateDir).sign(assetsDir)).toThrow(/symbolic link/u);
  });

  it('reports nothing to sign rather than signing an empty inventory', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-sign-empty-'));
    expect(createBundleSigner(stateDir).sign(empty)).toBeUndefined();
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('finds a digest by path', () => {
    const signed = createBundleSigner(stateDir).sign(assetsDir);
    if (signed === undefined) throw new Error('nothing signed');
    expect(digestFor(signed.manifest, '/index.html')).toMatch(/^[0-9a-f]{64}$/u);
    expect(digestFor(signed.manifest, '/nope.js')).toBeUndefined();
  });
});

describe('browser verification failures', () => {
  it('types trust, replay, signature, and envelope failures', async () => {
    const signed = createBundleSigner(stateDir).sign(assetsDir);
    if (signed === undefined) throw new Error('nothing signed');
    await expect(verifySignedBundleManifest(signed, 'not-the-key')).resolves.toMatchObject({
      ok: false,
      failure: { code: 'untrusted-public-key' },
    });
    await expect(verifySignedBundleManifest(signed, signed.publicKey, signed.manifest.revision)).resolves.toEqual({
      ok: true,
      manifest: signed.manifest,
    });
    await expect(
      verifySignedBundleManifest(signed, signed.publicKey, signed.manifest.revision + 1),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: 'stale-revision' },
    });
    await expect(
      verifySignedBundleManifest(
        { ...signed, manifest: { ...signed.manifest, builtAt: signed.manifest.builtAt + 1 } },
        signed.publicKey,
      ),
    ).resolves.toMatchObject({ ok: false, failure: { code: 'invalid-signature' } });
    await expect(verifySignedBundleManifest({ ...signed, extra: true }, signed.publicKey)).resolves.toMatchObject({
      ok: false,
      failure: { code: 'invalid-envelope' },
    });
  });

  it('verifies response bytes, length, and digest', async () => {
    const signed = createBundleSigner(stateDir).sign(assetsDir);
    if (signed === undefined) throw new Error('nothing signed');
    const bytes = fs.readFileSync(path.join(assetsDir, 'index.html'));
    const body = Uint8Array.from(bytes).buffer;
    await expect(verifyBundleAsset(signed.manifest, '/index.html', body)).resolves.toEqual({ ok: true });
    const tampered = Uint8Array.from(bytes);
    tampered[0] = 0;
    await expect(verifyBundleAsset(signed.manifest, '/index.html', tampered.buffer)).resolves.toMatchObject({
      ok: false,
      failure: { code: 'digest-mismatch' },
    });
  });
});
