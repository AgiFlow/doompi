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

async function start(environment: Record<string, string>): Promise<RunningBroker | undefined> {
  const broker = await startBroker({ environment });
  if (broker) running.push(broker);
  return broker;
}

describe('startBroker', () => {
  it('listens on an owner-only socket and reports what it brokers', async () => {
    const broker = await start({ ANTHROPIC_API_KEY: 'real-anthropic', OPENAI_API_KEY: 'real-openai' });
    if (!broker) throw new Error('Expected a broker');

    expect(broker.providers).toEqual(['anthropic', 'openai']);
    expect(broker.withheldEnv).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    expect(fs.existsSync(path.join(broker.socketDirectory, 'broker.sock'))).toBe(true);
    expect(fs.statSync(broker.socketDirectory).mode & 0o777).toBe(0o700);
  });

  it('mints a long random token per session', async () => {
    const first = await start({ ANTHROPIC_API_KEY: 'k' });
    const second = await start({ ANTHROPIC_API_KEY: 'k' });

    expect(first?.token).not.toBe(second?.token);
    expect(first?.token.length).toBeGreaterThanOrEqual(32);
  });

  it('does not start when the host holds no brokerable credential', async () => {
    expect(await start({ PATH: '/usr/bin' })).toBeUndefined();
  });

  it('answers requests while running and removes the socket on stop', async () => {
    const broker = await start({ ANTHROPIC_API_KEY: 'real-anthropic' });
    if (!broker) throw new Error('Expected a broker');
    const socketPath = path.join(broker.socketDirectory, 'broker.sock');

    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request({ socketPath, path: '/unknown-provider', method: 'GET' }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', reject);
      request.end();
    });
    expect(status).toBe(404);

    await broker.stop();
    running.length = 0;
    expect(fs.existsSync(broker.socketDirectory)).toBe(false);
  });
});
