import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiClient } from '@earendil-works/pi-client';
import type { ByteTransport, ByteTransportHandlers } from '@earendil-works/pi-client';
import { createAgentServerService, type ProtocolSocket, serveProtocolSocket } from '@agimon-ai/doompi-server';
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
let client: PiClient | undefined;
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
  await client?.dispose().catch(() => undefined);
  await web?.close();
  await sessionSocket?.close();
  client = undefined;
  web = undefined;
  sessionSocket = undefined;
  fs.rmSync(workDir, { recursive: true, force: true });
});

async function connect(): Promise<PiClient> {
  const connected = new PiClient({
    transportFactory: webSocketTransport(`${web?.url.replace('http://', 'ws://')}/api/pi`),
  });
  await connected.connect();
  client = connected;
  return connected;
}

/**
 * The cockpit's protocol endpoint, driven by Pi's own client.
 *
 * This is the path the browser takes, minus the browser: a WebSocket carrying
 * CBOR to the hub, which dials the session's socket and forwards. A failure
 * here is a failure the page would have hit.
 */
describe('hub protocol endpoint', () => {
  it('lists the running sessions the registry knows', async () => {
    const connected = await connect();

    const sessions = await connected.listSessions();

    expect(sessions.map((session) => session.id)).toContain(SESSION_ID);
  });

  it('attaches through to the session server and reports its snapshot', async () => {
    const connected = await connect();

    const lease = await connected.attachSession(SESSION_ID);

    expect(lease.snapshot).toMatchObject({ id: SESSION_ID, phase: 'idle' });
  });

  it('carries a turn from the agent to the client across both hops', async () => {
    const connected = await connect();
    const lease = await connected.acquireSession(SESSION_ID, { mode: 'exclusive' });

    const prompting = lease.prompt('what changed?');
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

    const settled = await prompting;

    expect(settled.phase).toBe('idle');
    expect(settled.transcript[0]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'a file' }] });
  });

  it('refuses a session the registry does not list', async () => {
    const connected = await connect();

    await expect(connected.attachSession('no-such-session')).rejects.toThrow();
  });
});
