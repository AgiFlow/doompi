import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const servers: http.Server[] = [];

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('@agimon-ai/doompi-web');
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

function freshRegistryDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-cockpit-')), 'run');
}

/** A loopback server whose /api/health answers are scripted per request. */
async function fakePortOccupant(answers: Array<{ status: number; body?: object }>): Promise<number> {
  const server = http.createServer((_request, response) => {
    const next = answers.length > 1 ? (answers.shift() as { status: number; body?: object }) : answers[0];
    response.writeHead(next.status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(next.body ?? {}));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Could not read the fake hub port.');
  return address.port;
}

const HUB_HEALTH = { ok: true, role: 'hub', protocol: 1, sessions: 0, pid: 1 };

describe('startWebCockpit', () => {
  it('serves the cockpit on loopback and hands back a closable handle', async () => {
    const { startWebCockpit } = await import('../../../src/adapters/webCockpit.ts');
    const cockpit = await startWebCockpit({ registryDir: freshRegistryDir(), port: 0 });

    expect(cockpit.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    await cockpit.close();
  });

  it('passes the registry through to the cockpit and pins it to loopback', async () => {
    const seen: Array<Record<string, unknown>> = [];
    vi.doMock('@agimon-ai/doompi-web', () => ({
      serveWeb: (options: Record<string, unknown>) => {
        seen.push(options);
        return Promise.resolve({ url: 'http://127.0.0.1:1234', close: () => Promise.resolve() });
      },
    }));
    vi.resetModules();

    const { startWebCockpit } = await import('../../../src/adapters/webCockpit.ts');
    await startWebCockpit({ registryDir: '/custom/run', port: 0 });

    expect(seen[0]).toMatchObject({ registryDir: '/custom/run', port: 0, host: '127.0.0.1' });
  });

  it('points at a hub that is already running instead of binding', async () => {
    const serveWeb = vi.fn();
    vi.doMock('@agimon-ai/doompi-web', () => ({ serveWeb }));
    vi.resetModules();
    const port = await fakePortOccupant([{ status: 200, body: HUB_HEALTH }]);

    const { startWebCockpit } = await import('../../../src/adapters/webCockpit.ts');
    const notices: string[] = [];
    const cockpit = await startWebCockpit({ registryDir: '/custom/run', port }, (message) => notices.push(message));

    expect(cockpit.url).toBe(`http://127.0.0.1:${port}`);
    expect(serveWeb).not.toHaveBeenCalled();
    expect(notices.join(' ')).toMatch(/already running/);
    await cockpit.close();
  });

  it('loses the startup race gracefully by re-probing after EADDRINUSE', async () => {
    vi.doMock('@agimon-ai/doompi-web', () => ({
      serveWeb: () => Promise.reject(Object.assign(new Error('bind failed'), { code: 'EADDRINUSE' })),
    }));
    vi.resetModules();
    // The occupant looks dead on the first probe and reveals itself as the
    // winning hub on the re-probe, exactly the shape of the race.
    const port = await fakePortOccupant([{ status: 500 }, { status: 200, body: HUB_HEALTH }]);

    const { startWebCockpit } = await import('../../../src/adapters/webCockpit.ts');
    const cockpit = await startWebCockpit({ registryDir: '/custom/run', port });

    expect(cockpit.url).toBe(`http://127.0.0.1:${port}`);
  });

  it('names a port squatter that is not a cockpit', async () => {
    vi.doMock('@agimon-ai/doompi-web', () => ({
      serveWeb: () => Promise.reject(Object.assign(new Error('bind failed'), { code: 'EADDRINUSE' })),
    }));
    vi.resetModules();
    const port = await fakePortOccupant([{ status: 404 }]);

    const { startWebCockpit } = await import('../../../src/adapters/webCockpit.ts');

    await expect(startWebCockpit({ registryDir: '/custom/run', port })).rejects.toThrow(/not a DoomPi cockpit/);
  });

  it('says what to install when the cockpit package is absent', async () => {
    vi.doMock('@agimon-ai/doompi-web', () => {
      throw new Error('Cannot find module');
    });
    vi.resetModules();

    const { startWebCockpit } = await import('../../../src/adapters/webCockpit.ts');

    await expect(startWebCockpit({ registryDir: freshRegistryDir(), port: 0 })).rejects.toThrow(
      /--web needs @agimon-ai\/doompi-web/u,
    );
  });
});
