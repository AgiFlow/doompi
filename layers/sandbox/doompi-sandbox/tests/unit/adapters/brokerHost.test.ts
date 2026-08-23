import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startBroker } from '../../../src/adapters/brokerHost.ts';
import type { RunningBroker } from '../../../src/adapters/brokerHost.ts';

const running: RunningBroker[] = [];

afterEach(async () => {
  for (const broker of running.splice(0)) await broker.stop();
});

async function start(environment: Record<string, string>, platform: string): Promise<RunningBroker | undefined> {
  const broker = await startBroker({ environment, platform });
  if (broker) running.push(broker);
  return broker;
}

function statusOf(options: http.RequestOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ ...options, path: '/unknown-provider', method: 'GET' }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
    request.end();
  });
}

describe('startBroker', () => {
  it('reports what it brokers and withholds', async () => {
    const broker = await start({ ANTHROPIC_API_KEY: 'real-anthropic', OPENAI_API_KEY: 'real-openai' }, 'darwin');

    expect(broker?.providers).toEqual(['anthropic', 'openai']);
    expect(broker?.withheldEnv).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    expect(broker?.token.length).toBeGreaterThanOrEqual(32);
  });

  it('mints a distinct token per session', async () => {
    const first = await start({ ANTHROPIC_API_KEY: 'k' }, 'darwin');
    const second = await start({ ANTHROPIC_API_KEY: 'k' }, 'darwin');

    expect(first?.token).not.toBe(second?.token);
  });

  it('does not start when the host holds no brokerable credential', async () => {
    expect(await start({ PATH: '/usr/bin' }, 'linux')).toBeUndefined();
  });

  describe('on linux', () => {
    it('listens on an owner-only socket a container can bind-mount', async () => {
      const broker = await start({ ANTHROPIC_API_KEY: 'real-anthropic' }, 'linux');
      if (broker?.endpoint.transport !== 'unix') throw new Error('Expected a unix endpoint');

      const socketPath = path.join(broker.endpoint.socketDirectory, 'broker.sock');
      expect(fs.existsSync(socketPath)).toBe(true);
      expect(fs.statSync(broker.endpoint.socketDirectory).mode & 0o777).toBe(0o700);
      await expect(statusOf({ socketPath })).resolves.toBe(404);
    });

    it('removes the socket directory on stop', async () => {
      const broker = await start({ ANTHROPIC_API_KEY: 'k' }, 'linux');
      if (broker?.endpoint.transport !== 'unix') throw new Error('Expected a unix endpoint');
      const { socketDirectory } = broker.endpoint;

      await broker.stop();
      running.length = 0;

      expect(fs.existsSync(socketDirectory)).toBe(false);
    });
  });

  describe('on a virtual machine backed engine', () => {
    // A container there cannot connect to a mounted host socket at all, so the
    // broker takes a loopback port the engine's host gateway can reach.
    it('listens on loopback rather than a socket', async () => {
      const broker = await start({ ANTHROPIC_API_KEY: 'real-anthropic' }, 'darwin');
      if (broker?.endpoint.transport !== 'tcp') throw new Error('Expected a tcp endpoint');

      expect(broker.endpoint.port).toBeGreaterThan(0);
      await expect(statusOf({ host: '127.0.0.1', port: broker.endpoint.port })).resolves.toBe(404);
    });

    it('stops answering once the session ends', async () => {
      const broker = await start({ ANTHROPIC_API_KEY: 'k' }, 'win32');
      if (broker?.endpoint.transport !== 'tcp') throw new Error('Expected a tcp endpoint');
      const { port } = broker.endpoint;

      await broker.stop();
      running.length = 0;

      await expect(statusOf({ host: '127.0.0.1', port })).rejects.toThrowError();
    });
  });
});
