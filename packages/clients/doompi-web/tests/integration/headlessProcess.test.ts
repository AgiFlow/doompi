import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startHeadless } from '../../src/adapters/headlessProcess';

const FAKE_HEADLESS = `
import fs from 'node:fs';
import { createServer } from 'node:http';

const tokenFile = process.argv[process.argv.indexOf('--auth-token-file') + 1];
const port = Number.parseInt(process.argv[process.argv.indexOf('--web') + 1], 10);
const token = fs.readFileSync(tokenFile, 'utf8');
let healthChecks = 0;
createServer((request, response) => {
  if (request.url === '/api/health') {
    healthChecks++;
    if (process.env.FAKE_HEALTH_LOG) fs.writeFileSync(process.env.FAKE_HEALTH_LOG, String(healthChecks));
    if (process.env.FAKE_HEALTH_EXIT) process.exit(7);
    const ready = healthChecks > Number(process.env.FAKE_HEALTH_FAILURES ?? 0);
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: ready, role: 'hub', protocol: 1, sessions: 0 }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ connected: process.connected, token }));
}).listen(port, '127.0.0.1');
`;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('startHeadless', () => {
  const directories: string[] = [];
  const servers: Server[] = [];
  const notices: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const directory of directories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
    notices.length = 0;
  });

  function scratch(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-process-'));
    directories.push(directory);
    return directory;
  }

  it('starts the configured headless entry and hands its token to the proxy', async () => {
    const directory = scratch();
    const entry = path.join(directory, 'fake-server.mjs');
    fs.writeFileSync(entry, FAKE_HEADLESS);
    const port = await freePort();

    const headless = await startHeadless({
      url: `http://127.0.0.1:${String(port)}`,
      environment: { ...process.env, DOOMPI_SERVER_COMMAND: entry },
      onNotice: (message) => notices.push(message),
    });

    expect(headless).toBeDefined();
    const answer = await fetch(`http://127.0.0.1:${String(port)}/api/anything`);
    expect(await answer.json()).toEqual({ connected: true, token: headless?.token });
    expect(notices).toContain(`headless server on http://127.0.0.1:${String(port)}`);

    await headless?.close();
    await expect(fetch(`http://127.0.0.1:${String(port)}/api/anything`)).rejects.toThrow();
  });

  it('starts its own authenticated child when the default endpoint already answers', async () => {
    const entry = path.join(scratch(), 'fake-server.mjs');
    fs.writeFileSync(entry, FAKE_HEADLESS);
    const existing = createServer((_request, response) => response.end('ok'));
    servers.push(existing);
    await new Promise<void>((resolve) => existing.listen(0, '127.0.0.1', resolve));
    const address = existing.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const headless = await startHeadless({
      url: `http://127.0.0.1:${String(port)}`,
      environment: { ...process.env, DOOMPI_SERVER_COMMAND: entry },
      onNotice: (message) => notices.push(message),
    });

    expect(headless).toBeDefined();
    try {
      expect(headless?.url).not.toBe(`http://127.0.0.1:${String(port)}`);
      const answer = await fetch(`${headless!.url}/api/anything`);
      expect(await answer.json()).toEqual({ connected: true, token: headless?.token });
    } finally {
      await headless?.close();
    }
    expect(await (await fetch(`http://127.0.0.1:${String(port)}`)).text()).toBe('ok');
  });

  it('waits for a healthy headless response before returning', async () => {
    const directory = scratch();
    const entry = path.join(directory, 'fake-server.mjs');
    const healthLog = path.join(directory, 'health-checks');
    fs.writeFileSync(entry, FAKE_HEADLESS);
    const port = await freePort();
    const headless = await startHeadless({
      url: `http://127.0.0.1:${String(port)}`,
      environment: {
        ...process.env,
        DOOMPI_SERVER_COMMAND: entry,
        FAKE_HEALTH_FAILURES: '1',
        FAKE_HEALTH_LOG: healthLog,
      },
      onNotice: (message) => notices.push(message),
    });
    try {
      expect(fs.readFileSync(healthLog, 'utf8')).toBe('2');
    } finally {
      await headless.close();
    }
  });

  it('rejects when the child exits before becoming healthy', async () => {
    const entry = path.join(scratch(), 'fake-server.mjs');
    fs.writeFileSync(entry, FAKE_HEADLESS);
    const port = await freePort();
    await expect(
      startHeadless({
        url: `http://127.0.0.1:${String(port)}`,
        environment: { ...process.env, DOOMPI_SERVER_COMMAND: entry, FAKE_HEALTH_EXIT: '1' },
        onNotice: (message) => notices.push(message),
      }),
    ).rejects.toThrow(/exited before it was ready/);
  });

  it('rejects when the headless entry cannot start', async () => {
    const port = await freePort();
    await expect(
      startHeadless({
        url: `http://127.0.0.1:${String(port)}`,
        environment: { ...process.env, DOOMPI_SERVER_COMMAND: path.join(scratch(), 'missing.mjs') },
        onNotice: (message) => notices.push(message),
      }),
    ).rejects.toThrow(/exited before it was ready/);
  });
});
