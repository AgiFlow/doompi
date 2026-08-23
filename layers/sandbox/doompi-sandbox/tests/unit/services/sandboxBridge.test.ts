import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BROKER_ADDRESS_ENV,
  BROKER_PORT_ENV,
  BROKER_SOCKET_ENV,
  sandboxBridgeSource,
} from '../../../src/services/sandboxBridge.ts';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function writeBridge(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-bridge-'));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bridgePath = path.join(directory, 'bridge.mjs');
  fs.writeFileSync(bridgePath, sandboxBridgeSource());
  return bridgePath;
}

async function startSocketServer(directory: string): Promise<string> {
  const socketPath = path.join(directory, 'broker.sock');
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`served ${request.url}`);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return socketPath;
}

function runBridge(
  bridgePath: string,
  environment: NodeJS.ProcessEnv,
  childArgs: string[],
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath, ...childArgs], {
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
  });
}

describe('sandboxBridgeSource', () => {
  it('forwards a loopback request to the mounted socket and exits with the child code', async () => {
    const bridgePath = writeBridge();
    const socketPath = await startSocketServer(path.dirname(bridgePath));
    const port = 18317;
    const fetcher = `fetch('http://127.0.0.1:${port}/anthropic/v1/messages').then(async (r) => {
      process.stdout.write(await r.text());
      process.exit(7);
    })`;

    const result = await runBridge(bridgePath, { [BROKER_SOCKET_ENV]: socketPath, [BROKER_PORT_ENV]: String(port) }, [
      process.execPath,
      '-e',
      fetcher,
    ]);

    expect(result.stdout).toBe('served /anthropic/v1/messages');
    expect(result.code).toBe(7);
  });

  it('forwards to a host and port when the broker listens on tcp', async () => {
    const bridgePath = writeBridge();
    const upstream = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`served ${request.url}`);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          upstream.close(() => resolve());
        }),
    );
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    const address = upstream.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a tcp upstream');
    const port = 18319;
    const fetcher = `fetch('http://127.0.0.1:${port}/anthropic/v1/messages').then(async (r) => {
      process.stdout.write(await r.text());
      process.exit(5);
    })`;

    const result = await runBridge(
      bridgePath,
      { [BROKER_ADDRESS_ENV]: `127.0.0.1:${address.port}`, [BROKER_PORT_ENV]: String(port) },
      [process.execPath, '-e', fetcher],
    );

    expect(result.stdout).toBe('served /anthropic/v1/messages');
    expect(result.code).toBe(5);
  });

  it('runs the child unchanged when no broker is configured', async () => {
    const bridgePath = writeBridge();

    const result = await runBridge(bridgePath, {}, [
      process.execPath,
      '-e',
      'process.stdout.write("no broker"); process.exit(3)',
    ]);

    expect(result.stdout).toBe('no broker');
    expect(result.code).toBe(3);
  });

  it('reports an unspawnable child instead of hanging the session', async () => {
    const bridgePath = writeBridge();

    const result = await runBridge(bridgePath, {}, ['doompi-definitely-missing-binary']);

    expect(result.code).toBe(127);
  });
});
