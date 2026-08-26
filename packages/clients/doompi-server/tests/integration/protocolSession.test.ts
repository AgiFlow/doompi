import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiClient } from '@earendil-works/pi-client';
import { createUnixTransportFactory } from '@earendil-works/pi-client/unix';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentServerService } from '../../src/adapters/piSessionRuntime.ts';
import { type ProtocolSocket, serveProtocolSocket } from '../../src/adapters/protocolSocket.ts';
import type { AgentProcess, SessionFrame } from '../../src/types/session.ts';

const SESSION_ID = 'session-under-test';

/** Stands in for the supervised agent, so a test can drive its frame stream. */
function fakeAgent(): AgentProcess & { emit(frame: SessionFrame): void; readonly sent: SessionFrame[] } {
  const listeners: Array<(frame: SessionFrame) => void> = [];
  const sent: SessionFrame[] = [];
  return {
    sent,
    send: (frame) => sent.push(frame),
    onFrame: (listener) => listeners.push(listener),
    exited: new Promise<number>(() => {}),
    endInput: () => undefined,
    stop: () => undefined,
    emit: (frame) => {
      for (const listener of listeners) listener(frame);
    },
  };
}

let workDir: string;
let socket: ProtocolSocket | undefined;
let client: PiClient | undefined;
let agent: ReturnType<typeof fakeAgent>;

async function connect(): Promise<PiClient> {
  agent = fakeAgent();
  socket = await serveProtocolSocket({
    socketPath: path.join(workDir, 'p.sock'),
    service: createAgentServerService({
      agent,
      sessionId: SESSION_ID,
      sessionName: 'probe',
      cwd: '/workspace/repo',
      createdAt: 1,
    }),
  });
  const connected = new PiClient({ transportFactory: createUnixTransportFactory({ path: socket.socketPath }) });
  await connected.connect();
  client = connected;
  return connected;
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-protocol-'));
});

afterEach(async () => {
  await client?.dispose();
  await socket?.close();
  client = undefined;
  socket = undefined;
  fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * Pi's own client is the conformance check.
 *
 * It validates every frame against the protocol schemas and enforces the
 * handshake, correlation, and lease rules, so a session that satisfies it is
 * one any PiClient can drive — including the browser's.
 */
describe('doompi-server over the pi protocol', () => {
  it('completes the handshake and lists the supervised session', async () => {
    const connected = await connect();

    const sessions = await connected.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: SESSION_ID, sessionName: 'probe', cwd: '/workspace/repo' });
  });

  it('hands an attaching client the authoritative snapshot', async () => {
    const connected = await connect();

    const lease = await connected.attachSession(SESSION_ID);

    expect(lease.snapshot).toMatchObject({ id: SESSION_ID, phase: 'idle', transcript: [] });
  });

  it('streams a turn to the client and settles the prompt when the agent does', async () => {
    const connected = await connect();
    const lease = await connected.acquireSession(SESSION_ID, { mode: 'exclusive' });
    const snapshots: number[] = [];
    const progress: unknown[] = [];
    lease.subscribe((snapshot) => snapshots.push(snapshot.revision));
    lease.onEvent((event) => {
      if (event.type === 'session_progress') progress.push(event.progress);
    });
    const prompting = lease.prompt('what changed?');
    await vitestTick();

    // The agent accepted the prompt, and nothing has settled yet.
    expect(agent.sent).toContainEqual({ type: 'prompt', message: 'what changed?' });

    agent.emit({ type: 'agent_start' });
    agent.emit({ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } });
    agent.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'a file' },
    });
    agent.emit({
      type: 'message_end',
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'a file' }], stopReason: 'stop' },
    });
    agent.emit({ type: 'agent_settled' });

    const settled = await prompting;

    expect(settled.phase).toBe('idle');
    expect(settled.transcript).toHaveLength(1);
    expect(settled.transcript[0]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'a file' }] });
    expect(progress).toContainEqual(
      expect.objectContaining({
        type: 'item_updated',
        item: expect.objectContaining({ content: [{ type: 'text', text: 'a file' }], status: 'streaming' }),
      }),
    );
    // Snapshots reached the subscriber, and revisions only ever move forward.
    expect(snapshots.length).toBeGreaterThan(0);
    expect([...snapshots].sort((a, b) => a - b)).toEqual(snapshots);
  });

  it('reports a refused operation as a protocol error rather than dropping the connection', async () => {
    const connected = await connect();
    const lease = await connected.acquireSession(SESSION_ID, { mode: 'exclusive' });

    // Steering with no turn running is a service-level refusal.
    await expect(lease.steer('too soon')).rejects.toThrow();

    // The connection survives it.
    await expect(connected.listSessions()).resolves.toHaveLength(1);
  });

  it('forwards model and thinking changes to the agent', async () => {
    const connected = await connect();
    const lease = await connected.acquireSession(SESSION_ID, { mode: 'exclusive' });

    await lease.setModel({ provider: 'anthropic', id: 'claude-opus-4-5' });
    await lease.setThinking('high');

    expect(agent.sent).toContainEqual({ type: 'set_model', provider: 'anthropic', modelId: 'claude-opus-4-5' });
    expect(agent.sent).toContainEqual({ type: 'set_thinking_level', level: 'high' });
  });

  it('refuses to create a second session on a single-session server', async () => {
    const connected = await connect();

    await expect(connected.createSession({ cwd: '/workspace/repo' })).rejects.toThrow();
  });

  it('refuses to open a session this server does not supervise', async () => {
    const connected = await connect();

    await expect(connected.attachSession('some-other-session')).rejects.toThrow();
  });

  it('aborts a running turn and steers a queued message', async () => {
    const connected = await connect();
    const lease = await connected.acquireSession(SESSION_ID, { mode: 'exclusive' });

    const prompting = lease.prompt('long job');
    await vitestTick();
    agent.emit({ type: 'agent_start' });

    await lease.steer('actually, stop after this');
    await lease.abort();

    expect(agent.sent).toContainEqual({ type: 'steer', message: 'actually, stop after this' });
    expect(agent.sent).toContainEqual({ type: 'abort' });

    agent.emit({ type: 'agent_settled' });
    await expect(prompting).resolves.toMatchObject({ phase: 'idle' });
  });

  it('refuses a second prompt while a turn is running', async () => {
    const connected = await connect();
    const lease = await connected.acquireSession(SESSION_ID, { mode: 'exclusive' });

    const prompting = lease.prompt('first');
    await vitestTick();
    agent.emit({ type: 'agent_start' });

    await expect(lease.prompt('second')).rejects.toThrow();

    agent.emit({ type: 'agent_settled' });
    await prompting;
  });

  it('keeps the session usable after a client releases its lease', async () => {
    const connected = await connect();
    const first = await connected.acquireSession(SESSION_ID, { mode: 'exclusive' });
    await first.dispose();

    // The agent outlives any one client, so the next attach still works.
    const second = await connected.attachSession(SESSION_ID);

    expect(second.snapshot).toMatchObject({ id: SESSION_ID });
  });
});

/** Lets the server's microtasks run before the test inspects what it received. */
async function vitestTick(): Promise<void> {
  for (let attempt = 0; attempt < 50 && agent.sent.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
