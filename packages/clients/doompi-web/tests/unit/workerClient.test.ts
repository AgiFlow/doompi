import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  active: vi.fn(() => true),
  fetch: vi.fn(),
}));

vi.mock('@agimon-ai/doompi-web-security/browser', () => ({
  sealedTransport: { active: mocks.active, fetch: mocks.fetch },
}));

import { activateVerifiedPluginComposition } from '../../src/pwa/workerClient';

const composition = {
  id: 'a'.repeat(64),
  revision: 1,
  manifestUrl: `/api/web-plugins/${'a'.repeat(64)}/1/manifest`,
  rawAssetBaseUrl: `/api/web-plugins/${'a'.repeat(64)}/1/assets`,
  verifiedAssetBaseUrl: `/verified-plugins/${'a'.repeat(64)}/1`,
  entryPath: '/entry.js',
  stylePaths: [],
  channels: [],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.fetch.mockReset();
});

describe('the trusted worker client', () => {
  it('relays plugin downloads through the shared sealed HTTP transport', async () => {
    mocks.fetch.mockResolvedValue(
      new Response('{"signed":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const worker = {
      postMessage: vi.fn((message: unknown, ports: MessagePort[]) => {
        expect(message).toMatchObject({ relayThroughClient: true });
        const port = ports[0];
        port.addEventListener('message', (event: MessageEvent<unknown>) => {
          const result = event.data as { type?: string; requestId?: number; status?: number };
          if (result.type === 'doompi:plugin-fetch-result') {
            expect(result.status).toBe(200);
            port.postMessage({ ok: true, revision: 1 });
          }
        });
        port.start();
        port.postMessage({ type: 'doompi:plugin-fetch', requestId: 7, path: composition.manifestUrl });
      }),
    };
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ active: worker }) } });

    await expect(activateVerifiedPluginComposition(composition)).resolves.toEqual({ ok: true, revision: 1 });
    expect(mocks.fetch).toHaveBeenCalledWith(composition.manifestUrl, {
      cache: 'no-store',
      credentials: 'include',
    });
  });

  it('does not relay worker requests outside the plugin publication API', async () => {
    const worker = {
      postMessage: vi.fn((_: unknown, ports: MessagePort[]) => {
        const port = ports[0];
        port.addEventListener('message', (event: MessageEvent<unknown>) => {
          const result = event.data as { type?: string; ok?: boolean };
          if (result.type === 'doompi:plugin-fetch-result' && result.ok === false) {
            port.postMessage({ ok: false, code: 'manifest-fetch', message: 'refused' });
          }
        });
        port.start();
        port.postMessage({ type: 'doompi:plugin-fetch', requestId: 8, path: '/api/sessions' });
      }),
    };
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ active: worker }) } });

    await expect(activateVerifiedPluginComposition(composition)).resolves.toEqual({
      ok: false,
      code: 'manifest-fetch',
      message: 'refused',
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('keeps loopback plugin downloads inside the service worker', async () => {
    mocks.active.mockReturnValueOnce(false);
    const worker = {
      postMessage: vi.fn((message: unknown, ports: MessagePort[]) => {
        expect(message).toMatchObject({ relayThroughClient: false });
        const port = ports[0];
        port.start();
        port.postMessage({ ok: true, revision: 1 });
      }),
    };
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ active: worker }) } });

    await expect(activateVerifiedPluginComposition(composition)).resolves.toEqual({ ok: true, revision: 1 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
