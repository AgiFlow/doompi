import fs from 'node:fs';
import http from 'node:http';
import type https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBrokerServer } from '../../../src/adapters/brokerServer.ts';
import type { ResolvedCredential } from '../../../src/services/brokerRoutes.ts';

const TOKEN = 'session-token-0123456789';
const REAL_KEY = 'sk-host-real-key';

interface UpstreamCall {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function listen(server: http.Server, target: string | number): Promise<void> {
  return new Promise((resolve) => {
    server.listen(target, () => resolve());
  });
}

function track(server: http.Server): void {
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
}

async function startUpstream(
  handler: (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void,
): Promise<{ origin: string; calls: UpstreamCall[] }> {
  const calls: UpstreamCall[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      calls.push({ method: request.method, url: request.url, headers: request.headers, body });
      handler(request, response, body);
    });
  });
  track(server);
  await listen(server, 0);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP upstream address');
  return { origin: `http://127.0.0.1:${address.port}`, calls };
}

async function startBroker(
  credentials: ReadonlyMap<string, ResolvedCredential>,
  denied: string[] = [],
): Promise<string> {
  const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-broker-')), 'broker.sock');
  const server = createBrokerServer({
    credentials,
    token: TOKEN,
    onDenied: (reason) => denied.push(reason),
    requestUpstream: http.request as unknown as typeof https.request,
  });
  track(server);
  await listen(server, socketPath);
  return socketPath;
}

function credential(origin: string, provider = 'anthropic'): ReadonlyMap<string, ResolvedCredential> {
  return new Map([
    [
      provider,
      {
        route: { provider, upstream: origin, hostKeyEnv: ['ANTHROPIC_API_KEY'] },
        envName: 'ANTHROPIC_API_KEY',
        value: REAL_KEY,
      },
    ],
  ]);
}

function callBroker(
  socketPath: string,
  options: { path: string; headers?: http.OutgoingHttpHeaders; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath, path: options.path, method: options.body === undefined ? 'GET' : 'POST', headers: options.headers },
      (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

describe('createBrokerServer', () => {
  it('swaps a matching token for the host credential and forwards the body', async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    const socketPath = await startBroker(credential(upstream.origin));

    const result = await callBroker(socketPath, {
      path: '/anthropic/v1/messages',
      headers: { 'x-api-key': TOKEN, 'content-type': 'application/json' },
      body: '{"model":"claude"}',
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe('{"ok":true}');
    expect(upstream.calls[0]?.url).toBe('/v1/messages');
    expect(upstream.calls[0]?.headers['x-api-key']).toBe(REAL_KEY);
    expect(upstream.calls[0]?.body).toBe('{"model":"claude"}');
  });

  it('preserves the bearer scheme when a provider uses authorization', async () => {
    const upstream = await startUpstream((_request, response) => response.end('ok'));
    const socketPath = await startBroker(credential(upstream.origin, 'openai'));

    await callBroker(socketPath, { path: '/openai/responses', headers: { authorization: `Bearer ${TOKEN}` } });

    expect(upstream.calls[0]?.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
  });

  it('swaps a credential carried as a query parameter', async () => {
    const upstream = await startUpstream((_request, response) => response.end('ok'));
    const socketPath = await startBroker(credential(upstream.origin, 'google'));

    await callBroker(socketPath, { path: `/google/models/gemini:generate?key=${TOKEN}&alt=sse` });

    expect(upstream.calls[0]?.url).toBe(`/models/gemini:generate?key=${REAL_KEY}&alt=sse`);
  });

  it('never forwards a request that fails to present the token', async () => {
    const upstream = await startUpstream((_request, response) => response.end('ok'));
    const denied: string[] = [];
    const socketPath = await startBroker(credential(upstream.origin), denied);

    const wrong = await callBroker(socketPath, { path: '/anthropic/v1/messages', headers: { 'x-api-key': 'guess' } });
    const absent = await callBroker(socketPath, { path: '/anthropic/v1/messages' });

    expect(wrong.status).toBe(401);
    expect(absent.status).toBe(401);
    expect(upstream.calls).toHaveLength(0);
    expect(denied).toHaveLength(2);
  });

  it('refuses a provider the session was not granted', async () => {
    const upstream = await startUpstream((_request, response) => response.end('ok'));
    const socketPath = await startBroker(credential(upstream.origin));

    const result = await callBroker(socketPath, { path: '/openai/responses', headers: { 'x-api-key': TOKEN } });

    expect(result.status).toBe(404);
    expect(upstream.calls).toHaveLength(0);
  });

  it('streams a chunked response without waiting for the upstream to finish', async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: one\n\n');
      setTimeout(() => response.end('data: two\n\n'), 10);
    });
    const socketPath = await startBroker(credential(upstream.origin));

    const firstChunk = await new Promise<string>((resolve, reject) => {
      const request = http.request(
        { socketPath, path: '/anthropic/v1/messages', method: 'GET', headers: { 'x-api-key': TOKEN } },
        (response) => {
          response.once('data', (chunk: Buffer) => {
            resolve(chunk.toString());
            response.destroy();
          });
        },
      );
      request.on('error', reject);
      request.end();
    });

    expect(firstChunk).toBe('data: one\n\n');
  });

  it('reports an unreachable provider as a gateway failure', async () => {
    const socketPath = await startBroker(credential('http://127.0.0.1:1'));

    const result = await callBroker(socketPath, { path: '/anthropic/v1/messages', headers: { 'x-api-key': TOKEN } });

    expect(result.status).toBe(502);
  });
});
