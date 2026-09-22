import { describe, expect, it, vi } from 'vitest';

import type { DoomHubChannel } from '../../../../../src/exports/hubChannel';
import {
  DOOM_SERVER_HOST_SERVICE,
  requireDoomServerHost,
  type DoomServerFacet,
} from '../../../../../src/exports/serverFacet';
import { createHeadlessHub } from '../../../../../src/server/headlessHub';
import type { HeadlessSessionHost } from '../../../../../src/systems/main/types/headlessSessionHost';
import type { DirectHarnessFrame } from '../../../../../src/types/server/directHarnessRuntime';

function host() {
  let resolveExit: ((code: number) => void) | undefined;
  let presentationListener: ((frame: DirectHarnessFrame) => void) | undefined;
  const runtime = {
    exited: new Promise<number>((resolve) => {
      resolveExit = resolve;
    }),
  } as HeadlessSessionHost['runtime'];
  return {
    host: {
      runtime,
      host: undefined,
      toolSurface: {} as HeadlessSessionHost['toolSurface'],
      mcpSurface: {} as HeadlessSessionHost['mcpSurface'],
      prepareFacets: () => undefined,
      activateFacets: async () => undefined,
      canDispatch: () => true,
      onPresentationFrame: (listener) => {
        presentationListener = listener;
        return () => {
          if (presentationListener === listener) presentationListener = undefined;
        };
      },
      respondToExtensionUi: () => false,
      dispose: vi.fn(async () => undefined),
    } satisfies HeadlessSessionHost,
    exit(code = 0) {
      resolveExit?.(code);
    },
    emitFrame(frame: DirectHarnessFrame) {
      presentationListener?.(frame);
    },
  };
}

describe('createHeadlessHub', () => {
  it('tracks prompt and extension input phases without changing phase on ordinary messages', async () => {
    const session = host();
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never });
    hub.register({
      id: 'one',
      name: 'One',
      cwd: '/repo',
      createdAt: 'now',
      updatedAt: 'later',
      phase: 'retry',
      phaseSince: 'earlier',
      pendingMessageCount: 2,
      everPrompted: true,
      awaitingInput: false,
      host: session.host,
    });
    expect(hub.snapshot()[0]).toMatchObject({ phase: 'retry', phaseSince: 'earlier', pendingMessageCount: 2 });
    expect(() => hub.register({ id: 'one', name: 'Again', cwd: '/repo', createdAt: 'now', host: host().host })).toThrow(
      'already registered',
    );
    session.emitFrame({ type: 'extension_ui_request', method: 'notify' });
    expect(hub.session('one')?.awaitingInput).toBe(false);
    session.emitFrame({ type: 'extension_ui_request', method: 'select' });
    expect(hub.session('one')?.awaitingInput).toBe(true);
    session.emitFrame({ type: 'message_end', message: { role: 'assistant' } });
    expect(hub.session('one')?.phase).toBe('retry');
    expect(hub.session('one')?.awaitingInput).toBe(true);
    session.emitFrame({ type: 'session_info_changed', name: 'Renamed' });
    expect(hub.session('one')?.name).toBe('Renamed');
    session.emitFrame({ type: 'extension_ui_answered' });
    expect(hub.session('one')?.awaitingInput).toBe(false);
    session.emitFrame({ type: 'agent_start' });
    expect(hub.session('one')).toMatchObject({ phase: 'turn', everPrompted: true });
    session.emitFrame({ type: 'extension_ui_request', method: 'editor' });
    session.emitFrame({ type: 'agent_settled' });
    expect(hub.session('one')).toMatchObject({
      phase: 'idle',
      awaitingInput: false,
      lastSettledAt: expect.any(String),
    });
    await hub.close();
    expect(() =>
      hub.register({ id: 'later', name: 'Later', cwd: '/repo', createdAt: 'now', host: host().host }),
    ).toThrow('closed');
  });

  it('reports failed exit cleanup and rejects invalid mount and workspace operations', async () => {
    const notices: string[] = [];
    const session = host();
    const hub = createHeadlessHub({
      manager: {
        closeSession: vi.fn(async () => {
          throw new Error('cleanup unavailable');
        }),
      } as never,
      onNotice: (notice) => notices.push(notice),
    });
    await expect(hub.admitWorkspace('/repo')).rejects.toThrow('unavailable');
    await expect(hub.mountFacets([], { scope: 'session', sessionId: 'one', onNotice: vi.fn() })).rejects.toThrow(
      'Session facets belong',
    );
    await expect(hub.mountFacets([], { scope: 'workspace', onNotice: vi.fn() })).rejects.toThrow(
      'admitted identity and root',
    );
    await hub.removeWorkspace('missing');
    hub.register({ id: 'one', name: 'One', cwd: '/repo', createdAt: 'now', host: session.host });
    session.exit(1);
    await vi.waitFor(() => expect(notices).toContain('session one cleanup failed (cleanup unavailable)'));
    expect(hub.session('one')).toBeUndefined();
    await hub.close();
    expect((await hub.requestApi({ scope: 'global' }, 'example', new Request('http://localhost/'))).status).toBe(503);
  });

  it('confines channel lifecycle, events, and APIs to the mounted workspace', async () => {
    const createSession = vi.fn(async () => ({ sessionId: 'created', cwd: '/one' }));
    const requestSessionApi = vi.fn(async () => Response.json({ ok: true }));
    const closeSession = vi.fn(async () => undefined);
    const hub = createHeadlessHub({ manager: { closeSession } as never, createSession, requestSessionApi });
    hub.register({ id: 'one', workspaceId: 'one', name: 'One', cwd: '/one', createdAt: 'now', host: host().host });
    hub.register({ id: 'two', workspaceId: 'two', name: 'Two', cwd: '/two', createdAt: 'now', host: host().host });
    let channelHost: Parameters<DoomHubChannel['start']>[0] | undefined;
    const receive = vi.fn();
    const events: unknown[] = [];
    hub.onEvent((event) => events.push(event));
    hub.registerChannel(
      {
        frameType: 'workspace-only',
        receive,
        start(api) {
          channelHost = api;
          return { payloadFor: () => ({ ready: true }), close: vi.fn() };
        },
      },
      { scope: 'workspace', workspaceId: 'one' },
    );
    expect(channelHost?.sessions()).toEqual([{ sessionId: 'one', workspaceId: 'one', cwd: '/one' }]);
    const scopedSessions = channelHost?.sessionService;
    expect(scopedSessions).toBeDefined();
    expect(scopedSessions?.isLive('one')).toBe(true);
    expect(scopedSessions?.isLive('two')).toBe(false);
    await expect(scopedSessions?.create({ cwd: '/one', name: 'child' })).rejects.toThrow('Parent session');
    await expect(scopedSessions?.create({ cwd: '/one', name: 'child', parentSessionId: 'two' })).rejects.toThrow(
      'Parent session',
    );
    await expect(scopedSessions?.create({ cwd: '/one', name: 'child', parentSessionId: 'one' })).resolves.toEqual({
      sessionId: 'created',
      cwd: '/one',
    });
    expect(createSession).toHaveBeenCalledOnce();
    await expect(scopedSessions?.close('two')).rejects.toThrow('outside this mount');
    await expect(scopedSessions?.close('missing')).resolves.toBeUndefined();
    expect(closeSession).not.toHaveBeenCalled();
    expect((await channelHost?.requestSessionApi({ sessionId: 'two', cwd: '/two' }, {} as never))?.status).toBe(404);
    expect((await channelHost?.requestSessionApi({ sessionId: 'one', cwd: '/one' }, {} as never))?.status).toBe(200);
    expect(requestSessionApi).toHaveBeenCalledOnce();

    const seen = vi.fn();
    channelHost?.directEvents.publish('notice', 'two', 'hidden');
    channelHost?.directEvents.publish('notice', 'one', 'visible');
    channelHost?.directEvents.subscribe('notice', 'two', seen, { replayLatest: true });
    expect(seen).not.toHaveBeenCalled();
    const release = channelHost?.directEvents.subscribe('notice', 'one', seen, { replayLatest: true });
    expect(seen).toHaveBeenCalledWith('visible');
    channelHost?.directEvents.publish('notice', 'one', 'next');
    expect(seen).toHaveBeenCalledWith('next');
    release?.();

    channelHost?.publish('two', 'hidden');
    expect(channelHost?.publishToConnection?.('client', 'two', 'hidden')).toBe(false);
    expect(channelHost?.publishToConnection?.('client', 'one', 'visible')).toBe(true);
    expect(events).toContainEqual({
      kind: 'channel',
      frameType: 'workspace-only',
      sessionId: 'one',
      payload: 'visible',
      connectionId: 'client',
    });
    hub.receiveChannel('two', 'workspace-only', {}, 'client');
    hub.receiveChannel('one', 'workspace-only', {}, 'client');
    expect(receive).toHaveBeenCalledOnce();
    await hub.close();
  });

  it('lets a session-scoped channel close its direct child but not a foreign session', async () => {
    const parent = host();
    const child = host();
    const foreign = host();
    const closeSession = vi.fn(async () => undefined);
    const hub = createHeadlessHub({ manager: { closeSession } as never });
    hub.register({ id: 'parent', name: 'Parent', cwd: '/repo', createdAt: 'now', host: parent.host });
    hub.register({
      id: 'child',
      name: 'Child',
      cwd: '/repo/worktree',
      createdAt: 'now',
      parentSessionId: 'parent',
      host: child.host,
    });
    hub.register({
      id: 'foreign',
      name: 'Foreign',
      cwd: '/repo/other',
      createdAt: 'now',
      parentSessionId: 'another-parent',
      host: foreign.host,
    });
    let channelHost: Parameters<DoomHubChannel['start']>[0] | undefined;
    hub.registerChannel(
      {
        frameType: 'session-only',
        start(api) {
          channelHost = api;
          return { payloadFor: () => undefined, close: vi.fn() };
        },
      },
      { scope: 'session', sessionId: 'parent' },
    );

    expect(hub.sessionService.canCommunicate?.('parent', 'child')).toBe(true);
    expect(hub.sessionService.canCommunicate?.('child', 'parent')).toBe(true);
    expect(hub.sessionService.canCommunicate?.('parent', 'foreign')).toBe(false);
    expect(channelHost!.sessionService!.canCommunicate?.('parent', 'child')).toBe(true);
    expect(channelHost!.sessionService!.canCommunicate?.('child', 'parent')).toBe(false);

    const parentCommunication = hub.sessionService.bindCommunication!('parent');
    const childCommunication = hub.sessionService.bindCommunication!('child');
    const foreignCommunication = hub.sessionService.bindCommunication!('foreign');
    const received = vi.fn();
    childCommunication.subscribe('authenticated', received);
    parentCommunication.onPeerReady(() => undefined);
    childCommunication.onPeerReady(() => undefined);
    foreignCommunication.onPeerReady(() => undefined);

    expect(parentCommunication.publish('child', 'authenticated', { value: 1 })).toBe(true);
    expect(received).toHaveBeenCalledWith('parent', { value: 1 });
    expect(foreignCommunication.publish('child', 'authenticated', { value: 2 })).toBe(false);
    hub.directEvents.publish('authenticated', 'child', { sourceSessionId: 'parent', value: 3 });
    expect(received).toHaveBeenCalledTimes(1);

    await expect(channelHost!.sessionService!.close('child')).resolves.toBeUndefined();
    expect(closeSession).toHaveBeenCalledWith('child');
    await expect(channelHost!.sessionService!.close('foreign')).rejects.toThrow('outside this mount');
    await hub.close();
  });

  it('routes worktree provisioners to the narrowest channel mount', async () => {
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never });
    hub.register({ id: 'one', workspaceId: 'one', name: 'One', cwd: '/one', createdAt: 'now', host: host().host });
    hub.register({ id: 'two', workspaceId: 'two', name: 'Two', cwd: '/two', createdAt: 'now', host: host().host });
    const global = vi.fn(async () => ({ sessionId: 'global', cwd: '/global' }));
    const workspace = vi.fn(async () => ({ sessionId: 'workspace', cwd: '/workspace' }));
    const session = vi.fn(async () => ({ sessionId: 'session', cwd: '/session' }));
    const channel = (provisioner: typeof global): DoomHubChannel => ({
      frameType: 'git_worktrees',
      start(api) {
        const unregister = api.sessionService?.registerReservedWorktreeProvisioner?.(provisioner);
        return { payloadFor: () => undefined, close: () => unregister?.() };
      },
    });

    hub.registerChannel(channel(global));
    const releaseWorkspace = hub.registerChannel(channel(workspace), { scope: 'workspace', workspaceId: 'one' });
    const releaseSession = hub.registerChannel(channel(session), { scope: 'session', sessionId: 'one' });

    await expect(
      hub.sessionService.provisionReservedWorktree!({ reservationId: 'child', parentSessionId: 'one' }),
    ).resolves.toEqual({
      sessionId: 'session',
      cwd: '/session',
    });
    releaseSession();
    await expect(
      hub.sessionService.provisionReservedWorktree!({ reservationId: 'child', parentSessionId: 'one' }),
    ).resolves.toEqual({
      sessionId: 'workspace',
      cwd: '/workspace',
    });
    await expect(
      hub.sessionService.provisionReservedWorktree!({ reservationId: 'child', parentSessionId: 'two' }),
    ).resolves.toEqual({
      sessionId: 'global',
      cwd: '/global',
    });
    releaseWorkspace();
    await expect(
      hub.sessionService.provisionReservedWorktree!({ reservationId: 'child', parentSessionId: 'one' }),
    ).resolves.toEqual({
      sessionId: 'global',
      cwd: '/global',
    });

    await hub.close();
  });

  it('announces ready communication endpoints after their sessions register', async () => {
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never });
    const parentCommunication = hub.sessionService.bindCommunication!('parent');
    const childCommunication = hub.sessionService.bindCommunication!('child');
    const parentReady = vi.fn();
    const childReady = vi.fn();
    parentCommunication.onPeerReady(parentReady);
    childCommunication.onPeerReady(childReady);

    hub.register({ id: 'parent', name: 'Parent', cwd: '/repo', createdAt: 'now', host: host().host });
    expect(parentReady).not.toHaveBeenCalled();
    hub.register({
      id: 'child',
      name: 'Child',
      cwd: '/repo/child',
      createdAt: 'now',
      parentSessionId: 'parent',
      host: host().host,
    });

    expect(parentReady).toHaveBeenCalledWith('child');
    expect(childReady).toHaveBeenCalledWith('parent');
    await hub.close();
  });

  it('does not reuse a session id while its shutdown is pending', async () => {
    const session = host();
    let resolveShutdown: (() => void) | undefined;
    let first = true;
    const closeSession = vi.fn(() => {
      if (!first) return Promise.resolve();
      first = false;
      return new Promise<void>((resolve) => {
        resolveShutdown = resolve;
      });
    });
    const hub = createHeadlessHub({ manager: { closeSession } as never });
    hub.register({ id: 'one', name: 'One', cwd: '/repo', createdAt: 'now', host: session.host });

    const closing = hub.closeSession('one');
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledWith('one'));
    expect(() =>
      hub.register({ id: 'one', name: 'Replacement', cwd: '/repo', createdAt: 'now', host: host().host }),
    ).toThrow('still shutting down');

    resolveShutdown!();
    await closing;
    hub.register({ id: 'one', name: 'Replacement', cwd: '/repo', createdAt: 'now', host: host().host });
    await hub.close();
  });

  it('waits for a shutdown already in flight when the hub closes', async () => {
    const session = host();
    let resolveShutdown: (() => void) | undefined;
    const closeSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        }),
    );
    const hub = createHeadlessHub({ manager: { closeSession } as never });
    hub.register({ id: 'one', name: 'One', cwd: '/repo', createdAt: 'now', host: session.host });

    const closing = hub.closeSession('one');
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledWith('one'));
    let settled = false;
    const hubClosing = hub.close().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveShutdown!();
    await closing;
    await hubClosing;
  });

  it('waits for an in-flight shutdown before a scoped retry resolves', async () => {
    const session = host();
    let resolveShutdown: (() => void) | undefined;
    const closeSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        }),
    );
    const hub = createHeadlessHub({ manager: { closeSession } as never });
    hub.register({ id: 'one', workspaceId: 'one', name: 'One', cwd: '/one', createdAt: 'now', host: session.host });
    let channelHost: Parameters<DoomHubChannel['start']>[0] | undefined;
    hub.registerChannel(
      {
        frameType: 'workspace-only',
        start(api) {
          channelHost = api;
          return { payloadFor: () => undefined, close: vi.fn() };
        },
      },
      { scope: 'workspace', workspaceId: 'one' },
    );

    session.exit();
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledWith('one'));
    let settled = false;
    const retry = channelHost!.sessionService!.close('one').then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveShutdown!();
    await retry;
    expect(settled).toBe(true);
    await hub.close();
  });

  it('keeps a failed shutdown failure for scoped retries', async () => {
    const session = host();
    const closeSession = vi.fn(async () => {
      throw new Error('cleanup unavailable');
    });
    const hub = createHeadlessHub({ manager: { closeSession } as never });
    hub.register({ id: 'one', workspaceId: 'one', name: 'One', cwd: '/one', createdAt: 'now', host: session.host });
    let channelHost: Parameters<DoomHubChannel['start']>[0] | undefined;
    hub.registerChannel(
      {
        frameType: 'workspace-only',
        start(api) {
          channelHost = api;
          return { payloadFor: () => undefined, close: vi.fn() };
        },
      },
      { scope: 'workspace', workspaceId: 'one' },
    );

    session.exit();
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledWith('one'));
    await expect(channelHost!.sessionService!.close('one')).rejects.toThrow('cleanup unavailable');
    await expect(channelHost!.sessionService!.close('one')).rejects.toThrow('cleanup unavailable');
    expect(closeSession).toHaveBeenCalledOnce();
    await hub.close();
  });

  it('publishes session summaries at state changes rather than every streamed token', () => {
    const session = host();
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never });
    const events: string[] = [];
    hub.onEvent((event) => events.push(event.kind));
    hub.register({ id: 'one', name: 'One', cwd: '/repo', createdAt: 'now', host: session.host });
    session.emitFrame({ type: 'agent_start' });
    for (let index = 0; index < 100; index += 1)
      session.emitFrame({ type: 'message_update', message: { role: 'assistant' } });
    session.emitFrame({ type: 'message_end', message: { role: 'assistant' } });
    session.emitFrame({ type: 'agent_settled' });

    expect(events).toEqual(['upsert', 'upsert', 'upsert', 'upsert']);
    expect(hub.snapshot()[0]?.phase).toBe('idle');
  });

  it('keeps workspace APIs alive without sessions and isolates equal package paths', async () => {
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn() } as never });
    const closed: string[] = [];
    const facet: DoomServerFacet = {
      inject: [DOOM_SERVER_HOST_SERVICE],
      apply(context) {
        const server = requireDoomServerHost(context);
        const registration = server.registerApi({
          basePath: 'example',
          start: (apiContext) => ({
            fetch: () => Response.json({ owner: apiContext.workspaceId ?? apiContext.scope }),
            close: () => {
              closed.push(apiContext.workspaceId ?? apiContext.scope);
            },
          }),
        });
        return () => registration.dispose();
      },
    };
    await hub.mountFacets([facet]);
    for (const id of ['one', 'two'])
      await hub.mountFacets([facet], {
        scope: 'workspace',
        workspaceId: id,
        workspaceRoot: `/${id}`,
        onNotice: vi.fn(),
      });
    const request = new Request('http://test/');
    expect(await (await hub.requestApi({ scope: 'global' }, 'example', request)).json()).toEqual({ owner: 'global' });
    expect(await (await hub.requestApi({ scope: 'workspace', workspaceId: 'two' }, 'example', request)).json()).toEqual(
      { owner: 'two' },
    );
    expect((await hub.requestApi({ scope: 'workspace', workspaceId: 'missing' }, 'example', request)).status).toBe(404);
    const session = host();
    hub.register({ id: 'session', workspaceId: 'one', name: 'One', cwd: '/one', createdAt: 'now', host: session.host });
    await expect(hub.removeWorkspace('one')).rejects.toThrow('live sessions');
    await hub.closeSession('session');
    expect(hub.workspaces()).toHaveLength(2);
    await hub.removeWorkspace('one');
    expect(closed).toEqual(['one']);
    await hub.close();
    expect(closed.sort()).toEqual(['global', 'one', 'two']);
  });

  it('isolates identical workspace channels and chooses the nearest mounted scope', async () => {
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn() } as never });
    for (const id of ['one', 'two'])
      hub.register({ id, workspaceId: id, name: id, cwd: `/${id}`, createdAt: 'now', host: host().host });
    const received: string[] = [];
    const channel = (owner: string): DoomHubChannel => ({
      frameType: 'shared',
      receive: (scope) => {
        received.push(`${owner}:${scope.sessionId}`);
      },
      start: (channelHost) => ({
        payloadFor: () => ({ owner, sessions: channelHost.sessions().map((session) => session.sessionId) }),
        close: vi.fn(),
      }),
    });
    hub.registerChannel(channel('global'));
    hub.registerChannel(channel('workspace-one'), { scope: 'workspace', workspaceId: 'one' });
    hub.registerChannel(channel('workspace-two'), { scope: 'workspace', workspaceId: 'two' });
    expect(hub.channelFrames('one')[0]?.payload).toEqual({ owner: 'workspace-one', sessions: ['one'] });
    hub.receiveChannel('two', 'shared', {}, 'client');
    expect(received).toEqual(['workspace-two:two']);
    hub.registerChannel(channel('session-one'), { scope: 'session', sessionId: 'one' });
    expect(hub.channelFrames('one')[0]?.payload).toEqual({ owner: 'session-one', sessions: ['one'] });
    await hub.close();
  });

  it('hands a session to the narrowest channel mount and back when it is released', async () => {
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn() } as never });
    const lifecycle: string[] = [];
    const channel = (owner: string): DoomHubChannel => ({
      frameType: 'shared',
      start: (channelHost) => ({
        payloadFor: () => undefined,
        sessionAdded: (scope) => lifecycle.push(`${owner}:added:${scope.sessionId}`),
        sessionRemoved: (sessionId) => lifecycle.push(`${owner}:removed:${sessionId}`),
        close: () => lifecycle.push(`${owner}:closed:${channelHost.sessions().length}`),
      }),
    });

    hub.registerChannel(channel('global'));
    hub.register({ id: 'one', workspaceId: 'ws', name: 'One', cwd: '/ws', createdAt: 'now', host: host().host });
    expect(lifecycle).toEqual(['global:added:one']);

    const releaseWorkspace = hub.registerChannel(channel('workspace'), { scope: 'workspace', workspaceId: 'ws' });
    expect(lifecycle).toEqual(['global:added:one', 'global:removed:one', 'workspace:added:one']);

    releaseWorkspace();
    expect(lifecycle.slice(3)).toEqual(['workspace:closed:1', 'global:added:one']);
    await hub.close();
  });

  it('keeps a shadowed channel out of the session it no longer serves', async () => {
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn() } as never });
    hub.register({ id: 'one', workspaceId: 'ws', name: 'One', cwd: '/ws', createdAt: 'now', host: host().host });
    const seen = new Map<string, () => readonly { sessionId: string }[]>();
    const channel = (owner: string): DoomHubChannel => ({
      frameType: 'shared',
      start: (channelHost) => {
        seen.set(owner, () => channelHost.sessions());
        return { payloadFor: () => ({ owner }), close: vi.fn() };
      },
    });

    hub.registerChannel(channel('global'));
    hub.registerChannel(channel('workspace'), { scope: 'workspace', workspaceId: 'ws' });

    expect(
      seen
        .get('workspace')?.()
        .map((scope) => scope.sessionId),
    ).toEqual(['one']);
    expect(seen.get('global')?.()).toEqual([]);
    await hub.close();
  });

  it('authenticates a channel-owned session API call as the hub', async () => {
    const requests: Array<Record<string, string>> = [];
    const hub = createHeadlessHub({
      manager: { closeSession: vi.fn() } as never,
      hubToken: () => 'hub-token',
      requestSessionApi: (_scope, request) => {
        requests.push(Object.fromEntries(new Headers(request.headers).entries()));
        return Promise.resolve(Response.json({ ok: true }));
      },
    });
    hub.register({ id: 'one', name: 'One', cwd: '/repo', createdAt: 'now', host: host().host });
    let call: ((headers?: Record<string, string>) => Promise<Response>) | undefined;
    hub.registerChannel({
      frameType: 'calls',
      start: (channelHost) => {
        call = (headers) =>
          channelHost.requestSessionApi(
            { sessionId: 'one', cwd: '/repo' },
            { basePath: 'runner', path: '/hub/state', method: 'GET', ...(headers === undefined ? {} : { headers }) },
          );
        return { payloadFor: () => undefined, close: vi.fn() };
      },
    });

    await call?.();
    expect(requests[0]?.authorization).toBe('Bearer hub-token');

    await call?.({ authorization: 'Bearer caller-token' });
    expect(requests[1]?.authorization).toBe('Bearer caller-token');

    // A browser call reaches the same session API through requestApi and keeps its own headers.
    await hub.requestApi(
      { scope: 'session', sessionId: 'one' },
      'runner',
      new Request('http://doompi.local/hub/state'),
    );
    expect(requests[2]?.authorization).toBeUndefined();
    await hub.close();
  });

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
