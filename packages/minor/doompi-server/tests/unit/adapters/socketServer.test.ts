import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeStaleSocket, serveSessionSocket, type SessionSocket } from '../../../src/adapters/socketServer.ts';
import { createFrameDecoder, encodeFrame } from '../../../src/services/sessionFraming.ts';
import type { AgentProcess, SessionFrame } from '../../../src/types/session.ts';

const TOKEN = 'attach-token-abcdefghij';
const sockets: SessionSocket[] = [];
const clients: net.Socket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const socket of sockets.splice(0)) await socket.close();
});

interface FakeAgent extends AgentProcess {
  emit(frame: SessionFrame): void;
  readonly received: SessionFrame[];
}

function fakeAgent(): FakeAgent {
  const listeners: Array<(frame: SessionFrame) => void> = [];
  const received: SessionFrame[] = [];
  return {
    received,
    send: (frame) => received.push(frame),
    onFrame: (listener) => listeners.push(listener),
    emit: (frame) => {
      for (const listener of listeners) listener(frame);
    },
    exited: new Promise<number>(() => undefined),
    stop: () => undefined,
  };
}

function startSocket(agent: AgentProcess, backlogLimit?: number): string {
  const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-server-')), 'session.sock');
  sockets.push(serveSessionSocket({ socketPath, token: TOKEN, agent, backlogLimit }));
  return socketPath;
}

/** Connects and collects decoded frames as they arrive. */
async function connect(socketPath: string): Promise<{ socket: net.Socket; frames: SessionFrame[] }> {
  const frames: SessionFrame[] = [];
  const decode = createFrameDecoder();
  const socket = net.createConnection({ path: socketPath });
  clients.push(socket);
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => frames.push(...decode(chunk)));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return { socket, frames };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe('serveSessionSocket', () => {
  it('creates an owner-only socket', async () => {
    const socketPath = startSocket(fakeAgent());
    await waitFor(() => fs.existsSync(socketPath), 'the socket file');

    expect(fs.statSync(socketPath).mode & 0o077).toBe(0);
  });

  it('accepts a client presenting the token and forwards frames both ways', async () => {
    const agent = fakeAgent();
    const socketPath = startSocket(agent);
    const client = await connect(socketPath);

    client.socket.write(encodeFrame({ type: 'attach', token: TOKEN }));
    await waitFor(() => client.frames.length > 0, 'the handshake reply');
    expect(client.frames[0]).toEqual({ type: 'attached', replayed: 0, dropped: 0 });

    client.socket.write(encodeFrame({ type: 'prompt', message: 'hello' }));
    await waitFor(() => agent.received.length > 0, 'the forwarded prompt');
    expect(agent.received[0]).toEqual({ type: 'prompt', message: 'hello' });

    agent.emit({ type: 'message_update', text: 'hi' });
    await waitFor(() => client.frames.length > 1, 'the agent event');
    expect(client.frames[1]).toEqual({ type: 'message_update', text: 'hi' });
  });

  it('refuses a wrong token and never reaches the agent', async () => {
    const agent = fakeAgent();
    const socketPath = startSocket(agent);
    const client = await connect(socketPath);

    client.socket.write(encodeFrame({ type: 'attach', token: 'wrong-token-aaaaaaaaa' }));
    await waitFor(() => client.frames.length > 0, 'the rejection');

    expect(client.frames[0]?.type).toBe('attach_error');
    expect(agent.received).toEqual([]);
  });

  it('refuses a client that skips the handshake', async () => {
    const agent = fakeAgent();
    const socketPath = startSocket(agent);
    const client = await connect(socketPath);

    client.socket.write(encodeFrame({ type: 'prompt', message: 'sneak' }));
    await waitFor(() => client.frames.length > 0, 'the rejection');

    expect(client.frames[0]?.type).toBe('attach_error');
    expect(agent.received).toEqual([]);
  });

  it('keeps the session for the attached client when a second one arrives', async () => {
    const socketPath = startSocket(fakeAgent());
    const first = await connect(socketPath);
    first.socket.write(encodeFrame({ type: 'attach', token: TOKEN }));
    await waitFor(() => first.frames.length > 0, 'the first handshake');

    const second = await connect(socketPath);
    second.socket.write(encodeFrame({ type: 'attach', token: TOKEN }));
    await waitFor(() => second.frames.length > 0, 'the second rejection');

    expect(second.frames[0]).toEqual({
      type: 'attach_error',
      reason: 'Another client already holds this session.',
    });
  });

  it('buffers while detached and replays on reattach', async () => {
    const agent = fakeAgent();
    const socketPath = startSocket(agent);
    const first = await connect(socketPath);
    first.socket.write(encodeFrame({ type: 'attach', token: TOKEN }));
    await waitFor(() => first.frames.length > 0, 'the first handshake');

    first.socket.destroy();
    await waitFor(() => !sockets[0]?.attached, 'the detach');
    agent.emit({ type: 'message_update', text: 'while away' });

    const second = await connect(socketPath);
    second.socket.write(encodeFrame({ type: 'attach', token: TOKEN }));
    await waitFor(() => second.frames.length > 1, 'the replay');

    expect(second.frames[0]).toEqual({ type: 'attached', replayed: 1, dropped: 0 });
    expect(second.frames[1]).toEqual({ type: 'replay', frame: { type: 'message_update', text: 'while away' } });
  });

  it('lets a restarted server reclaim the path a crash left behind', async () => {
    const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-server-')), 'session.sock');
    // A crashed server leaves a path nothing answers on; a plain file behaves
    // the same way for the probe.
    fs.writeFileSync(socketPath, '');

    await removeStaleSocket(socketPath);
    expect(fs.existsSync(socketPath)).toBe(false);

    const agent = fakeAgent();
    sockets.push(serveSessionSocket({ socketPath, token: TOKEN, agent }));
    await waitFor(() => fs.existsSync(socketPath), 'the reclaimed socket');
  });

  it('leaves a live socket alone', async () => {
    const socketPath = startSocket(fakeAgent());
    await waitFor(() => fs.existsSync(socketPath), 'the socket file');

    await removeStaleSocket(socketPath);
    expect(fs.existsSync(socketPath)).toBe(true);

    const client = await connect(socketPath);
    client.socket.write(encodeFrame({ type: 'attach', token: TOKEN }));
    await waitFor(() => client.frames.length > 0, 'the handshake reply');
    expect(client.frames[0]?.type).toBe('attached');
  });

  it('reports frames dropped past the backlog limit', async () => {
    const agent = fakeAgent();
    const socketPath = startSocket(agent, 1);
    agent.emit({ index: 1 });
    agent.emit({ index: 2 });

    const client = await connect(socketPath);
    client.socket.write(encodeFrame({ type: 'attach', token: TOKEN }));
    await waitFor(() => client.frames.length > 1, 'the replay');

    expect(client.frames[0]).toEqual({ type: 'attached', replayed: 1, dropped: 1 });
    expect(client.frames[1]).toEqual({ type: 'replay', frame: { index: 2 } });
  });
});
