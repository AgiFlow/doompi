import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorktreeSession,
  HubUnavailableError,
  readHubAdvertisement,
  sessionIsLive,
  stopWorktreeSession,
} from '../../../../src/adapters/hub/hubClient.ts';

const HUB_URL = 'http://127.0.0.1:4300';

let registryDir: string;

interface CapturedRequest {
  url: string;
  body: string | undefined;
}

const requests: CapturedRequest[] = [];

/** Answers the two routes the client speaks, with no socket involved. */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      requests.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      return Promise.resolve(handler(url, init));
    }),
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function healthyHub(onSessions: (init: RequestInit | undefined) => Response): void {
  stubFetch((url, init) => {
    if (url.endsWith('/api/health')) return json(200, { ok: true, role: 'hub' });
    return onSessions(init);
  });
}

function advertise(body: unknown): void {
  fs.writeFileSync(path.join(registryDir, 'hub.json'), typeof body === 'string' ? body : JSON.stringify(body));
}

function input() {
  return {
    cwd: '/wt/repo--abc/wt-fix-auth--1234',
    name: 'fix auth',
    parentSessionId: 'parent-1',
    registryDir,
  };
}

function sessionsBody(): Record<string, unknown> {
  const posted = requests.find((request) => request.url.endsWith('/api/sessions'));
  return JSON.parse(posted?.body ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-hub-'));
  requests.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(registryDir, { recursive: true, force: true });
});

describe('readHubAdvertisement', () => {
  it('returns undefined when the hub never published an address', () => {
    expect(readHubAdvertisement(registryDir)).toBeUndefined();
  });

  it('returns undefined for a malformed advertisement rather than throwing', () => {
    for (const body of ['{"version": 1, "url"', 'null', { version: 99, url: HUB_URL, pid: 10 }]) {
      advertise(body);
      expect(readHubAdvertisement(registryDir)).toBeUndefined();
    }
  });

  it('returns the published address when it is well formed', () => {
    advertise({ version: 1, url: HUB_URL, pid: 4242 });
    expect(readHubAdvertisement(registryDir)).toEqual({ version: 1, url: HUB_URL, pid: 4242 });
  });
});

describe('createWorktreeSession', () => {
  it('refuses when no cockpit ever advertised', async () => {
    await expect(createWorktreeSession(input())).rejects.toThrow(HubUnavailableError);
    await expect(createWorktreeSession(input())).rejects.toThrow(/No cockpit is running/u);
  });

  it('refuses when the advertised address does not answer', async () => {
    // The advertisement outlives a crash, so finding one proves nothing.
    advertise({ version: 1, url: HUB_URL, pid: 4242 });
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(createWorktreeSession(input())).rejects.toThrow(/no longer answering/u);
  });

  it('refuses when the probe answers with a failure status', async () => {
    advertise({ version: 1, url: HUB_URL, pid: 4242 });
    stubFetch(() => json(503, { ok: false }));
    await expect(createWorktreeSession(input())).rejects.toThrow(/no longer answering/u);
  });

  it('refuses when something that is not a hub answers the port', async () => {
    advertise({ version: 1, url: HUB_URL, pid: 4242 });
    stubFetch(() => json(200, { ok: true, role: 'session' }));
    await expect(createWorktreeSession(input())).rejects.toThrow(
      `The cockpit that advertised ${HUB_URL} is no longer answering. Start it and try again.`,
    );
  });

  it('refuses when the probe answers with something that is not JSON', async () => {
    advertise({ version: 1, url: HUB_URL, pid: 4242 });
    stubFetch(() => new Response('<html>not a hub</html>', { status: 200 }));
    await expect(createWorktreeSession(input())).rejects.toThrow(/no longer answering/u);
  });

  it('reports the transport failure when the create call itself cannot be sent', async () => {
    advertise({ version: 1, url: HUB_URL, pid: 4242 });
    healthyHub(() => {
      throw new Error('socket hang up');
    });
    await expect(createWorktreeSession(input())).rejects.toThrow(/Could not reach the cockpit: socket hang up/u);
  });

  it("carries the server's own error text when the cockpit refuses", async () => {
    advertise({ version: 1, url: HUB_URL, pid: 4242 });
    healthyHub(() => json(400, { error: 'cwd is not a directory' }));
    await expect(createWorktreeSession(input())).rejects.toThrow('cwd is not a directory');
  });

  it('names the status when a refusal carries no readable body', async () => {
    advertise({ version: 1, url: HUB_URL, pid: 4242 });
    healthyHub(() => new Response('boom', { status: 500 }));
    await expect(createWorktreeSession(input())).rejects.toThrow(/refused the session \(500\)/u);
  });

  it('refuses when the cockpit accepts but names no session', async () => {
    advertise({ version: 1, url: HUB_URL, pid: 4242 });
    healthyHub(() => json(201, {}));
    await expect(createWorktreeSession(input())).rejects.toThrow(/did not name it/u);

    healthyHub(() => json(201, { sessionId: '' }));
    await expect(createWorktreeSession(input())).rejects.toThrow(/did not name it/u);
  });

  it('returns the session id and posts the lineage the rail needs', async () => {
    advertise({ version: 1, url: HUB_URL, pid: 4242 });
    healthyHub(() => json(201, { sessionId: 'session-9' }));

    await expect(createWorktreeSession(input())).resolves.toBe('session-9');
    expect(sessionsBody()).toEqual({
      cwd: '/wt/repo--abc/wt-fix-auth--1234',
      name: 'fix auth',
      parentSessionId: 'parent-1',
      provenance: 'worktree',
    });
  });
});

describe('sessionIsLive', () => {
  it('is false when the session server left no record', () => {
    expect(sessionIsLive(registryDir, 'session-9')).toBe(false);
  });

  it('is true while the record the session server writes is present', () => {
    fs.mkdirSync(path.join(registryDir, 'sessions'), { recursive: true });
    const record = path.join(registryDir, 'sessions', 'session-9.json');
    fs.writeFileSync(record, JSON.stringify({ id: 'session-9' }));

    expect(sessionIsLive(registryDir, 'session-9')).toBe(true);
    expect(sessionIsLive(registryDir, 'session-other')).toBe(false);

    fs.rmSync(record);
    expect(sessionIsLive(registryDir, 'session-9')).toBe(false);
  });
});

describe('stopWorktreeSession', () => {
  it('does nothing when no cockpit ever advertised', async () => {
    stubFetch(() => json(200, {}));
    await expect(stopWorktreeSession(registryDir, 'session-9')).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it('does nothing when the advertised address no longer answers', async () => {
    advertise({ version: 1, url: HUB_URL, pid: 4242 });
    stubFetch(() => json(503, { ok: false }));

    await expect(stopWorktreeSession(registryDir, 'session-9')).resolves.toBeUndefined();
    expect(requests.map((request) => request.url)).toEqual([`${HUB_URL}/api/health`]);
  });

  it('deletes the session on the hub that answered, escaping the id', async () => {
    advertise({ version: 1, url: HUB_URL, pid: 4242 });
    healthyHub(() => json(200, { ok: true }));

    await expect(stopWorktreeSession(registryDir, 'session/9 a')).resolves.toBeUndefined();

    const deletes = requests.filter((request) => !request.url.endsWith('/api/health'));
    expect(deletes.map((request) => request.url)).toEqual([`${HUB_URL}/api/sessions/session%2F9%20a`]);
  });

  it('treats a 404 as success, because an unknown session is already stopped', async () => {
    advertise({ version: 1, url: HUB_URL, pid: 4242 });
    healthyHub(() => json(404, { error: 'no such session' }));

    await expect(stopWorktreeSession(registryDir, 'session-9')).resolves.toBeUndefined();
  });

  it("carries the server's own error text when the cockpit fails to stop it", async () => {
    advertise({ version: 1, url: HUB_URL, pid: 4242 });
    healthyHub(() => json(500, { error: 'session refused to stop' }));

    await expect(stopWorktreeSession(registryDir, 'session-9')).rejects.toThrow(HubUnavailableError);
    await expect(stopWorktreeSession(registryDir, 'session-9')).rejects.toThrow('session refused to stop');
  });

  it('names the status when the failure carries no readable body', async () => {
    advertise({ version: 1, url: HUB_URL, pid: 4242 });
    healthyHub(() => new Response('boom', { status: 500 }));

    await expect(stopWorktreeSession(registryDir, 'session-9')).rejects.toThrow(/could not stop the session \(500\)/u);
  });

  it('reports the transport failure when the delete cannot be sent', async () => {
    advertise({ version: 1, url: HUB_URL, pid: 4242 });
    healthyHub(() => {
      throw new Error('socket hang up');
    });

    await expect(stopWorktreeSession(registryDir, 'session-9')).rejects.toThrow(HubUnavailableError);
    await expect(stopWorktreeSession(registryDir, 'session-9')).rejects.toThrow(
      /Could not reach the cockpit: socket hang up/u,
    );
  });
});
