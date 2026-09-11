import { createRemoteServiceBinding } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Client, createClientServiceTransport, type ByteTransportFactory } from '@earendil-works/pi-client';
import {
  DOOM_COCKPIT_SERVER_ID,
  DoomHubService,
  DoomSessionManagementService,
  DoomSessionService,
} from '@agimon-ai/doompi-extension-contracts/session-protocol';
import type { DoomHubChannel } from '@agimon-ai/doompi-extension-contracts/hub-channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createHeadlessHub } from '../../../../src/adapters/server/headlessHub.ts';
import { serveHeadlessServer, type HeadlessServer } from '../../../../src/adapters/server/headlessServer.ts';
import type { HeadlessSessionHost } from '../../../../src/types/server/headlessSessionHost.ts';

function host() {
  const listeners = new Set<(frame: Record<string, unknown>) => void>();
  const runtime = {
    exited: new Promise<number>(() => undefined),
    readEntries: vi.fn(async () => ({ entries: [], leafId: null })),
    readState: vi.fn(async () => ({
      sessionId: 'session',
      model: { provider: 'test', id: 'model' },
      thinkingLevel: 'off',
      isStreaming: false,
    })),
    submitPrompt: vi.fn(async () => ({ settled: Promise.resolve() })),
    prompt: vi.fn(async () => undefined),
    onPresentationFrame(listener: (frame: Record<string, unknown>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listCommands: () => [],
    availableModels: async () => [],
    availableThinkingLevels: async () => [],
    getSessionStats: async () => ({}),
  } as unknown as HeadlessSessionHost['runtime'];
  return {
    host: {
      runtime,
      host: undefined,
      prepareFacets: () => undefined,
      activateFacets: async () => undefined,
      canDispatch: () => true,
      onPresentationFrame(listener: (frame: Record<string, unknown>) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      respondToExtensionUi: () => false,
      dispose: vi.fn(async () => undefined),
    } satisfies HeadlessSessionHost,
    runtime,
    emitFrame(frame: Record<string, unknown>) {
      for (const listener of listeners) listener(frame);
    },
  };
}

function websocketTransport(url: string): ByteTransportFactory {
  return async (handlers) => {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    let terminal = false;
    const stop = (error?: Error): void => {
      if (terminal) return;
      terminal = true;
      if (error) handlers.onError(error);
      else handlers.onClose();
    };
    socket.on('message', (data) => handlers.onData(Buffer.from(data as ArrayBuffer)));
    socket.on('close', () => stop());
    socket.on('error', (error) => stop(error));
    return {
      send: (chunk) =>
        new Promise<void>((resolve, reject) => {
          socket.send(chunk, (error) => (error ? reject(error) : resolve()));
        }),
      close() {
        socket.close();
      },
    };
  };
}

const servers: HeadlessServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('serveHeadlessServer', () => {
  it('authenticates HTTP requests and keeps the retired frame route unavailable', async () => {
    const session = host();
    const requestSessionApi = vi.fn(async () => Response.json({ ok: true }));
    const hub = createHeadlessHub({
      manager: { closeSession: vi.fn(async () => undefined) } as never,
      requestSessionApi,
    });
    hub.register({ id: 'one', name: 'One', cwd: '/repo', createdAt: '2025-01-01T00:00:00.000Z', host: session.host });
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0, token: 'secret' });
    servers.push(server);

    const unauthorized = await fetch(`${server.url}/api/sessions`);
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`${server.url}/api/sessions`, { headers: { authorization: 'Bearer secret' } });
    expect(await response.json()).toEqual({
      sessions: [{ id: 'one', name: 'One', cwd: '/repo', createdAt: '2025-01-01T00:00:00.000Z' }],
    });

    const retired = await fetch(`${server.url}/api/sessions/one/frame`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'prompt', text: 'hello' }),
    });
    expect(retired.status).toBe(404);

    const apiResponse = await fetch(`${server.url}/api/sessions/one/api/test-api/value?x=1`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: 'payload',
    });
    expect(await apiResponse.json()).toEqual({ ok: true });
    expect(requestSessionApi).toHaveBeenCalledWith(
      { sessionId: 'one', cwd: '/repo' },
      { basePath: 'test-api', path: '/value?x=1', method: 'POST', body: Buffer.from('payload') },
    );
    await hub.close();
  });

  it('hosts discovery, channels, and isolated session services over the Pi byte protocol', async () => {
    const first = host();
    const second = host();
    const third = host();
    const disconnected = vi.fn();
    const receive = vi.fn();
    let channelHost: Parameters<DoomHubChannel['start']>[0] | undefined;
    const channel: DoomHubChannel = {
      frameType: 'test_channel',
      receive: (scope, payload, connection) => receive(scope, payload, connection),
      disconnected,
      start: (hostApi) => {
        channelHost = hostApi;
        return { payloadFor: () => ({ ready: true }), close: () => undefined };
      },
    };
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never });
    hub.register({ id: 'one', name: 'One', cwd: '/one', createdAt: '2025-01-01T00:00:00.000Z', host: first.host });
    hub.register({ id: 'two', name: 'Two', cwd: '/two', createdAt: 'invalid', host: second.host });
    hub.registerChannel(channel);
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0, token: 'secret' });
    servers.push(server);
    const client = await Client.connect({
      serverId: DOOM_COCKPIT_SERVER_ID,
      transportFactory: websocketTransport(`${server.url.replace('http:', 'ws:')}/api/pi?token=secret`),
    });
    const hubBinding = createRemoteServiceBinding({
      services: [DoomHubService],
      transport: createClientServiceTransport(client, () => ({ serverId: DOOM_COCKPIT_SERVER_ID })),
    });
    const hubService = hubBinding.use(DoomHubService);
    await hubBinding.ready(BACKGROUND_CONTEXT);
    expect(hubService.state.value?.events[0]?.frame).toEqual({
      type: 'sessions_snapshot',
      sessions: [
        { id: 'one', name: 'One', cwd: '/one', createdAt: '2025-01-01T00:00:00.000Z' },
        { id: 'two', name: 'Two', cwd: '/two', createdAt: 'invalid' },
      ],
    });

    await hubService.send({ type: 'subscribe', sessionId: 'missing' }, BACKGROUND_CONTEXT);
    await hubService.send({ type: 'noop' }, BACKGROUND_CONTEXT);
    await hubService.send({ type: 'subscribe', sessionId: 'one' }, BACKGROUND_CONTEXT);
    await vi.waitFor(() =>
      expect(hubService.state.value?.events.some((event) => event.frame.type === 'test_channel')).toBe(true),
    );
    await hubService.send({ type: 'test_channel', sessionId: 'one', payload: { action: 'run' } }, BACKGROUND_CONTEXT);
    expect(receive).toHaveBeenCalledWith(
      { sessionId: 'one', cwd: '/one' },
      { action: 'run' },
      expect.objectContaining({ connectionId: expect.any(String) }),
    );
    const connectionId = (receive.mock.calls[0]![2] as { connectionId: string }).connectionId;
    channelHost?.publishToConnection?.(connectionId, 'one', { targeted: true });
    await vi.waitFor(() =>
      expect(
        hubService.state.value?.events.some(
          (event) =>
            event.frame.type === 'test_channel' &&
            (event.frame.payload as { targeted?: boolean } | undefined)?.targeted === true,
        ),
      ).toBe(true),
    );
    const targetedCount = hubService.state.value?.events.length;
    channelHost?.publishToConnection?.('another-client', 'one', { hidden: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hubService.state.value?.events).toHaveLength(targetedCount ?? 0);

    hub.register({ id: 'three', name: 'Three', cwd: '/three', createdAt: 'now', host: third.host });
    await vi.waitFor(() =>
      expect(
        hubService.state.value?.events.some(
          (event) => event.frame.type === 'session_upsert' && (event.frame.session as { id?: string }).id === 'three',
        ),
      ).toBe(true),
    );
    await hub.closeSession('three');
    await vi.waitFor(() =>
      expect(
        hubService.state.value?.events.some(
          (event) => event.frame.type === 'session_removed' && event.frame.sessionId === 'three',
        ),
      ).toBe(true),
    );
    await hubService.send({ type: 'unsubscribe', sessionId: 'one' }, BACKGROUND_CONTEXT);
    await hubService.send({ type: 'subscribe', sessionId: 'one' }, BACKGROUND_CONTEXT);

    await expect(
      client.request(
        { serverId: DOOM_COCKPIT_SERVER_ID },
        { serviceId: DoomSessionManagementService.id, member: 'attach', args: ['missing'] },
      ),
    ).rejects.toThrow();
    await client.request(
      { serverId: DOOM_COCKPIT_SERVER_ID },
      { serviceId: DoomSessionManagementService.id, member: 'attach', args: ['one'] },
    );
    const sessionBinding = createRemoteServiceBinding({
      services: [DoomSessionService],
      transport: createClientServiceTransport(client, () => client.attachment),
    });
    const sessionService = sessionBinding.use(DoomSessionService);
    await sessionBinding.ready(BACKGROUND_CONTEXT);
    await sessionService.prompt({ text: 'hello', waitFor: 'accepted' }, BACKGROUND_CONTEXT);
    expect(first.runtime.submitPrompt).toHaveBeenCalledWith('hello', undefined);
    expect(second.runtime.submitPrompt).not.toHaveBeenCalled();

    await sessionBinding.dispose(BACKGROUND_CONTEXT);
    await hubBinding.dispose(BACKGROUND_CONTEXT);
    await client.dispose();
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1));
    await hub.close();
  });

  it('serves health, events, package APIs, and channel HTTP routes from the same hub', async () => {
    const session = host();
    const receive = vi.fn();
    let channelHost: Parameters<DoomHubChannel['start']>[0] | undefined;
    const requestSessionApi = vi.fn(async (_scope, request) =>
      request.method === 'HEAD' ? new Response(null, { status: 204 }) : Response.json({ path: request.path }),
    );
    const hub = createHeadlessHub({
      manager: { closeSession: vi.fn(async () => undefined) } as never,
      requestSessionApi,
    });
    hub.register({ id: 'one', name: 'One', cwd: '/repo', createdAt: 'now', host: session.host });
    hub.registerChannel({
      frameType: 'updates',
      receive: (scope, payload, connection) => receive(scope, payload, connection),
      start: (hostApi) => {
        channelHost = hostApi;
        return { payloadFor: () => ({ ready: true }), close: () => undefined };
      },
    });
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0, token: 'secret' });
    servers.push(server);
    expect(await (await fetch(`${server.url}/api/health`)).json()).toMatchObject({
      ok: true,
      role: 'hub',
      sessions: 1,
    });
    expect((await fetch(`${server.url}/missing`, { headers: { 'x-doompi-token': 'secret' } })).status).toBe(404);
    expect(
      (await fetch(`${server.url}/api/sessions/missing`, { headers: { 'x-doompi-token': 'secret' } })).status,
    ).toBe(404);
    expect(
      await (await fetch(`${server.url}/api/sessions/one`, { headers: { 'x-doompi-token': 'secret' } })).json(),
    ).toMatchObject({
      id: 'one',
    });
    expect(
      await (
        await fetch(`${server.url}/api/sessions/one/channels`, { headers: { 'x-doompi-token': 'secret' } })
      ).json(),
    ).toEqual({ channels: [{ type: 'updates', sessionId: 'one', payload: { ready: true } }] });
    expect(
      (
        await fetch(`${server.url}/api/sessions/one/channel/updates`, {
          method: 'POST',
          headers: { 'x-doompi-token': 'secret', 'x-doompi-connection': 'http-client' },
          body: JSON.stringify({ action: 'refresh' }),
        })
      ).status,
    ).toBe(202);
    expect(receive).toHaveBeenCalledWith(
      { sessionId: 'one', cwd: '/repo' },
      { action: 'refresh' },
      { connectionId: 'http-client' },
    );
    expect(
      (
        await fetch(`${server.url}/api/sessions/one/api/INVALID/value`, {
          headers: { 'x-doompi-token': 'secret' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${server.url}/api/sessions/one/api/test/value`, {
          method: 'HEAD',
          headers: { 'x-doompi-token': 'secret' },
        })
      ).status,
    ).toBe(204);

    const abort = new AbortController();
    const events = await fetch(`${server.url}/api/events?token=secret`, { signal: abort.signal });
    const reader = events.body?.getReader();
    const first = await reader?.read();
    expect(Buffer.from(first?.value ?? []).toString()).toContain('sessions_snapshot');
    channelHost?.publish('one', { updated: true });
    const live = await reader?.read();
    expect(Buffer.from(live?.value ?? []).toString()).toContain('channel_frame');
    abort.abort();
    await hub.close();
  });

  it('returns JSON failures for malformed channel payloads and backend API errors', async () => {
    const session = host();
    const requestSessionApi = vi.fn(async () => {
      throw new Error('package API unavailable');
    });
    const hub = createHeadlessHub({
      manager: { closeSession: vi.fn(async () => undefined) } as never,
      requestSessionApi,
    });
    hub.register({ id: 'one', name: 'One', cwd: '/repo', createdAt: 'now', host: session.host });
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0, token: 'secret' });
    servers.push(server);

    const malformed = await fetch(`${server.url}/api/sessions/one/channel/updates`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: 'not-json',
    });
    expect(malformed.status).toBe(500);
    expect(await malformed.json()).toEqual({ error: expect.any(String) });

    const backendFailure = await fetch(`${server.url}/api/sessions/one/api/test/value`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(backendFailure.status).toBe(500);
    expect(await backendFailure.json()).toEqual({ error: 'package API unavailable' });

    await server.close();
    await server.close();
    await hub.close();
  });

  it('rejects unauthorized Pi connections and retires the JSON socket route', async () => {
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never });
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0, token: 'secret' });
    servers.push(server);

    const connect = (path: string) =>
      new Promise<number>((resolve) => {
        const socket = new WebSocket(`${server.url.replace('http:', 'ws:')}${path}`);
        socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
        socket.once('error', () => resolve(0));
      });
    await expect(connect('/api/pi')).resolves.toBe(401);
    await expect(connect('/api/session?token=secret')).resolves.toBe(404);
    await hub.close();
  });
});
