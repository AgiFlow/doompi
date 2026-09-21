import { bindSessionApiWorkspace } from '@agimon-ai/doompi-core/web';
import { beforeEach as beforeEachApiRoutes } from 'vitest';
beforeEachApiRoutes(() => bindSessionApiWorkspace(() => 'test-workspace'));
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  admitWorkspace,
  createSession,
  createWorkspaceSession,
  listSessionHistory,
  listWorkspaceHistory,
  listWorkspaces,
  readDormantTranscriptPage,
  removeWorkspace,
  restartSession,
  resumeSession,
  resumeWorkspaceSession,
  reviveSession,
  searchDirectories,
} from '../../src/web/lib/hubApi';

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workspace sessions', () => {
  it('lists and admits durable workspaces without creating a session', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(200, { workspaces: [{ id: 'one', root: '/one', available: true }] }))
      .mockResolvedValueOnce(respond(201, { workspace: { id: 'two', root: '/two', available: true } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listWorkspaces()).resolves.toEqual({
      workspaces: [{ id: 'one', root: '/one', available: true }],
    });
    await expect(admitWorkspace('/two')).resolves.toEqual({
      workspace: { id: 'two', root: '/two', available: true },
    });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: '/two' }),
    });
  });

  it('unregisters a workspace through its workspace route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(removeWorkspace('one/two')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/one%2Ftwo', { method: 'DELETE' });
  });

  it('relays workspace removal errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(409, { error: 'Workspace still has sessions.' })));

    await expect(removeWorkspace('one')).resolves.toEqual({ error: 'Workspace still has sessions.' });
  });

  it('creates directly in an admitted workspace', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(201, { sessionId: 'fresh' }))
      .mockResolvedValueOnce(respond(200, { id: 'fresh' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createWorkspaceSession('one/two', { name: 'work' })).resolves.toEqual({
      sessionId: 'fresh',
      session: { id: 'fresh' },
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/one%2Ftwo/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'work' }),
    });
  });

  it('lists and resumes workspace history without a live replacement session', async () => {
    const thread = {
      id: 'saved',
      firstMessage: 'continue',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      messageCount: 2,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(200, { sessions: [thread] }))
      .mockResolvedValueOnce(respond(200, { sessionId: 'saved' }))
      .mockResolvedValueOnce(respond(200, { id: 'saved' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listWorkspaceHistory('one/two')).resolves.toEqual({ sessions: [thread] });
    await expect(resumeWorkspaceSession('one/two', 'saved')).resolves.toEqual({
      sessionId: 'saved',
      session: { id: 'saved' },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/workspaces/one%2Ftwo/history', undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/workspaces/one%2Ftwo/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSessionId: 'saved' }),
    });
  });
});

describe('createSession', () => {
  it('posts the request and returns the new session id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(201, { workspace: { id: 'test-workspace', root: '/workspace/x' } }))
      .mockResolvedValueOnce(respond(201, { sessionId: 'fresh' }))
      .mockResolvedValueOnce(respond(200, { id: 'fresh' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createSession({ cwd: '/workspace/x', name: 'x' })).resolves.toEqual({
      sessionId: 'fresh',
      session: { id: 'fresh' },
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/test-workspace/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/test-workspace/sessions/fresh', undefined);
  });

  it('relays the hub error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(400, { error: 'A cwd string is required.' })));
    await expect(createSession({ cwd: '' })).resolves.toEqual({ error: 'A cwd string is required.' });
  });

  it('falls back to the status code when the body is not helpful', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 502 })));
    await expect(createSession({ cwd: '/x' })).resolves.toEqual({ error: 'The hub answered 502.' });
  });

  it('reports an unreachable hub instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    await expect(createSession({ cwd: '/x' })).resolves.toEqual({ error: 'The cockpit hub is unreachable.' });
  });
});

describe('restartSession', () => {
  it('posts to the session’s restart route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(202, { sessionId: 'live' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(restartSession('live')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/test-workspace/sessions/live/restart', { method: 'POST' });
  });

  it('escapes an id that would otherwise change the path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(202, {}));
    vi.stubGlobal('fetch', fetchMock);

    await restartSession('a/../b');
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/test-workspace/sessions/a%2F..%2Fb/restart', {
      method: 'POST',
    });
  });

  it('relays the hub error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(502, { error: 'The session did not stop in time.' })));
    await expect(restartSession('live')).resolves.toEqual({ error: 'The session did not stop in time.' });
  });

  it('reports an unreachable hub instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    await expect(restartSession('live')).resolves.toEqual({ error: 'The cockpit hub is unreachable.' });
  });
});

describe('reviveSession', () => {
  it('posts to the session’s revive route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(202, { sessionId: 'dormant' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reviveSession('dormant')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/test-workspace/sessions/dormant/revive', {
      method: 'POST',
    });
  });

  it('relays the hub error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(409, { error: 'That session is already open.' })));
    await expect(reviveSession('dormant')).resolves.toEqual({ error: 'That session is already open.' });
  });

  it('falls back to the status code when the body is not helpful', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await expect(reviveSession('dormant')).resolves.toEqual({ error: 'The hub answered 500.' });
  });

  it('reports an unreachable hub instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    await expect(reviveSession('dormant')).resolves.toEqual({ error: 'The cockpit hub is unreachable.' });
  });
});

describe('readDormantTranscriptPage', () => {
  it('requests a scoped read-only page with paging and cancellation', async () => {
    const page = {
      entries: [],
      startCursor: null,
      endCursor: null,
      olderCursor: null,
      newerCursor: null,
      generation: 0,
      revision: 0,
      context: [],
      drafts: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(respond(200, page));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;

    await expect(
      readDormantTranscriptPage('dormant', { cursor: 'older', direction: 'older', limit: 10 }, signal),
    ).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/test-workspace/sessions/dormant/transcript?cursor=older&direction=older&limit=10',
      { signal },
    );
  });
});
describe('Pi session history', () => {
  it('lists valid history rows for the selected live session', async () => {
    const thread = {
      id: 'history-id',
      name: 'Earlier work',
      firstMessage: 'Fix the gate',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      messageCount: 4,
    };
    const unnamed = { ...thread, id: 'unnamed', name: undefined };
    const fetchMock = vi.fn().mockResolvedValue(
      respond(200, {
        sessions: [
          thread,
          unnamed,
          { ...thread, id: 7 },
          { ...thread, name: 7 },
          { ...thread, firstMessage: 7 },
          { ...thread, createdAt: 7 },
          { ...thread, updatedAt: 7 },
          { ...thread, messageCount: '4' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listSessionHistory('live')).resolves.toEqual({ sessions: [thread, unnamed] });
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/test-workspace/sessions/live/history', undefined);
  });

  it('reports history errors and an unreachable hub', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(500, { error: 'History is unavailable.' })));
    await expect(listSessionHistory('live')).resolves.toEqual({ error: 'History is unavailable.' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(502, {})));
    await expect(listSessionHistory('live')).resolves.toEqual({ error: 'The hub answered 502.' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    await expect(listSessionHistory('live')).resolves.toEqual({ error: 'The cockpit hub is unreachable.' });
  });
  it('posts the selected thread when resuming', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(202, { sessionId: 'history-id' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resumeSession('live', 'history-id')).resolves.toEqual({ sessionId: 'history-id' });
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/test-workspace/sessions/live/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSessionId: 'history-id' }),
    });
  });

  it('reports resume errors and an unreachable hub', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(409, { error: 'That Pi thread is already running.' })));
    await expect(resumeSession('live', 'busy')).resolves.toEqual({ error: 'That Pi thread is already running.' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(502, {})));
    await expect(resumeSession('live', 'history-id')).resolves.toEqual({ error: 'The hub answered 502.' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    await expect(resumeSession('live', 'history-id')).resolves.toEqual({ error: 'The cockpit hub is unreachable.' });
  });
});
describe('searchDirectories', () => {
  it('asks the hub for the typed path and keeps only string entries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { directories: ['/work/app', 7, '/work/lib'] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchDirectories('/work/^')).resolves.toEqual(['/work/app', '/work/lib']);
    expect(fetchMock).toHaveBeenCalledWith('/api/directories?q=%2Fwork%2F%5E', undefined);
  });

  it('shows nothing when the hub declines or is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await expect(searchDirectories('/x')).resolves.toEqual([]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    await expect(searchDirectories('/x')).resolves.toEqual([]);
  });
});
