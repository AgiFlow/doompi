import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBundleSigner } from '@agimon-ai/doompi-web-security/node';
import { forgetBundleKey, pinBundleKey, pinnedBundleKey, verifyBundle } from '../../src/web/lib/bundleIntegrity.ts';

const originalFetch = globalThis.fetch;
const store = new Map<string, string>();

Object.defineProperty(globalThis, 'window', {
  value: {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  },
  configurable: true,
});

let stateDir: string;
let assetsDir: string;

/** A real signed manifest, so the browser verifier meets what the hub produces. */
function signed(dir = stateDir) {
  const result = createBundleSigner(dir).sign(assetsDir);
  if (result === undefined) throw new Error('nothing to sign');
  return result;
}

function serves(body: unknown, status = 200): void {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

beforeEach(() => {
  store.clear();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-integrity-state-'));
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-integrity-assets-'));
  fs.writeFileSync(path.join(assetsDir, 'index.html'), '<!doctype html>');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

describe('the pinned key', () => {
  it('round-trips and can be forgotten', () => {
    expect(pinnedBundleKey()).toBeUndefined();
    pinBundleKey('a-key');
    expect(pinnedBundleKey()).toBe('a-key');
    forgetBundleKey();
    expect(pinnedBundleKey()).toBeUndefined();
  });
});

describe('verifyBundle', () => {
  it('accepts a genuine manifest and pins the key it saw', async () => {
    const manifest = signed();
    serves(manifest);
    await expect(verifyBundle()).resolves.toEqual({ state: 'ok' });
    expect(pinnedBundleKey()).toBe(manifest.publicKey);
  });

  it('accepts the same hub again once pinned', async () => {
    const manifest = signed();
    serves(manifest);
    await verifyBundle();
    serves(signed());
    await expect(verifyBundle()).resolves.toEqual({ state: 'ok' });
  });

  it('refuses a bundle signed by a different hub', async () => {
    // The one unambiguous signal that something is between the device and the
    // machine it paired with.
    serves(signed());
    await verifyBundle();
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-integrity-other-'));
    serves(signed(otherDir));
    const verdict = await verifyBundle();
    fs.rmSync(otherDir, { recursive: true, force: true });
    expect(verdict.state).toBe('tampered');
    if (verdict.state !== 'tampered') return;
    expect(verdict.reason).toContain('different key');
  });

  it('refuses a manifest whose contents were altered after signing', async () => {
    const manifest = signed();
    serves({
      ...manifest,
      manifest: {
        ...manifest.manifest,
        assets: manifest.manifest.assets.map((asset) => ({ ...asset, sha256: 'f'.repeat(64) })),
      },
    });
    const verdict = await verifyBundle();
    expect(verdict.state).toBe('tampered');
    if (verdict.state !== 'tampered') return;
    expect(verdict.reason).toContain('does not match');
  });

  it('refuses a manifest that is not the shape this build produces', async () => {
    serves({ manifest: { version: 99 }, signature: 'x', publicKey: 'y' });
    expect((await verifyBundle()).state).toBe('tampered');
  });

  it('reports unavailable rather than ok when the manifest cannot be fetched', async () => {
    // Never mistake "no answer" for "verified".
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect((await verifyBundle()).state).toBe('unavailable');
  });

  it('reports unavailable when the route answers with an error', async () => {
    serves({ error: 'no bundle' }, 404);
    const verdict = await verifyBundle();
    expect(verdict.state).toBe('unavailable');
    if (verdict.state !== 'unavailable') return;
    expect(verdict.reason).toContain('404');
  });

  it('refuses a signature that is not decodable', async () => {
    serves({ ...signed(), signature: '!!!not base64' });
    expect((await verifyBundle()).state).toBe('tampered');
  });
});
