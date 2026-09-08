import { createServer, type RequestListener } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DOOM_API_INTERNAL_TOKEN_ENV,
  DOOM_API_ROUTE_PREFIX,
  DOOM_API_SOCKET_ENV,
} from '@agimon-ai/doompi-extension-contracts/package-api';
import { UnixRealtimeHost, realtimeHostConnection } from '../src/adapters/realtime/realtimeHost.ts';
import { VOICE_MEDIA_API_BASE_PATH } from '../src/types/clientMedia.ts';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});
const signal = () => new AbortController().signal;
const snapshot = { activationId: 'activation', state: 'active', cursor: 1, events: [] };
async function fixture(handler: RequestListener) {
  const directory = await mkdtemp(join(tmpdir(), 'voice-ipc-'));
  const socketPath = join(directory, 's');
  const server = createServer(handler);
  disposers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return new UnixRealtimeHost({ socketPath, internalToken: 'host-only-token' });
}

describe('live voice Unix host signaling', () => {
  it('requires both host environment values without inventing a fallback', () => {
    expect(realtimeHostConnection({})).toBeUndefined();
    expect(realtimeHostConnection({ [DOOM_API_SOCKET_ENV]: '/unused' })).toBeUndefined();
    expect(realtimeHostConnection({ [DOOM_API_INTERNAL_TOKEN_ENV]: 'token' })).toBeUndefined();
    expect(
      realtimeHostConnection({ [DOOM_API_SOCKET_ENV]: '/unused', [DOOM_API_INTERNAL_TOKEN_ENV]: 'token' }),
    ).toBeInstanceOf(UnixRealtimeHost);
  });

  it('uses the authenticated package API prefix for start, poll, messages, controls and stop', async () => {
    const requests: Array<{ method?: string; url?: string; authorization?: string; body: string }> = [];
    const host = await fixture((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
        if (request.method === 'GET') response.end(JSON.stringify(snapshot));
        else {
          response.statusCode = 204;
          response.end();
        }
      });
    });
    await host.start('activation', 'bounded context', signal());
    expect(await host.poll('activation', 0, signal())).toEqual(snapshot);
    await host.send('activation', ['context-message'], signal());
    await host.control('activation', 'mute', signal());
    await host.stop('activation');
    expect(requests.map((request) => request.method)).toEqual(['POST', 'GET', 'POST', 'POST', 'POST']);
    for (const request of requests) {
      expect(request.authorization).toBe('Bearer host-only-token');
      expect(request.url).toContain(`${DOOM_API_ROUTE_PREFIX}/${VOICE_MEDIA_API_BASE_PATH}/host/realtime/`);
      expect(request.body).not.toContain('host-only-token');
    }
    expect(JSON.parse(requests[0]!.body)).toEqual({ activationId: 'activation', instructions: 'bounded context' });
    expect(JSON.parse(requests[2]!.body)).toEqual({ activationId: 'activation', messages: ['context-message'] });
    expect(JSON.parse(requests[3]!.body)).toEqual({ activationId: 'activation', action: 'mute' });
  });

  it.each([
    null,
    4,
    { ...snapshot, activationId: 'stale' },
    { ...snapshot, cursor: -1 },
    { ...snapshot, cursor: 1.5 },
    { ...snapshot, state: 'ready' },
    { ...snapshot, events: null },
    { ...snapshot, events: Array.from({ length: 65 }, () => ({})) },
  ])('rejects malformed host state %#', async (value) => {
    const host = await fixture((_request, response) => response.end(JSON.stringify(value)));
    await expect(host.poll('activation', 0, signal())).rejects.toThrow('Invalid live voice host state.');
  });

  it('rejects cursor regression', async () => {
    const host = await fixture((_request, response) => response.end(JSON.stringify(snapshot)));
    await expect(host.poll('activation', 2, signal())).rejects.toThrow('Invalid live voice host state.');
  });

  it('does not expose server error bodies', async () => {
    const host = await fixture((_request, response) => {
      response.statusCode = 403;
      response.end('private-provider-token');
    });
    await expect(host.start('activation', '', signal())).rejects.toThrow(
      'Live voice host rejected the operation. Check browser ownership and subscription sign-in.',
    );
  });

  it('rejects invalid JSON without echoing response content', async () => {
    const host = await fixture((_request, response) => response.end('private-invalid-json'));
    await expect(host.poll('activation', 0, signal())).rejects.toThrow('Live voice host returned invalid JSON.');
  });

  it('bounds oversized responses', async () => {
    const host = await fixture((_request, response) => response.end('x'.repeat(1_048_577)));
    await expect(host.poll('activation', 0, signal())).rejects.toThrow(/Live voice host (connection|response) failed/);
  });

  it('aborts in-flight IPC without waiting for a host reply', async () => {
    const abort = new AbortController();
    const host = await fixture(() => abort.abort());
    await expect(host.start('activation', '', abort.signal)).rejects.toThrow(
      'Live voice host request cancelled or timed out.',
    );
  });

  it('rejects already-aborted calls and unavailable sockets', async () => {
    const host = new UnixRealtimeHost({ socketPath: '/missing/doompi-live-test.sock', internalToken: 'token' });
    const abort = new AbortController();
    abort.abort();
    await expect(host.start('activation', '', abort.signal)).rejects.toThrow('cancelled or timed out');
    await expect(host.stop('activation')).rejects.toThrow('connection failed');
  });
});
