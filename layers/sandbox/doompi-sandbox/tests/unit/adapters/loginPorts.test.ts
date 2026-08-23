import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { availableLoginPorts } from '../../../src/adapters/loginPorts.ts';

const servers: net.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function occupy(): Promise<number> {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a tcp address');
  return address.port;
}

describe('availableLoginPorts', () => {
  it('reports a free port as publishable', async () => {
    const port = await occupy();
    servers.splice(0).forEach((server) => server.close());

    await expect(availableLoginPorts([port])).resolves.toEqual([port]);
  });

  it('skips a port another process already holds', async () => {
    const taken = await occupy();

    await expect(availableLoginPorts([taken])).resolves.toEqual([]);
  });

  it('keeps the free ports when only some are taken', async () => {
    const taken = await occupy();
    const free = await occupy();
    servers.pop()?.close();

    await expect(availableLoginPorts([taken, free])).resolves.toEqual([free]);
  });

  it('leaves the probed ports usable afterwards', async () => {
    const port = await occupy();
    servers.splice(0).forEach((server) => server.close());

    await availableLoginPorts([port]);

    await expect(availableLoginPorts([port])).resolves.toEqual([port]);
  });
});
