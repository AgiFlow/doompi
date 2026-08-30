import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DOOM_NOTIFICATION_ENTRY_TYPE } from '@agimon-ai/doompi-extension-contracts/notification';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serveWeb } from '../../src/adapters/httpServer.ts';
import type { WebServer } from '../../src/types/bridge.ts';
import type { SessionSummary } from '../../src/types/hub.ts';
import { type FakeSession, startFakeSession } from '../support/fakeSession.ts';

vi.mock('../../src/adapters/syncGuard.ts', () => ({
  createSyncGuard: () => ({
    ensureSynced: async () => undefined,
    watch: () => undefined,
    close: () => undefined,
  }),
}));
type Frame = Record<string, unknown>;

/** The one session these specs register; the routes address it by id. */
const SESSION = 'bridged';

let running: Array<{ server: WebServer; session: FakeSession; registryDir: string }> = [];

afterEach(async () => {
  for (const { server, session, registryDir } of running) {
    await server.close();
    await session.close();
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
  running = [];
}, 30_000);

async function bridge(overrides: { token?: string } = {}): Promise<{ session: FakeSession; server: WebServer }> {
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-bridge-'));
  // The session claims this package as its working directory, a real
  // repository, so the file completion and mention routes have something to
  // list. A wrong token goes into the file the record names, because that is
  // the only place the hub reads one from.
  const session = await startFakeSession({ id: SESSION, registryDir, cwd: process.cwd() });
  if (overrides.token !== undefined) fs.writeFileSync(session.tokenFile, overrides.token, { mode: 0o600 });
  const server = await serveWeb({
    registryDir,
    spawnCommand: path.join(registryDir, 'no-such-server'),
    port: 0,
    assetsDir: '/nonexistent-assets',
    remoteStateDir: path.join(registryDir, 'remote-state'),
  });
  const pair = { server, session, registryDir };
  running.push(pair);
  return pair;
}

function openSocket(url: string): Promise<{ socket: WebSocket; frames: Frame[] }> {
  const socket = new WebSocket(`${url.replace('http', 'ws')}/api/session`);
  const frames: Frame[] = [];
  socket.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data === 'string') frames.push(JSON.parse(event.data) as Frame);
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve({ socket, frames }));
    socket.addEventListener('error', () => reject(new Error('The hub socket refused the browser.')));
  });
}

const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** The latest summary the page has seen for a session, across snapshot and upserts. */
function latestSummary(frames: readonly Frame[], sessionId: string): SessionSummary | undefined {
  let found: SessionSummary | undefined;
  for (const frame of frames) {
    if (frame.type === 'sessions_snapshot' && Array.isArray(frame.sessions)) {
      const inSnapshot = (frame.sessions as SessionSummary[]).find((summary) => summary.id === sessionId);
      if (inSnapshot) found = inSnapshot;
    }
    if (frame.type === 'session_upsert') {
      const summary = frame.session as SessionSummary;
      if (summary.id === sessionId) found = summary;
    }
  }
  return found;
}

function subscribe(socket: WebSocket, sessionId: string): void {
  socket.send(JSON.stringify({ type: 'subscribe', sessionId }));
}

function command(socket: WebSocket, sessionId: string, frame: Frame): void {
  socket.send(JSON.stringify({ type: 'session_command', sessionId, frame }));
}

const sessionFrames = (frames: readonly Frame[]): Frame[] =>
  frames.filter((frame) => frame.type === 'session_frame').map((frame) => frame.frame as Frame);

const backlogFrames = (frames: readonly Frame[]): Frame[] => {
  const backlog = frames.find((frame) => frame.type === 'session_backlog');
  return (backlog?.frames as Frame[] | undefined) ?? [];
};

describe('the hub bridge', () => {
  it('answers a health probe with its role', async () => {
    const { server } = await bridge();
    const response = await fetch(`${server.url}/api/health`);
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({ ok: true, role: 'hub', protocol: 1, sessions: 1 });
  });

  it('validates a create request before it reaches the spawner', async () => {
    const { server } = await bridge();

    const badBody = await fetch(`${server.url}/api/sessions`, { method: 'POST', body: 'not json' });
    expect(badBody.status).toBe(400);

    const noCwd = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(noCwd.status).toBe(400);
    expect(await noCwd.json()).toMatchObject({ error: expect.stringMatching(/cwd/) as string });

    const missingDirectory = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: '/no/such/directory' }),
    });
    expect(missingDirectory.status).toBe(400);
    expect(await missingDirectory.json()).toMatchObject({
      error: expect.stringMatching(/No such directory/) as string,
    });
  });

  it('answers a restart for an unknown session with 404 rather than starting anything', async () => {
    const { server } = await bridge();
    const response = await fetch(`${server.url}/api/sessions/nope/restart`, { method: 'POST' });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/Unknown session/) as string });
  });

  it('answers file completion queries scoped to a known session', async () => {
    const { server } = await bridge();
    // The registered session names this package as its cwd: a real repository
    // for git-backed listing.
    const hit = await fetch(`${server.url}/api/sessions/${SESSION}/files?q=composer`);
    expect(hit.ok).toBe(true);
    const body = (await hit.json()) as { files: string[] };
    expect(body.files.length).toBeGreaterThan(0);
    expect(body.files.some((file) => file.toLowerCase().includes('composer'))).toBe(true);
    expect(body.files.length).toBeLessThanOrEqual(20);

    const miss = await fetch(`${server.url}/api/sessions/unknown/files?q=x`);
    expect(miss.status).toBe(404);
  });

  it('serves a mentioned file from the session directory and refuses to leave it', async () => {
    const { server } = await bridge();
    const hit = await fetch(`${server.url}/api/sessions/${SESSION}/file?path=package.json`);
    expect(hit.status).toBe(200);
    expect(hit.headers.get('content-type')).toBe('application/octet-stream');
    expect(hit.headers.get('content-disposition')).toBe('attachment; filename="package.json"');
    expect(((await hit.json()) as { name: string }).name).toBe('@agimon-ai/doompi-web');

    const escape = await fetch(`${server.url}/api/sessions/${SESSION}/file?path=../../../package.json`);
    expect(escape.status).toBe(403);
    const absolute = await fetch(`${server.url}/api/sessions/${SESSION}/file?path=${encodeURIComponent('/etc/hosts')}`);
    expect(absolute.status).toBe(403);
    const directory = await fetch(`${server.url}/api/sessions/${SESSION}/file?path=src`);
    expect(directory.status).toBe(404);
    const missing = await fetch(`${server.url}/api/sessions/${SESSION}/file?path=no/such/file.png`);
    expect(missing.status).toBe(404);
    const unknown = await fetch(`${server.url}/api/sessions/unknown/file?path=package.json`);
    expect(unknown.status).toBe(404);
  });

  it('refuses to stop the session hosting the cockpit and knows no other', async () => {
    const { server } = await bridge();
    const self = await fetch(`${server.url}/api/sessions/${SESSION}`, { method: 'DELETE' });
    expect(self.status).toBe(409);
    const unknown = await fetch(`${server.url}/api/sessions/unknown`, { method: 'DELETE' });
    expect(unknown.status).toBe(404);
  });

  it('explains itself when the bundle is missing instead of serving a blank page', async () => {
    const { server } = await bridge();
    const response = await fetch(server.url);
    expect(response.status).toBe(500);
    expect(await response.text()).toMatch(/bundle is missing/);
  });

  it('greets a page with the protocol and the session set', async () => {
    const { server, session } = await bridge();
    const { frames } = await openSocket(server.url);

    await waitFor(() => frames.length >= 2, 'the hello and snapshot');
    // Zero channels: every data source is a plugin, and plugins arrive via a
    // synced bundle's server registry; this server runs on a bare assets dir.
    expect(frames[0]).toEqual({ type: 'hub_hello', protocol: 1, channels: [] });
    expect(frames[1].type).toBe('sessions_snapshot');

    await session.waitForAttach();
    await waitFor(() => latestSummary(frames, SESSION)?.attach === 'attached', 'the attached summary');
  });

  it('never hands the browser the attach token', async () => {
    const { server, session } = await bridge();
    const { socket, frames } = await openSocket(server.url);

    await session.waitForAttach();
    subscribe(socket, SESSION);
    await waitFor(() => frames.some((frame) => frame.type === 'session_backlog'), 'the backlog');
    expect(JSON.stringify(frames)).not.toContain(session.token);
  });

  it('routes commands to the session and its events back to subscribers', async () => {
    const { server, session } = await bridge();
    const { socket, frames } = await openSocket(server.url);

    await session.waitForAttach();
    subscribe(socket, SESSION);
    command(socket, SESSION, { type: 'prompt', message: 'hello' });
    const received = await session.waitForCommand('prompt');
    expect(received.message).toBe('hello');

    session.emit({ type: 'agent_start' });
    await waitFor(() => sessionFrames(frames).some((frame) => frame.type === 'agent_start'), 'the agent_start event');
  });

  it('fans valid live notification entries out once to every page', async () => {
    const { server, session } = await bridge();
    const subscribed = await openSocket(server.url);
    const unsubscribed = await openSocket(server.url);
    await session.waitForAttach();
    subscribe(subscribed.socket, SESSION);
    await waitFor(() => subscribed.frames.some((frame) => frame.type === 'session_backlog'), 'the subscription');

    const notification = {
      type: 'entry_appended',
      entry: {
        id: 'notify-1',
        type: 'custom',
        customType: DOOM_NOTIFICATION_ENTRY_TYPE,
        data: { version: 1, title: 'Done', subtitle: '', body: 'Checks passed.', level: 'info' },
      },
    };
    session.emit(notification);
    await waitFor(() => sessionFrames(subscribed.frames).length === 1, 'the subscribed notification');
    await waitFor(() => sessionFrames(unsubscribed.frames).length === 1, 'the unsubscribed notification');
    expect(sessionFrames(subscribed.frames)).toEqual([notification]);
    expect(sessionFrames(unsubscribed.frames)).toEqual([notification]);

    session.emit({ ...notification, entry: { ...notification.entry, id: '' } });
    await waitFor(() => sessionFrames(subscribed.frames).length === 2, 'the invalid frame for the subscriber');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sessionFrames(unsubscribed.frames)).toHaveLength(1);
  });
  it('keeps frames from a page that did not subscribe', async () => {
    const { server, session } = await bridge();
    const { frames } = await openSocket(server.url);

    await session.waitForAttach();
    session.emit({ type: 'agent_start' });
    // The phase upsert still arrives; the raw frame does not.
    await waitFor(() => latestSummary(frames, SESSION)?.phase === 'turn', 'the phase upsert');
    expect(sessionFrames(frames)).toHaveLength(0);
  });

  it('refuses to let a page perform the handshake itself', async () => {
    const { server, session } = await bridge();
    const { socket } = await openSocket(server.url);

    await session.waitForAttach();
    command(socket, SESSION, { type: 'attach', token: 'stolen' });
    command(socket, SESSION, { type: 'abort' });

    await session.waitForCommand('abort');
    expect(session.received.some((frame) => frame.type === 'attach')).toBe(false);
  });

  it('ignores payloads that are not enveloped command objects', async () => {
    const { server, session } = await bridge();
    const { socket } = await openSocket(server.url);

    await session.waitForAttach();
    socket.send('not json');
    socket.send(JSON.stringify([1, 2]));
    // An un-enveloped command has no session address and goes nowhere.
    socket.send(JSON.stringify({ type: 'steer', message: 'lost' }));
    command(socket, SESSION, { type: 'abort' });

    await session.waitForCommand('abort');
    expect(session.received.some((frame) => frame.type === 'steer')).toBe(false);
  });

  it('reports a refusal in the session summary when the token is wrong', async () => {
    const { server } = await bridge({ token: 'wrong-token' });
    const { frames } = await openSocket(server.url);

    // The retry loop flips the live state back to connecting right away; the
    // page-side store is what keeps a refusal sticky. Seeing the refusal
    // upsert with its reason is the contract here.
    const refusal = (): Frame | undefined =>
      frames.find((frame) => frame.type === 'session_upsert' && (frame.session as SessionSummary).attach === 'refused');
    await waitFor(() => refusal() !== undefined, 'the refusal');
    const seen = refusal() as Frame;
    expect((seen.session as SessionSummary).attachReason).toMatch(/token was rejected/);
  });

  it('replays through its ring what the session buffered while the hub was detached', async () => {
    const { server, session } = await bridge();
    const { socket, frames } = await openSocket(server.url);
    await session.waitForAttach();
    subscribe(socket, SESSION);

    session.dropClient();
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'agent_settled' });

    // The hub reattaches on its own; the session's backlog reaches the page as
    // replay-wrapped session frames.
    await waitFor(
      () => sessionFrames(frames).filter((frame) => frame.type === 'replay').length >= 2,
      'the replayed frames after the hub reattached',
    );
  });

  it('hands a late page the history it missed', { timeout: 15_000 }, async () => {
    const { server, session } = await bridge();
    const first = await openSocket(server.url);
    await session.waitForAttach();
    subscribe(first.socket, SESSION);
    // The backlog reply proves the subscription is registered; only then is a
    // fresh emit guaranteed to arrive live rather than racing the subscribe.
    await waitFor(() => first.frames.some((frame) => frame.type === 'session_backlog'), 'the first backlog');
    session.emit({ type: 'agent_start' });
    await waitFor(() => sessionFrames(first.frames).length >= 1, 'the live frame on the first page');

    // A second page starts blind and catches up from the hub's ring; both
    // pages then see live frames, which the per-tab attachment model forbade.
    const second = await openSocket(server.url);
    subscribe(second.socket, SESSION);
    await waitFor(() => second.frames.some((frame) => frame.type === 'session_backlog'), 'the backlog');
    expect(backlogFrames(second.frames).some((frame) => frame.type === 'agent_start')).toBe(true);

    session.emit({ type: 'agent_settled' });
    await waitFor(() => sessionFrames(second.frames).some((frame) => frame.type === 'agent_settled'), 'the live frame');
    await waitFor(() => sessionFrames(first.frames).some((frame) => frame.type === 'agent_settled'), 'both pages live');
  });

  it('stays attached when the last browser leaves, keeping the session covered', async () => {
    const { server, session } = await bridge();
    const { socket } = await openSocket(server.url);
    await session.waitForAttach();

    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // With no browser around, the frame still lands in the hub's ring, which
    // is exactly what a per-tab attachment could not do.
    session.emit({ type: 'agent_start' });

    const second = await openSocket(server.url);
    subscribe(second.socket, SESSION);
    await waitFor(() => second.frames.some((frame) => frame.type === 'session_backlog'), 'the backlog');
    expect(backlogFrames(second.frames).some((frame) => frame.type === 'agent_start')).toBe(true);
  });
});
