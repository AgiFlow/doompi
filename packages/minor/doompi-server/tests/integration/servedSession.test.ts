import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnAgentProcess } from '../../src/adapters/agentProcess.ts';
import { serveSessionSocket, type SessionSocket } from '../../src/adapters/socketServer.ts';
import { createFrameDecoder, encodeFrame } from '../../src/services/sessionFraming.ts';
import type { AgentProcess, SessionFrame } from '../../src/types/session.ts';

const TOKEN = 'integration-token-123456';

/** Stands in for `pi --mode rpc`: reads command frames, answers with events. */
const FAKE_AGENT = `
let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  const lines = buffered.split('\\n');
  buffered = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type === 'prompt') {
      process.stdout.write(JSON.stringify({ type: 'message_start' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'message_end', echo: command.message }) + '\\n');
    }
    if (command.type === 'quit') process.exit(0);
  }
});
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function startFakeAgent(): { agent: AgentProcess; directory: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-served-'));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scriptPath = path.join(directory, 'agent.mjs');
  fs.writeFileSync(scriptPath, FAKE_AGENT);
  const agent = spawnAgentProcess({
    command: process.execPath,
    args: [scriptPath],
    cwd: directory,
    env: process.env,
  });
  cleanups.push(() => {
    agent.stop();
  });
  return { agent, directory };
}

async function attach(socketPath: string): Promise<{ socket: net.Socket; frames: SessionFrame[] }> {
  const frames: SessionFrame[] = [];
  const decode = createFrameDecoder();
  const socket = net.createConnection({ path: socketPath });
  cleanups.push(() => {
    socket.destroy();
  });
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => frames.push(...decode(chunk)));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(encodeFrame({ type: 'attach', token: TOKEN }));
  return { socket, frames };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe('a served agent session', () => {
  it('carries a prompt to the agent and its events back to the client', async () => {
    const { agent, directory } = startFakeAgent();
    const socketPath = path.join(directory, 'session.sock');
    const served: SessionSocket = serveSessionSocket({ socketPath, token: TOKEN, agent });
    cleanups.push(() => served.close());

    const client = await attach(socketPath);
    await waitFor(() => client.frames.length > 0, 'the handshake');
    client.socket.write(encodeFrame({ type: 'prompt', message: 'ping' }));
    await waitFor(() => client.frames.length >= 3, 'the agent events');

    expect(client.frames[0]).toEqual({ type: 'attached', replayed: 0, dropped: 0 });
    expect(client.frames[1]).toEqual({ type: 'message_start' });
    expect(client.frames[2]).toEqual({ type: 'message_end', echo: 'ping' });
  });

  it('keeps the agent running across a client reconnect and replays what it missed', async () => {
    const { agent, directory } = startFakeAgent();
    const socketPath = path.join(directory, 'session.sock');
    const served: SessionSocket = serveSessionSocket({ socketPath, token: TOKEN, agent });
    cleanups.push(() => served.close());

    const first = await attach(socketPath);
    await waitFor(() => first.frames.length > 0, 'the first handshake');
    first.socket.destroy();
    await waitFor(() => !served.attached, 'the detach');

    agent.send({ type: 'prompt', message: 'while away' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = await attach(socketPath);
    await waitFor(() => second.frames.length >= 3, 'the replayed events');

    expect(second.frames[0]).toEqual({ type: 'attached', replayed: 2, dropped: 0 });
    expect(second.frames[2]).toEqual({
      type: 'replay',
      frame: { type: 'message_end', echo: 'while away' },
    });
  });

  it('reports the agent exit code to whoever started the server', async () => {
    const { agent } = startFakeAgent();

    agent.send({ type: 'quit' });

    await expect(agent.exited).resolves.toBe(0);
  });
});
