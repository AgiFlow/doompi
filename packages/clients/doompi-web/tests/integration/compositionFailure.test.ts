import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ensureSynced: vi.fn(), resolveWebComposition: vi.fn() }));

vi.mock('../../src/adapters/webComposition.ts', () => ({
  resolveWebComposition: mocks.resolveWebComposition,
}));

vi.mock('../../src/adapters/syncGuard.ts', () => ({
  createSyncGuard: () => ({
    ensureSynced: mocks.ensureSynced,
    watch: () => undefined,
    close: () => undefined,
  }),
}));

import { serveWeb } from '../../src/adapters/httpServer.ts';
import type { WebServer } from '../../src/types/bridge.ts';

let server: WebServer | undefined;
let registryDir: string;
let assetsDir: string;
let notices: string[];

beforeEach(() => {
  notices = [];
  mocks.ensureSynced.mockResolvedValue(undefined);
  registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-compfail-'));
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-compfail-assets-'));
  fs.writeFileSync(path.join(assetsDir, 'index.html'), '<!doctype html><title>packaged</title>');
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  mocks.ensureSynced.mockReset();
  mocks.resolveWebComposition.mockReset();
  fs.rmSync(registryDir, { recursive: true, force: true });
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

const start = async (): Promise<WebServer> =>
  await serveWeb({
    registryDir,
    spawnCommand: path.join(registryDir, 'no-such-server'),
    port: 0,
    assetsDir,
    remoteStateDir: path.join(registryDir, 'state'),
    onNotice: (message) => notices.push(message),
  });

describe('the stable cockpit shell', () => {
  it('still binds the hub and answers its health probe', async () => {
    mocks.resolveWebComposition.mockRejectedValue(new Error('vite build failed'));

    server = await start();

    expect(server.url).toMatch(/^http:\/\//u);
    // The probe a second start uses to decide a hub is alive; if the throw had
    // escaped, serveWeb would have rejected and there would be nothing to ask.
    const response = await fetch(`${server.url}/api/health`);
    expect(response.status).toBe(200);
  });

  it('keeps serving when the initial Doom sync fails', async () => {
    mocks.ensureSynced.mockRejectedValue(new Error('another sync is publishing'));

    server = await start();

    expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
    expect(notices).toContainEqual(expect.stringContaining('continuing to serve the cockpit'));
  });

  it('does not rebuild a global plugin union before binding', async () => {
    mocks.resolveWebComposition.mockRejectedValue(new Error('vite build failed'));

    server = await start();

    expect(mocks.resolveWebComposition).not.toHaveBeenCalled();
    expect(notices.some((message) => message.includes('vite build failed'))).toBe(false);
  });

  it('serves the packaged shell without a synchronized composition', async () => {
    mocks.resolveWebComposition.mockResolvedValue(undefined);

    server = await start();

    expect((await fetch(`${server.url}/`)).status).toBe(200);
    expect(notices.some((message) => message.includes('serving the packaged bundle'))).toBe(false);
  });
});
