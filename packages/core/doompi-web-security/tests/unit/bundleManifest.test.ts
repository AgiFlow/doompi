import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBundleSigner } from '../../src/adapters/bundleSigner.ts';
import {
  BUNDLE_MANIFEST_VERSION,
  type BundleManifest,
  canonicalManifest,
  digestFor,
  isBundleManifest,
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
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

/** WebCrypto wants a view over a plain ArrayBuffer, the same as the browser helper does. */
function fromBase64Url(value: string): ArrayBuffer {
  const bytes = Buffer.from(value, 'base64url');
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy.buffer;
}

/** Verifies exactly the way the browser does, so a mismatch shows up here first. */
async function verifyLikeBrowser(signed: {
  manifest: BundleManifest;
  signature: string;
  publicKey: string;
}): Promise<boolean> {
  const key = await webcrypto.subtle.importKey(
    'spki',
    fromBase64Url(signed.publicKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return await webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    fromBase64Url(signed.signature),
    new TextEncoder().encode(canonicalManifest(signed.manifest)).buffer as ArrayBuffer,
  );
}

describe('canonicalManifest', () => {
  it('is stable no matter what order the assets arrive in', () => {
    // A signature is only worth something if both sides agree byte for byte,
    // and object key or array order is an implementation detail.
    const a: BundleManifest = {
      version: 1,
      builtAt: 5,
      assets: [
        { path: '/b.js', sha256: 'b'.repeat(64) },
        { path: '/a.js', sha256: 'a'.repeat(64) },
      ],
    };
    const b: BundleManifest = { version: 1, builtAt: 5, assets: [...a.assets].reverse() };
    expect(canonicalManifest(a)).toBe(canonicalManifest(b));
  });

  it('changes when any asset digest changes', () => {
    const base: BundleManifest = { version: 1, builtAt: 5, assets: [{ path: '/a.js', sha256: 'a'.repeat(64) }] };
    const tampered: BundleManifest = { ...base, assets: [{ path: '/a.js', sha256: 'c'.repeat(64) }] };
    expect(canonicalManifest(base)).not.toBe(canonicalManifest(tampered));
  });
});

describe('isBundleManifest', () => {
  it('rejects a version it does not understand', () => {
    expect(isBundleManifest({ version: 99, builtAt: 1, assets: [] })).toBe(false);
  });

  it('rejects a digest that is not a sha256 hex string', () => {
    expect(
      isBundleManifest({ version: BUNDLE_MANIFEST_VERSION, builtAt: 1, assets: [{ path: '/a', sha256: 'no' }] }),
    ).toBe(false);
  });

  it('accepts what the signer produces', () => {
    const signed = createBundleSigner(stateDir).sign(assetsDir);
    expect(isBundleManifest(signed?.manifest)).toBe(true);
  });
});

describe('the bundle signer', () => {
  it('produces a signature the browser verifier accepts', async () => {
    // The whole point: node signs and WebCrypto verifies, so this test is the
    // one that proves the two halves agree.
    const signed = createBundleSigner(stateDir).sign(assetsDir);
    if (signed === undefined) throw new Error('nothing signed');
    await expect(verifyLikeBrowser(signed)).resolves.toBe(true);
  });

  it('covers every servable file and skips source maps', () => {
    const signed = createBundleSigner(stateDir).sign(assetsDir);
    const paths = signed?.manifest.assets.map((asset) => asset.path).sort();
    expect(paths).toEqual(['/assets/app.js', '/index.html']);
  });

  it('fails verification when an asset digest is altered', async () => {
    const signed = createBundleSigner(stateDir).sign(assetsDir);
    if (signed === undefined) throw new Error('nothing signed');
    const tampered = {
      ...signed,
      manifest: {
        ...signed.manifest,
        assets: signed.manifest.assets.map((asset) => ({ ...asset, sha256: 'f'.repeat(64) })),
      },
    };
    await expect(verifyLikeBrowser(tampered)).resolves.toBe(false);
  });

  it('fails verification against a different hub key', async () => {
    const signed = createBundleSigner(stateDir).sign(assetsDir);
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-sign-other-'));
    const other = createBundleSigner(otherDir).sign(assetsDir);
    fs.rmSync(otherDir, { recursive: true, force: true });
    if (signed === undefined || other === undefined) throw new Error('nothing signed');
    expect(other.publicKey).not.toBe(signed.publicKey);
    await expect(verifyLikeBrowser({ ...signed, publicKey: other.publicKey })).resolves.toBe(false);
  });

  it('keeps one key across restarts, so a paired device is not orphaned', () => {
    const first = createBundleSigner(stateDir).publicKey();
    expect(createBundleSigner(stateDir).publicKey()).toBe(first);
    expect(fs.statSync(path.join(stateDir, 'signing.json')).mode & 0o077).toBe(0);
  });

  it('reports nothing to sign rather than an empty manifest', () => {
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
