import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { watchRegistry } from '../../src/adapters/registryWatcher.ts';
import type { HubChannelHost, WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import {
  createSessionHub,
  type HubEvent,
  type SessionHub,
  type SessionHubOptions,
} from '../../src/adapters/sessionHub.ts';
import type { SpawnOutcome, SpawnSessionInput } from '../../src/adapters/serverSpawner.ts';
import type { SessionSummary } from '../../src/types/hub.ts';
import { type FakeSession, startFakeSession, writeStaleRecord } from '../support/fakeSession.ts';

let cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  cleanups = [];
});

function freshRegistryDir(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-hub-')), 'run');
  cleanups.push(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  return dir;
}

interface HubHarness {
  hub: SessionHub;
  events: HubEvent[];
  latest(sessionId: string): SessionSummary | undefined;
  framesFor(sessionId: string): Record<string, unknown>[];
}

function startHub(
  registryDir: string,
  spawn?: (input: SpawnSessionInput) => Promise<SpawnOutcome>,
  extraChannels: WebHubChannel[] = [],
  signal?: (pid: number) => void,
  overrides: Partial<SessionHubOptions> = {},
): HubHarness {
  const events: HubEvent[] = [];
  const hub = createSessionHub({
    source: watchRegistry(registryDir),
    spawner: spawn === undefined ? undefined : { spawn },
    // Channels are entirely injected: the packaged host ships no builtin
    // ones since every data source is a plugin now.
    channels: extraChannels,
    ...(signal === undefined ? {} : { signal }),
    ...overrides,
  });
  cleanups.push(() => hub.close());
  hub.onEvent((event) => events.push(event));
  return {
    hub,
    events,
    latest(sessionId) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.kind === 'upsert' && event.session.id === sessionId) return event.session;
      }
      return hub.snapshot().find((summary) => summary.id === sessionId);
    },
    framesFor(sessionId) {
      return events
        .filter((event): event is Extract<HubEvent, { kind: 'frame' }> => event.kind === 'frame')
        .filter((event) => event.sessionId === sessionId)
        .map((event) => event.frame);
    },
  };
}

async function startRegisteredSession(
  registryDir: string,
  options: { id?: string; name?: string; pid?: number; cwd?: string } = {},
): Promise<FakeSession> {
  const session = await startFakeSession({ ...options, registryDir });
  cleanups.push(() => session.close());
  return session;
}

const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('the session hub over a registry', () => {
  it('discovers registered sessions and attaches to each', async () => {
    const registryDir = freshRegistryDir();
    const first = await startRegisteredSession(registryDir, { id: 'one', name: 'alpha' });
    const second = await startRegisteredSession(registryDir, { id: 'two', name: 'beta' });
    const harness = startHub(registryDir);

    await first.waitForAttach();
    await second.waitForAttach();
    await waitFor(
      () => harness.latest('one')?.attach === 'attached' && harness.latest('two')?.attach === 'attached',
      'both sessions attached',
    );
    expect(harness.hub.snapshot().map((summary) => summary.name)).toEqual(['alpha', 'beta']);
  });

  it('stops a session by signalling its server, and never signals itself', async () => {
    const registryDir = freshRegistryDir();
    const own = await startRegisteredSession(registryDir, { id: 'own', name: 'own' });
    // The parent process is alive (so the record is not stale) but is not this
    // process; the injected signal keeps it unharmed.
    const other = await startRegisteredSession(registryDir, { id: 'other', name: 'other', pid: process.ppid });
    const signalled: number[] = [];
    const harness = startHub(registryDir, undefined, [], (pid) => signalled.push(pid));
    await own.waitForAttach();
    await other.waitForAttach();
    await waitFor(() => harness.latest('own') !== undefined && harness.latest('other') !== undefined, 'both listed');

    expect(harness.hub.stop('other')).toEqual({ ok: true });
    expect(signalled).toEqual([process.ppid]);
    expect(harness.hub.stop('own')).toMatchObject({ ok: false, code: 'self' });
    expect(harness.hub.stop('nope')).toMatchObject({ ok: false, code: 'unknown' });
    expect(signalled).toEqual([process.ppid]);
  });

  it('restarts a session under the same id, directory, and latest reported name', async () => {
    const registryDir = freshRegistryDir();
    const session = await startRegisteredSession(registryDir, { id: 'live', name: 'live', pid: process.ppid });
    const spawned: SpawnSessionInput[] = [];
    const signalled: number[] = [];
    const harness = startHub(
      registryDir,
      async (input) => {
        spawned.push(input);
        return { ok: true, sessionId: input.sessionId ?? 'fresh' };
      },
      [],
      (pid) => {
        signalled.push(pid);
        // A real server exits on the signal and withdraws its record; that is
        // the event the restart waits for before starting the replacement.
        void session.close();
      },
    );
    await session.waitForAttach();
    await waitFor(() => harness.latest('live') !== undefined, 'the session listed');
    session.emit({ type: 'response', command: 'get_state', success: true, data: { sessionName: 'renamed' } });
    await waitFor(() => harness.latest('live')?.name === 'renamed', 'the renamed session');

    const outcome = await harness.hub.restart('live');

    expect(signalled).toEqual([process.ppid]);
    expect(outcome).toEqual({ ok: true, sessionId: 'live' });
    // The id is kept so Pi resumes the same session, and the directory is
    // reused so repeated restarts cannot outgrow the unix socket path limit.
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.sessionId).toBe('live');
    expect(spawned[0]?.name).toBe('renamed');
    expect(spawned[0]?.sessionDir).toBe(path.dirname(session.socketPath));
  });

  it('replaces a live session with the selected inactive Pi thread', async () => {
    const registryDir = freshRegistryDir();
    const session = await startRegisteredSession(registryDir, { id: 'live', name: 'live', pid: process.ppid });
    const spawned: SpawnSessionInput[] = [];
    const harness = startHub(
      registryDir,
      async (input) => {
        spawned.push(input);
        return { ok: true, sessionId: input.sessionId ?? 'fresh' };
      },
      [],
      () => void session.close(),
    );
    await session.waitForAttach();
    await waitFor(() => harness.latest('live') !== undefined, 'the live session listed');

    const outcome = await harness.hub.resume('live', { sessionId: 'history-id', name: 'Earlier work' });

    expect(outcome).toEqual({ ok: true, sessionId: 'history-id' });
    expect(spawned).toEqual([
      expect.objectContaining({
        cwd: path.dirname(session.socketPath),
        name: 'Earlier work',
        sessionId: 'history-id',
        sessionDir: path.dirname(session.socketPath),
      }),
    ]);
  });

  it('does not start a replacement when the session refuses to go', async () => {
    const registryDir = freshRegistryDir();
    const session = await startRegisteredSession(registryDir, { id: 'stuck', pid: process.ppid });
    const spawned: SpawnSessionInput[] = [];
    // The signal is swallowed, so the record never leaves.
    const harness = startHub(
      registryDir,
      async (input) => {
        spawned.push(input);
        return { ok: true, sessionId: 'unexpected' };
      },
      [],
      () => undefined,
      { restartWaitMs: 60, restartPollMs: 10 },
    );
    await session.waitForAttach();
    await waitFor(() => harness.latest('stuck') !== undefined, 'the session listed');

    const outcome = await harness.hub.restart('stuck');

    // Two servers on one socket is worse than a failed restart, so it reports.
    expect(outcome).toMatchObject({ ok: false, code: 'spawn_failed' });
    await expect(harness.hub.resume('stuck', { sessionId: 'history', name: 'History' })).resolves.toMatchObject({
      ok: false,
      code: 'spawn_failed',
    });
    expect(spawned).toEqual([]);
  });

  it('refuses to restart an unknown session, and one it has no spawner for', async () => {
    const registryDir = freshRegistryDir();
    const withSpawner = startHub(registryDir, async () => ({ ok: true, sessionId: 'x' }));
    await expect(withSpawner.hub.restart('nope')).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    await expect(withSpawner.hub.resume('nope', { sessionId: 'history', name: 'History' })).resolves.toMatchObject({
      ok: false,
      code: 'invalid_request',
    });

    const session = await startRegisteredSession(registryDir, { id: 'fixed' });
    const noSpawner = startHub(registryDir);
    await session.waitForAttach();
    await waitFor(() => noSpawner.latest('fixed') !== undefined, 'the session listed');
    await expect(noSpawner.hub.restart('fixed')).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    await expect(noSpawner.hub.resume('fixed', { sessionId: 'history', name: 'History' })).resolves.toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
  });

  it('does not resume a Pi thread that another live card already owns', async () => {
    const registryDir = freshRegistryDir();
    const first = await startRegisteredSession(registryDir, { id: 'one' });
    const second = await startRegisteredSession(registryDir, { id: 'two' });
    const harness = startHub(registryDir, async () => ({ ok: true, sessionId: 'unexpected' }));
    await first.waitForAttach();
    await second.waitForAttach();
    await waitFor(() => harness.hub.snapshot().length === 2, 'both sessions listed');

    await expect(harness.hub.resume('one', { sessionId: 'two', name: 'Two' })).resolves.toMatchObject({
      ok: false,
      code: 'invalid_request',
      error: expect.stringMatching(/already running/) as string,
    });
  });

  it('picks up a session that registers mid-run and drops one that leaves', async () => {
    const registryDir = freshRegistryDir();
    const harness = startHub(registryDir);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const late = await startRegisteredSession(registryDir, { id: 'late' });
    await late.waitForAttach();
    await waitFor(() => harness.latest('late') !== undefined, 'the late session appearing');

    await late.close();
    await waitFor(
      () => harness.events.some((event) => event.kind === 'removed' && event.sessionId === 'late'),
      'the removal',
    );
  });

  it('cleans a stale record whose server crashed', async () => {
    const registryDir = freshRegistryDir();
    const staleId = writeStaleRecord(registryDir);
    const harness = startHub(registryDir);

    await waitFor(() => harness.hub.snapshot().length === 0, 'the janitor pass');
    expect(fs.existsSync(path.join(registryDir, 'sessions', `${staleId}.json`))).toBe(false);
  });

  it('routes frames and commands by session id', async () => {
    const registryDir = freshRegistryDir();
    const first = await startRegisteredSession(registryDir, { id: 'one' });
    const second = await startRegisteredSession(registryDir, { id: 'two' });
    const harness = startHub(registryDir);
    await first.waitForAttach();
    await second.waitForAttach();

    first.emit({ type: 'agent_start' });
    await waitFor(() => harness.framesFor('one').some((frame) => frame.type === 'agent_start'), 'the routed frame');
    expect(harness.framesFor('two').some((frame) => frame.type === 'agent_start')).toBe(false);

    harness.hub.command('two', { type: 'prompt', message: 'only for two' });
    await second.waitForCommand('prompt');
    expect(first.received.some((frame) => frame.type === 'prompt')).toBe(false);

    // The backlog ring is per session too.
    expect(harness.hub.backlog('one')?.frames.some((frame) => frame.type === 'agent_start')).toBe(true);
    expect(harness.hub.backlog('two')?.frames.some((frame) => frame.type === 'agent_start')).toBe(false);
    expect(harness.hub.backlog('unknown')).toBeUndefined();
  });

  // The runtime journals the composition only when it actually changes, which on
  // a long session is once and hours before anyone opens the page. Held in the
  // transient ring it is evicted by ordinary traffic, and the context panel then
  // shows the modes the status line still carries with no tools underneath them.
  it('keeps the composition entry out of the bounded transient ring', async () => {
    const registryDir = freshRegistryDir();
    const cwd = path.dirname(registryDir);
    const session = await startRegisteredSession(registryDir, { id: 'one', cwd });
    const composition = {
      type: 'entry_appended',
      entry: { type: 'custom', id: 'c1', customType: 'doom-context', data: { version: 1, groups: [] } },
    };
    session.emit(composition);
    session.emit({ type: 'agent_start' });

    const harness = startHub(registryDir, undefined, [], undefined, { ringLimit: 1 });
    await session.waitForAttach();
    await waitFor(
      () => harness.framesFor('one').filter((frame) => frame.type === 'replay').length >= 2,
      'both frames replaying',
    );

    const frames = harness.hub.backlog('one')?.frames ?? [];
    expect(frames).toContainEqual({ type: 'replay', frame: composition });
    expect(frames).toContainEqual({ type: 'replay', frame: { type: 'agent_start' } });
  });
  it("keeps each session's latest UI projections outside its bounded transient ring", async () => {
    const registryDir = freshRegistryDir();
    const cwd = path.dirname(registryDir);
    const first = await startRegisteredSession(registryDir, { id: 'one', cwd });
    const second = await startRegisteredSession(registryDir, { id: 'two', cwd });
    const status = (id: string, statusKey: string, statusText: string) => ({
      type: 'extension_ui_request',
      id,
      method: 'setStatus',
      statusKey,
      statusText,
    });
    const widget = (id: string, widgetLines: string[]) => ({
      type: 'extension_ui_request',
      id,
      method: 'setWidget',
      widgetKey: 'workflow-mcp-progress',
      widgetLines,
    });
    const firstInitial = [
      status('one-major-initial', 'doom-major-mode', '[minimal]'),
      status('one-profile-initial', 'doom-profile', 'developer'),
      status('one-domain-initial', 'doom-domain', 'development'),
      widget('one-widget-initial', ['starting']),
    ];
    const secondInitial = [
      status('two-major', 'doom-major-mode', '[review]'),
      status('two-profile', 'doom-profile', 'reviewer'),
      status('two-domain', 'doom-domain', 'testing'),
      widget('two-widget', ['waiting']),
    ];
    for (const frame of firstInitial) first.emit(frame);
    first.emit({ type: 'agent_start' });
    for (const frame of secondInitial) second.emit(frame);
    second.emit({ type: 'agent_start' });

    const harness = startHub(registryDir, undefined, [], undefined, { ringLimit: 1 });
    await first.waitForAttach();
    await second.waitForAttach();
    await waitFor(
      () =>
        harness.framesFor('one').filter((frame) => frame.type === 'replay').length >= 5 &&
        harness.framesFor('two').filter((frame) => frame.type === 'replay').length >= 5,
      'both sessions replaying their initial projections',
    );

    const firstCurrent = [
      status('one-major-current', 'doom-major-mode', '[copilot]'),
      status('one-profile-clear', 'doom-profile', ''),
      status('one-domain-current', 'doom-domain', 'development,testing'),
      widget('one-widget-clear', []),
    ];
    for (const frame of firstCurrent) first.emit(frame);
    first.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'working' } });
    first.emit({ type: 'agent_settled' });
    await waitFor(
      () => harness.framesFor('one').some((frame) => frame.type === 'agent_settled'),
      'the latest transient frame',
    );

    expect(harness.hub.backlog('one')).toEqual({
      type: 'session_backlog',
      sessionId: 'one',
      frames: [...firstCurrent, { type: 'agent_settled' }],
      dropped: 2,
    });
    expect(harness.hub.backlog('two')).toEqual({
      type: 'session_backlog',
      sessionId: 'two',
      frames: [
        ...secondInitial.map((frame) => ({ type: 'replay', frame })),
        { type: 'replay', frame: { type: 'agent_start' } },
      ],
      dropped: 0,
    });

    const afterReload = {
      type: 'tool_execution_start',
      toolCallId: 'after-reload',
      toolName: 'test',
      args: {},
    };
    first.emit(afterReload);
    await waitFor(
      () => harness.framesFor('one').some((frame) => frame.toolCallId === 'after-reload'),
      'the transient frame after resubscription',
    );
    expect(harness.hub.backlog('one')).toEqual({
      type: 'session_backlog',
      sessionId: 'one',
      frames: [...firstCurrent, afterReload],
      dropped: 3,
    });
  });

  it('records a synthetic close when a dialog answer passes through', async () => {
    const registryDir = freshRegistryDir();
    const session = await startRegisteredSession(registryDir, { id: 'one' });
    const harness = startHub(registryDir);
    await session.waitForAttach();
    // The hub's own socket client authenticates a beat after the session
    // accepts it; a command sent in that beat must wait for the handshake
    // rather than vanish, which is what a click right after a session restart
    // looks like.
    harness.hub.command('one', { type: 'extension_ui_response', id: 'req-9', value: 'a' });
    await session.waitForCommand('extension_ui_response');

    // Live subscribers and future backlog replays both see the close.
    await waitFor(
      () => harness.framesFor('one').some((frame) => frame.type === 'extension_ui_answered' && frame.id === 'req-9'),
      'the synthetic close',
    );
    expect(
      harness.hub
        .backlog('one')
        ?.frames.some((frame) => frame.type === 'extension_ui_answered' && frame.id === 'req-9'),
    ).toBe(true);

    // Other command types stay unannotated.
    harness.hub.command('one', { type: 'prompt', message: 'hello' });
    await session.waitForCommand('prompt');
    expect(harness.hub.backlog('one')?.frames.filter((frame) => frame.type === 'extension_ui_answered')).toHaveLength(
      1,
    );
  });

  it('restores the transcript and the newest catalog entry from the journal on attach', async () => {
    const registryDir = freshRegistryDir();
    const session = await startRegisteredSession(registryDir, { id: 'one' });
    const harness = startHub(registryDir);
    await session.waitForCommand('get_entries');

    // The runtime journaled its catalog before this hub existed; only the
    // newest entry describes the session as it is now.
    const stale = {
      type: 'custom',
      id: 'e1',
      customType: 'doom-minor-modes',
      data: { version: 1, revision: 1, modes: [] },
    };
    const current = {
      type: 'custom',
      id: 'e4',
      customType: 'doom-minor-modes',
      data: { version: 1, revision: 2, modes: [{ id: 'voice' }] },
    };
    const asked = { type: 'message', id: 'e2', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } };
    const answered = {
      type: 'message',
      id: 'e3',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    };
    session.emit({
      type: 'response',
      command: 'get_entries',
      success: true,
      data: { entries: [stale, asked, answered, current], leafId: 'e4' },
    });

    await waitFor(
      () => harness.framesFor('one').filter((frame) => frame.type === 'entry_appended').length === 3,
      'the restored journal',
    );
    // A session outlives the hubs that watch it, so the transcript it already
    // holds is replayed in the order it happened.
    expect(harness.framesFor('one').filter((frame) => frame.type === 'entry_appended')).toEqual([
      { type: 'entry_appended', entry: asked },
      { type: 'entry_appended', entry: answered },
      { type: 'entry_appended', entry: current },
    ]);
    // The answer itself is the whole journal and no page reads it, so it
    // reaches neither live subscribers nor the replay ring. The catalog entry is
    // a projection rather than a transcript event, so it leads the backlog from
    // the projection map instead of ageing out of the ring behind the messages.
    expect(harness.framesFor('one').some((frame) => frame.type === 'response')).toBe(false);
    expect(harness.hub.backlog('one')?.frames).toEqual([
      { type: 'entry_appended', entry: current },
      { type: 'entry_appended', entry: asked },
      { type: 'entry_appended', entry: answered },
    ]);
  });

  it('restores only the tail of a transcript longer than the limit', async () => {
    const registryDir = freshRegistryDir();
    const session = await startRegisteredSession(registryDir, { id: 'one' });
    const harness = startHub(registryDir, undefined, [], undefined, { restoreLimit: 2 });
    await session.waitForCommand('get_entries');

    const message = (id: string) => ({
      type: 'message',
      id,
      message: { role: 'user', content: [{ type: 'text', text: id }] },
    });
    session.emit({
      type: 'response',
      command: 'get_entries',
      success: true,
      data: { entries: [message('e1'), message('e2'), message('e3')], leafId: 'e3' },
    });

    await waitFor(
      () => harness.framesFor('one').filter((frame) => frame.type === 'entry_appended').length === 2,
      'the restored tail',
    );
    // The ring has to hold live frames too, so the oldest history is what goes.
    expect(harness.framesFor('one').filter((frame) => frame.type === 'entry_appended')).toEqual([
      { type: 'entry_appended', entry: message('e2') },
      { type: 'entry_appended', entry: message('e3') },
    ]);
  });

  it('pages back through the transcript the attach path was too small to publish', async () => {
    const registryDir = freshRegistryDir();
    const session = await startRegisteredSession(registryDir, { id: 'one' });
    const harness = startHub(registryDir, undefined, [], undefined, { restoreLimit: 2 });
    await session.waitForCommand('get_entries');

    const message = (id: string) => ({
      type: 'message',
      id,
      message: { role: 'user', content: [{ type: 'text', text: id }] },
    });
    const entries = ['e1', 'e2', 'e3', 'e4', 'e5'].map(message);
    session.emit({ type: 'response', command: 'get_entries', success: true, data: { entries, leafId: 'e5' } });
    await waitFor(
      () => harness.framesFor('one').filter((frame) => frame.type === 'entry_appended').length === 2,
      'the restored tail',
    );

    // The page holds e4 and e5; asking for what came before walks backwards
    // through what the hub kept rather than what it published.
    const first = harness.hub.history('one', { before: 'e4', limit: 2 });
    expect(first?.frames).toEqual([
      { type: 'entry_appended', entry: message('e2') },
      { type: 'entry_appended', entry: message('e3') },
    ]);
    expect(first?.cursor).toBe('e2');
    expect(first?.hasMore).toBe(true);
    expect(first?.before).toBe('e4');

    const second = harness.hub.history('one', { before: 'e2', limit: 2 });
    expect(second?.frames).toEqual([{ type: 'entry_appended', entry: message('e1') }]);
    expect(second?.hasMore).toBe(false);
  });

  it('answers a history request for an unknown session with nothing', async () => {
    const registryDir = freshRegistryDir();
    const harness = startHub(registryDir);

    expect(harness.hub.history('nobody', {})).toBeUndefined();
  });

  it('re-reads the journal at a run boundary and adds only the message no frame reported', async () => {
    const registryDir = freshRegistryDir();
    const session = await startRegisteredSession(registryDir, { id: 'one' });
    const harness = startHub(registryDir);
    await session.waitForCommand('get_entries');

    const message = (id: string, role: string, text: string) => ({
      type: 'message',
      id,
      message: { role, content: [{ type: 'text', text }] },
    });
    const asked = message('e1', 'user', 'what is failing');
    session.emit({ type: 'response', command: 'get_entries', success: true, data: { entries: [asked], leafId: 'e1' } });
    await waitFor(
      () => harness.framesFor('one').filter((frame) => frame.type === 'entry_appended').length === 1,
      'the attach restore',
    );

    // An extension that prompts the agent itself (autonomous voice dictating
    // what it heard) writes the message straight to the journal, so the run
    // starting is the only sign the page gets that it exists.
    session.emit({ type: 'agent_start' });
    await session.waitForCommand('get_entries');
    const spoken = message('e2', 'user', 'run the voice suite');
    const answered = message('e3', 'assistant', 'running it now');
    session.emit({
      type: 'response',
      command: 'get_entries',
      success: true,
      data: { entries: [asked, spoken, answered], leafId: 'e3' },
    });

    await waitFor(
      () => harness.framesFor('one').filter((frame) => frame.type === 'entry_appended').length === 2,
      'the message the re-read found',
    );
    // The answer already reached the page as it streamed, and the journal copy
    // carries no id that copy can be matched by, so republishing it would show
    // the same reply twice. Only the message no frame reports is added.
    expect(harness.framesFor('one').filter((frame) => frame.type === 'entry_appended')).toEqual([
      { type: 'entry_appended', entry: asked },
      { type: 'entry_appended', entry: spoken },
    ]);
  });

  it('derives the rail phase from the frame stream', async () => {
    const registryDir = freshRegistryDir();
    const session = await startRegisteredSession(registryDir, { id: 'one' });
    const harness = startHub(registryDir);
    await session.waitForAttach();

    session.emit({ type: 'agent_start' });
    await waitFor(() => harness.latest('one')?.phase === 'turn', 'the turn phase');

    session.emit({ type: 'agent_settled' });
    await waitFor(() => harness.latest('one')?.phase === 'idle', 'the idle phase');
    expect(harness.latest('one')?.lastSettledAt).toBeDefined();
  });

  it('reports a held session as refused and recovers when it is released', { timeout: 20_000 }, async () => {
    const registryDir = freshRegistryDir();
    const session = await startRegisteredSession(registryDir, { id: 'one' });
    const harness = startHub(registryDir);
    await session.waitForAttach();

    // A refusal is a moment, not a resting state: the retry loop closes the
    // socket right after, so the page-side store is what makes it sticky.
    // Here it is enough that the refusal upsert was emitted with its reason.
    const refusedUpsert = (): SessionSummary | undefined => {
      for (const event of harness.events) {
        if (event.kind === 'upsert' && event.session.id === 'one' && event.session.attach === 'refused') {
          return event.session;
        }
      }
      return undefined;
    };
    const release = await session.holdFromAnotherClient();
    await waitFor(() => refusedUpsert() !== undefined, 'the refusal');
    expect(refusedUpsert()?.attachReason).toMatch(/Another client/);

    release();
    // The takeover rides the existing backoff, whose ceiling is 4s.
    await waitFor(() => harness.latest('one')?.attach === 'attached', 'the takeover', 15_000);
  });

  it('runs channel lifecycle hooks and fans published payloads out as channel events', async () => {
    const registryDir = freshRegistryDir();
    const lifecycle: string[] = [];
    let host: HubChannelHost | undefined;
    const fake: WebHubChannel = {
      frameType: 'fake_data',
      start(channelHost) {
        host = channelHost;
        return {
          payloadFor: (scope) => ({ marker: `snapshot:${scope.sessionId}` }),
          threadJournal: (scope, threadId) => (threadId === 'known' ? `/journals/${scope.sessionId}.jsonl` : undefined),
          sessionAdded: (scope) => lifecycle.push(`added:${scope.sessionId}`),
          sessionRemoved: (sessionId) => lifecycle.push(`removed:${sessionId}`),
          close: () => lifecycle.push('closed'),
        };
      },
    };
    const session = await startRegisteredSession(registryDir, { id: 'chan' });
    const harness = startHub(registryDir, undefined, [fake]);
    await session.waitForAttach();
    await waitFor(() => lifecycle.includes('added:chan'), 'the session reaching the channel');

    host?.publish('chan', { marker: 'live' });
    expect(
      harness.events.some(
        (event) => event.kind === 'channel' && event.frameType === 'fake_data' && event.sessionId === 'chan',
      ),
    ).toBe(true);
    expect(harness.hub.channelTypes()).toEqual(['fake_data']);
    const frame = harness.hub.channelFrames('chan').find((candidate) => candidate.type === 'fake_data');
    expect(frame?.payload).toEqual({ marker: 'snapshot:chan' });
    // A thread's journal comes from the first channel that names it, for a session the hub knows.
    expect(harness.hub.threadJournal('chan', 'known')).toBe('/journals/chan.jsonl');
    expect(harness.hub.threadJournal('chan', 'other')).toBeUndefined();
    expect(harness.hub.threadJournal('nobody', 'known')).toBeUndefined();

    await session.close();
    await waitFor(() => lifecycle.includes('removed:chan'), 'the removal reaching the channel');
    harness.hub.close();
    expect(lifecycle.at(-1)).toBe('closed');
  });

  it('routes incoming channel payloads by live scope, frame type, and connection', async () => {
    const registryDir = freshRegistryDir();
    const received: unknown[] = [];
    const channel: WebHubChannel = {
      frameType: 'strict_data',
      start: () => ({ payloadFor: () => undefined, close: () => undefined }),
      receive: (scope, payload, connection) => received.push({ scope, payload, connection }),
    };
    const session = await startRegisteredSession(registryDir, { id: 'strict' });
    const harness = startHub(registryDir, undefined, [channel]);
    await session.waitForAttach();
    await waitFor(() => harness.hub.snapshot().some((candidate) => candidate.id === 'strict'), 'strict session');

    harness.hub.receiveChannel('strict', 'other', { ignored: 1 }, 'page-one');
    harness.hub.receiveChannel('missing', 'strict_data', { ignored: 2 }, 'page-one');
    harness.hub.receiveChannel('strict', 'strict_data', { ignored: 3 }, '');
    harness.hub.receiveChannel('strict', 'strict_data', { accepted: true }, 'page-one');

    expect(received).toEqual([
      {
        scope: { sessionId: 'strict', cwd: harness.hub.snapshot().find((candidate) => candidate.id === 'strict')?.cwd },
        payload: { accepted: true },
        connection: { connectionId: 'page-one' },
      },
    ]);
  });

  it('creates sessions through the injected spawner', async () => {
    const registryDir = freshRegistryDir();
    const harness = startHub(registryDir, async (input) => {
      // The stand-in does what doompi-server would: start and register.
      const spawned = await startRegisteredSession(registryDir, { id: 'spawned', name: input.name });
      return { ok: true, sessionId: spawned.id };
    });

    const outcome = await harness.hub.create({ cwd: '/anywhere', name: 'fresh' });
    expect(outcome).toEqual({ ok: true, sessionId: 'spawned' });
    await waitFor(() => harness.latest('spawned') !== undefined, 'the created session appearing');
    expect(harness.latest('spawned')?.name).toBe('fresh');
  });

  it('reports a spawner failure verbatim', async () => {
    const registryDir = freshRegistryDir();
    const harness = startHub(registryDir, () =>
      Promise.resolve({ ok: false as const, code: 'spawn_failed' as const, error: 'doompi-server is not on PATH.' }),
    );

    await expect(harness.hub.create({ cwd: '/anywhere' })).resolves.toEqual({
      ok: false,
      code: 'spawn_failed',
      error: 'doompi-server is not on PATH.',
    });
  });

  it('refuses creation in fixed single-session mode', async () => {
    const registryDir = freshRegistryDir();
    const harness = startHub(registryDir);
    await expect(harness.hub.create({ cwd: '/anywhere' })).resolves.toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
  });
});
