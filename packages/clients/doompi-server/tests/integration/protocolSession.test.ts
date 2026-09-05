import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemoteServiceBinding, type RemoteServiceBinding } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Client, createClientServiceTransport } from '@earendil-works/pi-client';
import { createUnixTransportFactory } from '@earendil-works/pi-client/unix';
import {
  DoomSessionManagementService,
  DoomSessionService,
  type SessionService,
} from '@agimon-ai/doompi-extension-contracts/session-protocol';
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
let client: Client | undefined;
let binding: RemoteServiceBinding | undefined;
let agent: ReturnType<typeof fakeAgent>;

async function connect(): Promise<{ client: Client; session: SessionService }> {
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
  const connected = new Client({
    serverId: socket.serverId,
    transportFactory: createUnixTransportFactory({ path: socket.socketPath }),
  });
  await connected.connect();
  client = connected;
  const next = await attach(connected, SESSION_ID);
  return { client: connected, session: next.use(DoomSessionService) };
}

async function attach(connected: Client, sessionId: string): Promise<RemoteServiceBinding> {
  await connected.request(
    { serverId: connected.serverId },
    { serviceId: DoomSessionManagementService.id, member: 'attach', args: [sessionId] },
  );
  const next = createRemoteServiceBinding({
    services: [DoomSessionService],
    transport: createClientServiceTransport(connected, () => connected.attachment),
  });
  next.use(DoomSessionService);
  await next.ready(BACKGROUND_CONTEXT);
  binding = next;
  return next;
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-protocol-'));
});

afterEach(async () => {
  await binding?.dispose(BACKGROUND_CONTEXT).catch(() => undefined);
  await client?.dispose();
  await socket?.close();
  binding = undefined;
  client = undefined;
  socket = undefined;
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Exercises the routed Pi 0.85 transport with its own client and Chord binding. */
describe('doompi-server over the pi protocol', () => {
  it('completes the handshake and publishes session management', async () => {
    const { client: connected } = await connect();

    const catalogue = await connected.serviceCatalogue({ serverId: connected.serverId });

    expect(connected.hello?.serverId).toBe(socket?.serverId);
    expect(catalogue).toContainEqual({ serviceId: DoomSessionManagementService.id, mode: 'singleton' });
  });

  it('hands an attaching client the authoritative snapshot', async () => {
    const { session } = await connect();

    expect(session.state.value!.snapshot).toMatchObject({ id: SESSION_ID, phase: 'idle', transcript: [] });
  });

  it('streams a turn to the client and settles the prompt when the agent does', async () => {
    const { session } = await connect();
    const snapshots: number[] = [];
    const progress: unknown[] = [];
    session.state.subscribe((state) => {
      snapshots.push(state.snapshot.revision);
      if (state.progress) progress.push(state.progress);
    });
    const prompting = session.prompt('what changed?', BACKGROUND_CONTEXT);
    await vitestTick();

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

    await prompting;
    await waitForIdle(session);
    const settled = session.state.value!.snapshot;
    expect(settled.phase).toBe('idle');
    expect(settled.transcript).toHaveLength(1);
    expect(settled.transcript[0]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'a file' }] });
    expect(progress).toContainEqual(
      expect.objectContaining({
        type: 'item_updated',
        item: expect.objectContaining({ content: [{ type: 'text', text: 'a file' }], status: 'streaming' }),
      }),
    );
    expect(snapshots.length).toBeGreaterThan(0);
    expect([...snapshots].sort((a, b) => a - b)).toEqual(snapshots);
  });

  it('reports a refused operation as a service error rather than dropping the connection', async () => {
    const { client: connected, session } = await connect();

    await expect(session.steer('too soon', BACKGROUND_CONTEXT)).rejects.toThrow();
    await expect(connected.serviceCatalogue({ serverId: connected.serverId })).resolves.toContainEqual({
      serviceId: DoomSessionManagementService.id,
      mode: 'singleton',
    });
  });

  it('forwards model and thinking changes to the agent', async () => {
    const { session } = await connect();

    await session.setModel({ provider: 'anthropic', id: 'claude-opus-4-5' }, BACKGROUND_CONTEXT);
    await session.setThinking('high', BACKGROUND_CONTEXT);

    expect(agent.sent).toContainEqual({ type: 'set_model', provider: 'anthropic', modelId: 'claude-opus-4-5' });
    expect(agent.sent).toContainEqual({ type: 'set_thinking_level', level: 'high' });
  });

  it('refuses to attach a session this server does not supervise', async () => {
    const { client: connected } = await connect();

    await expect(
      connected.request(
        { serverId: connected.serverId },
        { serviceId: DoomSessionManagementService.id, member: 'attach', args: ['some-other-session'] },
      ),
    ).rejects.toThrow();
  });

  it('aborts a running turn and steers a queued message', async () => {
    const { session } = await connect();
    const prompting = session.prompt('long job', BACKGROUND_CONTEXT);
    await vitestTick();
    agent.emit({ type: 'agent_start' });

    await session.steer('actually, stop after this', BACKGROUND_CONTEXT);
    await session.abort(BACKGROUND_CONTEXT);

    expect(agent.sent).toContainEqual({ type: 'steer', message: 'actually, stop after this' });
    expect(agent.sent).toContainEqual({ type: 'abort' });

    agent.emit({ type: 'agent_settled' });
    await expect(prompting).resolves.toBeUndefined();
    await waitForIdle(session);
    expect(session.state.value!.snapshot.phase).toBe('idle');
  });

  it('refuses a second prompt while a turn is running', async () => {
    const { session } = await connect();
    const prompting = session.prompt('first', BACKGROUND_CONTEXT);
    await vitestTick();
    agent.emit({ type: 'agent_start' });

    await expect(session.prompt('second', BACKGROUND_CONTEXT)).rejects.toThrow();

    agent.emit({ type: 'agent_settled' });
    await prompting;
  });

  it('keeps the session usable after a client detaches and reattaches', async () => {
    const { client: connected } = await connect();
    await binding?.dispose(BACKGROUND_CONTEXT);
    binding = undefined;
    await connected.request(
      { serverId: connected.serverId },
      { serviceId: DoomSessionManagementService.id, member: 'detach', args: [] },
    );

    const secondBinding = await attach(connected, SESSION_ID);
    const second = secondBinding.use(DoomSessionService);

    expect(second.state.value!.snapshot).toMatchObject({ id: SESSION_ID });
  });
});

async function waitForIdle(session: SessionService): Promise<void> {
  for (let attempt = 0; attempt < 50 && session.state.value?.snapshot.phase !== 'idle'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Lets the server's microtasks run before the test inspects what it received. */
async function vitestTick(): Promise<void> {
  for (let attempt = 0; attempt < 50 && agent.sent.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
