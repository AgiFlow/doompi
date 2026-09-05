import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemoteServiceBinding, type RemoteServiceBinding } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Client, createClientServiceTransport } from '@earendil-works/pi-client';
import type { ByteTransport, ByteTransportHandlers } from '@earendil-works/pi-client';
import { createAgentServerService, type ProtocolSocket, serveProtocolSocket } from '@agimon-ai/doompi-server';
import {
  DOOM_COCKPIT_SERVER_ID,
  DoomSessionManagementService,
  DoomSessionService,
  type SessionService,
} from '@agimon-ai/doompi-extension-contracts/session-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { serveWeb } from '../../src/adapters/httpServer.ts';
import type { WebServer } from '../../src/types/bridge.ts';
import type { SessionFrame } from '../../src/types/session.ts';

vi.mock('../../src/adapters/syncGuard.ts', () => ({
  createSyncGuard: () => ({
    ensureSynced: async () => undefined,
    watch: () => undefined,
    close: () => undefined,
  }),
}));
const SESSION_ID = 'hub-session';

/** Stands in for a session's supervised agent. */
function fakeAgent() {
  const listeners: Array<(frame: SessionFrame) => void> = [];
  const sent: SessionFrame[] = [];
  return {
    sent,
    send: (frame: SessionFrame) => sent.push(frame),
    onFrame: (listener: (frame: SessionFrame) => void) => listeners.push(listener),
    exited: new Promise<number>(() => {}),
    endInput: () => undefined,
    stop: () => undefined,
    emit: (frame: SessionFrame) => {
      for (const listener of listeners) listener(frame);
    },
  };
}

/** The browser's transport, but driven from Node by the `ws` client. */
function webSocketTransport(url: string) {
  return async (handlers: ByteTransportHandlers): Promise<ByteTransport> => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.on('message', (data: ArrayBuffer | Buffer) => {
      handlers.onData(data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data));
    });
    socket.on('close', () => handlers.onClose());
    socket.on('error', (error: Error) => handlers.onError(error));
    return {
      async send(chunk) {
        socket.send(chunk);
      },
      close: () => socket.close(),
    };
  };
}

let workDir: string;
let registryDir: string;
let sessionSocket: ProtocolSocket | undefined;
let web: WebServer | undefined;
let client: Client | undefined;
let binding: RemoteServiceBinding | undefined;
let agent: ReturnType<typeof fakeAgent>;

beforeEach(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-hub-protocol-'));
  registryDir = path.join(workDir, 'registry');
  fs.mkdirSync(path.join(registryDir, 'sessions'), { recursive: true });

  agent = fakeAgent();
  sessionSocket = await serveProtocolSocket({
    socketPath: path.join(workDir, 'p.sock'),
    service: createAgentServerService({
      agent,
      sessionId: SESSION_ID,
      sessionName: 'probe',
      cwd: workDir,
      createdAt: 1,
    }),
  });

  fs.writeFileSync(
    path.join(registryDir, 'sessions', `${SESSION_ID}.json`),
    JSON.stringify({
      version: 1,
      id: SESSION_ID,
      name: 'probe',
      cwd: workDir,
      socketPath: path.join(workDir, 'unused.sock'),
      tokenFile: path.join(workDir, 'unused.token'),
      protocolSocketPath: sessionSocket.socketPath,
      protocolServerId: sessionSocket.serverId,
      pid: process.pid,
      createdAt: new Date(1).toISOString(),
    }),
  );

  web = await serveWeb({
    port: 0,
    registryDir,
    assetsDir: workDir,
    remoteStateDir: path.join(workDir, 'remote-state'),
  });
  // The registry is polled, so give the hub a moment to notice the session.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = await fetch(`${web.url}/api/health`).then(
      (response) => response.json() as Promise<{ sessions: number }>,
    );
    if (probe.sessions > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

afterEach(async () => {
  await binding?.dispose(BACKGROUND_CONTEXT).catch(() => undefined);
  await client?.dispose().catch(() => undefined);
  await web?.close();
  await sessionSocket?.close();
  binding = undefined;
  client = undefined;
  web = undefined;
  sessionSocket = undefined;
  fs.rmSync(workDir, { recursive: true, force: true });
});

async function connect(sessionId = SESSION_ID): Promise<{ client: Client; session: SessionService }> {
  const connected = new Client({
    serverId: DOOM_COCKPIT_SERVER_ID,
    transportFactory: webSocketTransport(`${web?.url.replace('http://', 'ws://')}/api/pi`),
  });
  await connected.connect();
  client = connected;
  await connected.request(
    { serverId: DOOM_COCKPIT_SERVER_ID },
    { serviceId: DoomSessionManagementService.id, member: 'attach', args: [sessionId] },
  );
  const next = createRemoteServiceBinding({
    services: [DoomSessionService],
    transport: createClientServiceTransport(connected, () => connected.attachment),
  });
  const session = next.use(DoomSessionService);
  await next.ready(BACKGROUND_CONTEXT);
  binding = next;
  return { client: connected, session };
}

/**
 * The cockpit's protocol endpoint, driven by Pi's own client.
 *
 * This is the path the browser takes, minus the browser: a WebSocket carrying
 * CBOR to the hub, which dials the session's socket and forwards. A failure
 * here is a failure the page would have hit.
 */
describe('hub protocol endpoint', () => {
  it('publishes session management over the cockpit endpoint', async () => {
    const { client: connected } = await connect();

    await expect(connected.serviceCatalogue({ serverId: DOOM_COCKPIT_SERVER_ID })).resolves.toContainEqual({
      serviceId: DoomSessionManagementService.id,
      mode: 'singleton',
    });
  });

  it('attaches through to the session server and reports its snapshot', async () => {
    const { session } = await connect();

    expect(session.state.value!.snapshot).toMatchObject({ id: SESSION_ID, phase: 'idle' });
  });

  it('carries a turn from the agent to the client across both hops', async () => {
    const { session } = await connect();

    const prompting = session.prompt('what changed?', BACKGROUND_CONTEXT);
    for (let attempt = 0; attempt < 60 && agent.sent.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(agent.sent).toContainEqual({ type: 'prompt', message: 'what changed?' });

    agent.emit({ type: 'agent_start' });
    agent.emit({ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } });
    agent.emit({
      type: 'message_end',
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'a file' }], stopReason: 'stop' },
    });
    agent.emit({ type: 'agent_settled' });

    await prompting;
    for (let attempt = 0; attempt < 60 && session.state.value?.snapshot.phase !== 'idle'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const settled = session.state.value!.snapshot;

    expect(settled.phase).toBe('idle');
    expect(settled.transcript[0]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'a file' }] });
  });

  it('refuses a session the registry does not list', async () => {
    await expect(connect('no-such-session')).rejects.toThrow();
  });

  it('invalidates a stopped upstream and streams from its replacement on the same browser connection', async () => {
    const { client: connected } = await connect();
    const socketPath = sessionSocket!.socketPath;
    const previousServerId = sessionSocket!.serverId;
    await sessionSocket!.close();
    sessionSocket = undefined;

    await vi.waitFor(() => expect(connected.attachment).toBeUndefined());
    expect(connected.connected).toBe(true);
    await binding!.dispose(BACKGROUND_CONTEXT).catch(() => undefined);
    binding = undefined;

    agent = fakeAgent();
    sessionSocket = await serveProtocolSocket({
      socketPath,
      service: createAgentServerService({
        agent,
        sessionId: SESSION_ID,
        sessionName: 'replacement',
        cwd: workDir,
        createdAt: 2,
      }),
    });
    expect(sessionSocket.serverId).not.toBe(previousServerId);
    const recordPath = path.join(registryDir, 'sessions', `${SESSION_ID}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(recordPath, JSON.stringify({ ...record, protocolServerId: sessionSocket.serverId }));

    // The registry can still contain the old server identity during restart.
    await vi.waitFor(
      async () => {
        await connected.request(
          { serverId: DOOM_COCKPIT_SERVER_ID },
          { serviceId: DoomSessionManagementService.id, member: 'attach', args: [SESSION_ID] },
        );
      },
      { timeout: 5000 },
    );
    binding = createRemoteServiceBinding({
      services: [DoomSessionService],
      transport: createClientServiceTransport(connected, () => connected.attachment),
    });
    const session = binding.use(DoomSessionService);
    await binding.ready(BACKGROUND_CONTEXT);
    agent.emit({ type: 'agent_start' });
    agent.emit({ type: 'message_start', message: { id: 'after-restart', role: 'assistant', content: [] } });
    agent.emit({
      type: 'message_end',
      message: {
        id: 'after-restart',
        role: 'assistant',
        content: [{ type: 'text', text: 'live again' }],
        stopReason: 'stop',
      },
    });
    await vi.waitFor(() =>
      expect(session.state.value?.snapshot.transcript).toContainEqual(
        expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'live again' }] }),
      ),
    );
    expect(connected.connected).toBe(true);
  });
});
