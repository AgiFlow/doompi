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
createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ token }));
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
    expect(await answer.json()).toEqual({ token: headless?.token });
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
      expect(await answer.json()).toEqual({ token: headless?.token });
    } finally {
      await headless?.close();
    }
    expect(await (await fetch(`http://127.0.0.1:${String(port)}`)).text()).toBe('ok');
  });

  it('keeps serving assets when the headless entry cannot start', async () => {
    const port = await freePort();
    const headless = await startHeadless({
      url: `http://127.0.0.1:${String(port)}`,
      environment: { ...process.env, DOOMPI_SERVER_COMMAND: path.join(scratch(), 'missing.mjs') },
      onNotice: (message) => notices.push(message),
    });

    expect(headless).toBeUndefined();
    expect(notices).toContain(`the headless server did not start on http://127.0.0.1:${String(port)}`);
  });
});
