import { describe, expect, it, vi } from 'vitest';
import type { DoomHubChannel } from '@agimon-ai/doompi-extension-contracts/hub-channel';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { HeadlessSessionHost } from '../../../../src/types/server/headlessSessionHost.ts';
import { createHeadlessHub } from '../../../../src/adapters/server/headlessHub.ts';

function host() {
  let resolveExit: ((code: number) => void) | undefined;
  const runtime = {
    exited: new Promise<number>((resolve) => {
      resolveExit = resolve;
    }),
  } as HeadlessSessionHost['runtime'];
  return {
    host: {
      runtime,
      host: undefined,
      prepareFacets: () => undefined,
      activateFacets: async () => undefined,
      canDispatch: () => true,
      onPresentationFrame: () => () => undefined,
      respondToExtensionUi: () => false,
      dispose: vi.fn(async () => undefined),
    } satisfies HeadlessSessionHost,
    exit(code = 0) {
      resolveExit?.(code);
    },
  };
}

describe('createHeadlessHub', () => {
  it('registers isolated direct runtimes without a command-frame channel', () => {
    const first = host();
    const second = host();
    const manager = { create: vi.fn(async () => first.host), closeSession: vi.fn(async () => undefined) } as never;
    const hub = createHeadlessHub({ manager });

    hub.register({ id: 'one', name: 'One', cwd: '/repo', createdAt: 'now', host: first.host });
    hub.register({ id: 'two', name: 'Two', cwd: '/repo', createdAt: 'now', host: second.host });

    expect(hub.runtime('one')).toBe(first.host.runtime);
    expect(hub.runtime('two')).toBe(second.host.runtime);
    expect(hub.snapshot().map((session) => session.id)).toEqual(['one', 'two']);
  });

  it('starts channels once and supplies snapshots and targeted delivery', () => {
    const session = host();
    const manager = { create: vi.fn(), closeSession: vi.fn() } as never;
    const hub = createHeadlessHub({ manager });
    hub.register({ id: 'one', name: 'One', cwd: '/repo', createdAt: 'now', host: session.host });
    const receive = vi.fn();
    const close = vi.fn();
    const channel: DoomHubChannel = {
      frameType: 'test',
      receive: (scope, payload, connection) => receive(scope, payload, connection),
      start(channelHost) {
        expect(channelHost.sessions()).toEqual([{ sessionId: 'one', cwd: '/repo' }]);
        return { payloadFor: () => ({ ready: true }), close };
      },
    };

    hub.registerChannel(channel);
    expect(hub.channelTypes()).toEqual(['test']);
    expect(hub.channelFrames('one')).toEqual([{ type: 'test', sessionId: 'one', payload: { ready: true } }]);
    hub.receiveChannel('one', 'test', { ok: true }, 'connection');
    expect(receive).toHaveBeenCalledWith(
      { sessionId: 'one', cwd: '/repo' },
      { ok: true },
      { connectionId: 'connection' },
    );
  });

  it('mounts facet channels into the hub table and owns their full lifecycle', async () => {
    const first = host();
    const second = host();
    const closeSession = vi.fn(async () => undefined);
    const manager = { closeSession } as never;
    const hub = createHeadlessHub({ manager });
    hub.register({ id: 'first', name: 'First', cwd: '/first', createdAt: 'now', host: first.host });
    const sessionAdded = vi.fn();
    const sessionRemoved = vi.fn();
    const receive = vi.fn();
    const disconnected = vi.fn();
    const close = vi.fn();
    const channel: DoomHubChannel = {
      frameType: 'facet-channel',
      receive,
      disconnected,
      start(channelHost) {
        expect(channelHost.sessions()).toEqual([{ sessionId: 'first', cwd: '/first' }]);
        return {
          payloadFor: (scope) => ({ sessionId: scope.sessionId }),
          sessionAdded,
          sessionRemoved,
          close,
        };
      },
    };

    await hub.mountFacets([
      {
        inject: [DOOM_SERVER_HOST_SERVICE],
        apply(context) {
          const host = context.get(DOOM_SERVER_HOST_SERVICE);
          if (!host) throw new Error('no host');
          const registration = host.registerChannel(channel);
          return () => registration.dispose();
        },
      },
    ]);
    expect(hub.channelTypes()).toEqual(['facet-channel']);
    expect(sessionAdded).toHaveBeenCalledWith({ sessionId: 'first', cwd: '/first' });

    hub.register({ id: 'second', name: 'Second', cwd: '/second', createdAt: 'now', host: second.host });
    expect(sessionAdded).toHaveBeenCalledWith({ sessionId: 'second', cwd: '/second' });
    expect(hub.channelFrames('first')).toEqual([
      { type: 'facet-channel', sessionId: 'first', payload: { sessionId: 'first' } },
    ]);
    hub.receiveChannel('second', 'facet-channel', { ok: true }, 'connection');
    expect(receive).toHaveBeenCalledWith(
      { sessionId: 'second', cwd: '/second' },
      { ok: true },
      { connectionId: 'connection' },
    );
    hub.disconnectChannels('connection');
    expect(disconnected).toHaveBeenCalledWith({ connectionId: 'connection' });

    await hub.closeSession('first');
    expect(sessionRemoved).toHaveBeenCalledWith('first');
    await hub.close();
    expect(close).toHaveBeenCalledOnce();
    expect(closeSession).toHaveBeenCalledWith('second');
    expect(hub.channelTypes()).toEqual([]);
  });

  it('routes channel publications and closes duplicate and removed registrations', async () => {
    const notices: string[] = [];
    const session = host();
    const manager = { closeSession: vi.fn(async () => undefined) } as never;
    const hub = createHeadlessHub({ manager, onNotice: (notice) => notices.push(notice) });
    const events: unknown[] = [];
    hub.onEvent((event) => events.push(event));
    hub.register({ id: 'one', name: 'One', cwd: '/repo', createdAt: 'now', host: session.host });
    let channelHost: Parameters<DoomHubChannel['start']>[0] | undefined;
    const sessionAdded = vi.fn();
    const sessionRemoved = vi.fn();
    const disconnected = vi.fn();
    const close = vi.fn();
    const release = hub.registerChannel({
      frameType: 'updates',
      disconnected,
      start(hostApi) {
        channelHost = hostApi;
        return { payloadFor: () => undefined, sessionAdded, sessionRemoved, close };
      },
    });

    channelHost?.publish('one', { value: 1 });
    expect(channelHost?.publishToConnection?.('', 'one', { value: 2 })).toBe(false);
    expect(channelHost?.publishToConnection?.('client', 'missing', { value: 2 })).toBe(false);
    expect(channelHost?.publishToConnection?.('client', 'one', { value: 2 })).toBe(true);
    expect(events).toContainEqual({ kind: 'channel', frameType: 'updates', sessionId: 'one', payload: { value: 1 } });
    expect(events).toContainEqual({
      kind: 'channel',
      frameType: 'updates',
      sessionId: 'one',
      payload: { value: 2 },
      connectionId: 'client',
    });

    hub.registerChannel({ frameType: 'updates', start: () => ({ payloadFor: () => undefined, close: vi.fn() }) });
    expect(notices).toContain("hub channel 'updates' is already registered");
    hub.disconnectChannels('');
    hub.disconnectChannels('client');
    expect(disconnected).toHaveBeenCalledWith({ connectionId: 'client' });
    await hub.closeSession('one');
    expect(sessionRemoved).toHaveBeenCalledWith('one');
    release();
    release();
    expect(close).toHaveBeenCalledOnce();
  });

  it('owns session creation, API availability, exit cleanup, and idempotent shutdown', async () => {
    const session = host();
    const active = host();
    const closeSession = vi.fn(async () => undefined);
    const manager = { create: vi.fn(async () => session.host), closeSession } as never;
    const hub = createHeadlessHub({ manager });
    hub.register({ id: 'active', name: 'Active', cwd: '/active', createdAt: 'now', host: active.host });
    const created = await hub.create({ sessionId: 'created', sessionName: 'Created', cwd: '/created' } as never);
    expect(created.id).toBe('created');
    expect(hub.runtime('created')).toBe(session.host.runtime);
    expect(await hub.requestSessionApi({ sessionId: 'created', cwd: '/created' }, {} as never)).toMatchObject({
      status: 404,
    });
    expect(() => hub.register(created)).toThrow("Session 'created' is already registered");

    session.exit();
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledWith('created'));
    expect(hub.session('created')).toBeUndefined();
    await hub.closeSession('missing');
    await hub.close();
    expect(closeSession).toHaveBeenCalledWith('active');
    expect(hub.snapshot()).toEqual([]);
    await hub.close();
    expect(closeSession).toHaveBeenCalledTimes(2);
    await expect(hub.create({} as never)).rejects.toThrow('closed');
  });

  it('keeps each session API independent across dynamic creation and closure', async () => {
    const initial = host();
    const first = host();
    const second = host();
    const hosts = new Map([
      ['initial', initial.host],
      ['first', first.host],
      ['second', second.host],
    ]);
    const resources = new Map<string, { close(): void }>();
    const manager = {
      create: vi.fn(async (options: { sessionId: string }) => {
        const sessionHost = hosts.get(options.sessionId);
        if (sessionHost === undefined) throw new Error(`missing host ${options.sessionId}`);
        resources.set(options.sessionId, { close: vi.fn() });
        return sessionHost;
      }),
      closeSession: vi.fn(async (sessionId: string) => {
        resources.get(sessionId)?.close();
        resources.delete(sessionId);
      }),
    };
    let hub!: ReturnType<typeof createHeadlessHub>;
    hub = createHeadlessHub({
      manager: manager as never,
      createSession: async (request) => {
        const session = await hub.create({
          sessionId: request.name,
          sessionName: request.name,
          cwd: request.cwd,
          parentSessionId: request.parentSessionId,
          sessionProvenance: request.sessionProvenance,
        } as never);
        return { sessionId: session.id, cwd: session.cwd };
      },
      requestSessionApi: async (scope) =>
        resources.has(scope.sessionId)
          ? Response.json({ sessionId: scope.sessionId })
          : Response.json({ error: 'Session API unavailable.' }, { status: 404 }),
    });

    await hub.create({ sessionId: 'initial', sessionName: 'Initial', cwd: '/initial' } as never);
    expect((await hub.requestSessionApi({ sessionId: 'initial', cwd: '/initial' }, {} as never)).status).toBe(200);

    await hub.sessionService.create({ cwd: '/first', name: 'first', parentSessionId: 'initial' });
    await hub.sessionService.create({
      cwd: '/second',
      name: 'second',
      parentSessionId: 'initial',
      sessionProvenance: 'worktree',
    });
    expect(hub.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'second', parentSessionId: 'initial', sessionProvenance: 'worktree' }),
      ]),
    );
    expect((await hub.requestSessionApi({ sessionId: 'first', cwd: '/first' }, {} as never)).status).toBe(200);
    expect((await hub.requestSessionApi({ sessionId: 'second', cwd: '/second' }, {} as never)).status).toBe(200);

    await hub.closeSession('first');
    expect((await hub.requestSessionApi({ sessionId: 'first', cwd: '/first' }, {} as never)).status).toBe(404);
    expect((await hub.requestSessionApi({ sessionId: 'second', cwd: '/second' }, {} as never)).status).toBe(200);
    expect(hub.sessionService.isLive('second')).toBe(true);
    expect(hub.session('second')).toBeDefined();

    await hub.close();
    expect(hub.sessionService.isLive('second')).toBe(false);
    expect(manager.closeSession).toHaveBeenCalledWith('second');
  });

  it('owns direct-event subscriptions and replays retained state only when requested', async () => {
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never });
    const session = host();
    hub.register({ id: 'one', name: 'One', cwd: '/repo', createdAt: 'now', host: session.host });
    const first = vi.fn();
    const second = vi.fn();

    hub.directEvents.publish('updates', 'one', { ignored: true });
    const releaseFirst = hub.directEvents.subscribe('updates', 'one', first);
    const releaseSecond = hub.directEvents.subscribe('updates', 'one', second);
    hub.directEvents.publish('updates', 'one', { value: 1 });
    expect(first).toHaveBeenCalledWith({ value: 1 });
    expect(second).toHaveBeenCalledWith({ value: 1 });

    const replay = vi.fn();
    const releaseReplay = hub.directEvents.subscribe('updates', 'one', replay, { replayLatest: true });
    expect(replay).toHaveBeenCalledOnce();
    expect(replay).toHaveBeenCalledWith({ value: 1 });
    releaseReplay();

    releaseFirst();
    releaseFirst();
    hub.directEvents.publish('updates', 'one', { value: 2 });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    releaseSecond();

    await hub.closeSession('one');
    const afterSessionClose = vi.fn();
    const releaseAfterSessionClose = hub.directEvents.subscribe('updates', 'one', afterSessionClose, {
      replayLatest: true,
    });
    expect(afterSessionClose).not.toHaveBeenCalled();
    releaseAfterSessionClose();

    await hub.close();
    const afterClose = vi.fn();
    const releaseAfterClose = hub.directEvents.subscribe('updates', 'one', afterClose);
    hub.directEvents.publish('updates', 'one', { value: 3 });
    releaseAfterClose();
    expect(afterClose).not.toHaveBeenCalled();
  });

  it('refuses unavailable lifecycle paths and ignores invalid channel targets', async () => {
    const notices: string[] = [];
    const hub = createHeadlessHub({
      manager: { closeSession: vi.fn(async () => undefined) } as never,
      onNotice: (notice) => notices.push(notice),
    });

    await expect(
      hub.sessionService.create({ cwd: '/missing', name: 'missing', parentSessionId: 'parent' }),
    ).rejects.toThrow('cannot create sessions');
    expect((await hub.requestSessionApi({ sessionId: 'missing', cwd: '/missing' }, {} as never)).status).toBe(404);
    expect(hub.channelFrames('missing')).toEqual([]);

    const receive = vi.fn();
    hub.registerChannel({
      frameType: 'valid',
      receive,
      start: () => ({ payloadFor: () => undefined, close: vi.fn() }),
    });
    hub.receiveChannel('missing', 'valid', {}, 'connection');
    hub.receiveChannel('missing', 'valid', {}, '');
    hub.receiveChannel('missing', 'missing', {}, 'connection');
    expect(receive).not.toHaveBeenCalled();

    const release = hub.registerChannel({
      frameType: 'broken',
      start: () => {
        throw new Error('broken channel');
      },
    });
    release();
    expect(notices).toContain("hub channel 'broken' failed (Error: broken channel)");

    await hub.mountFacets([]);
    await expect(hub.mountFacets([])).rejects.toThrow('already mounted');
    await hub.close();
    await expect(hub.mountFacets([])).rejects.toThrow('closed');
  });
});
