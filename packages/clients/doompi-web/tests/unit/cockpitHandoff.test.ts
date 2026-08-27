import { beforeEach, describe, expect, it } from 'vitest';
import { handOffRemoteAccess } from '../../src/adapters/cockpitHandoff.ts';
import { relaunchSessions } from '../../src/adapters/sessionRelaunch.ts';
import { DEFAULT_REMOTE_SETTINGS } from '../../src/services/remoteAccessSettings.ts';
import type { RemoteAccessSettings } from '../../src/types/remoteAccess.ts';

const PORT = 4173;
const OK = 200;
const ACCEPTED = 202;
const CONFLICT = 409;
const CREATED = 201;

let calls: { url: string; method: string; body: string }[];
let notices: string[];

const settings: RemoteAccessSettings = {
  ...DEFAULT_REMOTE_SETTINGS,
  sandbox: { enabled: true, workspaces: ['/repo'] },
};

/** Answers each call in order, so a test can make the second one fail. */
function replies(...answers: { status: number; text: string }[]) {
  return async (url: string, method: string, body: string) => {
    calls.push({ url, method, body });
    return answers[calls.length - 1] ?? { status: OK, text: '{}' };
  };
}

beforeEach(() => {
  calls = [];
  notices = [];
});

describe('handing remote access to the cockpit that took over', () => {
  it('stores the settings, then turns remote access on', async () => {
    const done = await handOffRemoteAccess({
      port: PORT,
      settings,
      send: replies({ status: OK, text: '{}' }, { status: OK, text: '{}' }),
      onNotice: (message) => notices.push(message),
    });
    expect(done).toBe(true);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `PUT http://127.0.0.1:${String(PORT)}/api/remote/settings`,
      `POST http://127.0.0.1:${String(PORT)}/api/remote/enable`,
    ]);
  });

  it('sends the sandbox flag as it is, so the container reports how it is running', async () => {
    await handOffRemoteAccess({ port: PORT, settings, send: replies() });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ sandbox: { enabled: true, workspaces: ['/repo'] } });
  });

  it('accepts the deferred answer the enable route gives a contained cockpit', async () => {
    const done = await handOffRemoteAccess({
      port: PORT,
      settings,
      send: replies({ status: OK, text: '{}' }, { status: ACCEPTED, text: '{}' }),
    });
    expect(done).toBe(true);
  });

  it('stops after settings that would not store, rather than enabling with the wrong ones', async () => {
    const done = await handOffRemoteAccess({
      port: PORT,
      settings,
      send: replies({ status: CONFLICT, text: 'nope' }),
      onNotice: (message) => notices.push(message),
    });
    expect(done).toBe(false);
    expect(calls).toHaveLength(1);
    expect(notices[0]).toContain('nope');
  });

  it('reports an enable the container refused', async () => {
    const done = await handOffRemoteAccess({
      port: PORT,
      settings,
      send: replies({ status: OK, text: '{}' }, { status: CONFLICT, text: 'no cloudflared' }),
      onNotice: (message) => notices.push(message),
    });
    expect(done).toBe(false);
    expect(notices[0]).toContain('no cloudflared');
  });

  it('reports an unreachable container rather than looping on it', async () => {
    const done = await handOffRemoteAccess({
      port: PORT,
      settings,
      send: async () => {
        throw new Error('ECONNREFUSED');
      },
      onNotice: (message) => notices.push(message),
    });
    expect(done).toBe(false);
    expect(notices[0]).toContain('ECONNREFUSED');
  });

  it('needs no notice channel, which is how a launcher without one builds it', async () => {
    expect(
      await handOffRemoteAccess({
        port: PORT,
        settings,
        send: replies({ status: CONFLICT, text: 'nope' }),
      }),
    ).toBe(false);
  });

  it('can be pointed at a host other than loopback, for a rollback to the host cockpit', async () => {
    await handOffRemoteAccess({ port: PORT, host: '0.0.0.0', settings, send: replies() });
    expect(calls[0]?.url.startsWith('http://0.0.0.0:')).toBe(true);
  });
});

describe('recreating the sessions on the other side', () => {
  it('asks for each session in turn, carrying its directory and name', async () => {
    const posts: { url: string; body: string }[] = [];
    const recreated = await relaunchSessions({
      port: PORT,
      sessions: [
        { id: 'a', cwd: '/repo', name: 'api' },
        { id: 'b', cwd: '/repo/web' },
      ],
      post: async (url, body) => {
        posts.push({ url, body });
        return { status: CREATED, text: '{}' };
      },
      onNotice: (message) => notices.push(message),
    });
    expect(recreated).toBe(2);
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[0]?.body ?? '{}')).toEqual({ cwd: '/repo', name: 'api' });
    // No name means none is sent, rather than an empty one the hub would reject.
    expect(JSON.parse(posts[1]?.body ?? '{}')).toEqual({ cwd: '/repo/web' });
  });

  it('has nothing to do for a cockpit with no sessions', async () => {
    expect(
      await relaunchSessions({
        port: PORT,
        sessions: [],
        post: async () => {
          throw new Error('should not be called');
        },
      }),
    ).toBe(0);
  });

  it('reports a session the container refused, because the host copy is already stopped', async () => {
    const recreated = await relaunchSessions({
      port: PORT,
      sessions: [{ id: 'a', cwd: '/outside' }],
      post: async () => ({ status: CONFLICT, text: 'no such directory' }),
      onNotice: (message) => notices.push(message),
    });
    expect(recreated).toBe(0);
    expect(notices[0]).toContain('no such directory');
  });

  it('keeps going after one session fails, so the rest still come back', async () => {
    let seen = 0;
    const recreated = await relaunchSessions({
      port: PORT,
      sessions: [
        { id: 'a', cwd: '/repo' },
        { id: 'b', cwd: '/repo/web' },
      ],
      post: async () => {
        seen += 1;
        if (seen === 1) throw new Error('timed out');
        return { status: CREATED, text: '{}' };
      },
      onNotice: (message) => notices.push(message),
    });
    expect(recreated).toBe(1);
    expect(notices[0]).toContain('timed out');
  });

  it('needs no notice channel either', async () => {
    expect(
      await relaunchSessions({
        port: PORT,
        sessions: [{ id: 'a', cwd: '/repo' }],
        post: async () => ({ status: CONFLICT, text: 'no' }),
      }),
    ).toBe(0);
  });

  it('names a session by its directory when it has no name', async () => {
    await relaunchSessions({
      port: PORT,
      sessions: [{ id: 'a', cwd: '/repo/web' }],
      post: async () => ({ status: CREATED, text: '{}' }),
      onNotice: (message) => notices.push(message),
    });
    expect(notices[0]).toContain('/repo/web');
  });
});
