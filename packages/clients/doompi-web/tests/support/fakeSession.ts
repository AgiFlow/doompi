import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createAgentServerService, serveProtocolSocket } from '@agimon-ai/doompi-server';
import type { SessionSnapshot, TranscriptItem } from '@earendil-works/pi-protocol';
export type Frame = Record<string, unknown>;
type ToolContent = Extract<TranscriptItem, { role: 'tool' }>['content'];
export interface FakeSession {
  readonly id: string;
  readonly socketPath: string;
  readonly token: string;
  readonly tokenFile: string;
  readonly received: Frame[];
  /** Pushes a frame to the attached client, or buffers it when nobody is attached. */
  emit(frame: Frame): void;
  waitForAttach(timeoutMs?: number): Promise<void>;
  waitForCommand(type: string, timeoutMs?: number): Promise<Frame>;
  /** Drops the current client without stopping the session, as a crash would. */
  dropClient(): void;
  /**
   * Takes the session from a rival client and returns a function that releases
   * it, so a refusal can be observed and then recovered from.
   */
  holdFromAnotherClient(): Promise<() => void>;
  close(): Promise<void>;
}

const encode = (frame: Frame): string => `${JSON.stringify(frame)}\n`;

const stringValue = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

let fakeSessionCounter = 0;

/** Registers a session whose server is long gone, for exercising the janitor. */
export function writeStaleRecord(registryDir: string, id = `stale-${(fakeSessionCounter += 1)}`): string {
  const recordsDir = path.join(registryDir, 'sessions');
  fs.mkdirSync(recordsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(recordsDir, `${id}.json`),
    JSON.stringify({
      version: 1,
      id,
      name: 'stale',
      cwd: '/nowhere',
      socketPath: `/nowhere/${id}.sock`,
      tokenFile: `/nowhere/${id}.token`,
      // A pid this test machine cannot plausibly be running.
      pid: 2 ** 30,
      createdAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  return id;
}

export interface FakeSessionOptions {
  backlogLimit?: number;
  id?: string;
  name?: string;
  cwd?: string;
  /** When given, the fake registers itself like a real doompi-server would. */
  registryDir?: string;
  /** The pid the record claims; defaults to this process, which keeps the record alive for the watcher. */
  pid?: number;
  /** Where this session serves its package APIs, as a real server would record it. */
  apiSocketPath?: string;
}

function fixtureTranscript(id: string, cwd: string, name: string) {
  const now = Date.now();
  let revision = 0;
  let nextId = 1;
  let activeAssistantId: string | undefined;
  let snapshot: SessionSnapshot = {
    id,
    cwd,
    name,
    createdAt: now,
    updatedAt: now,
    phase: 'idle',
    model: { provider: 'unknown', id: 'unknown' },
    thinkingLevel: 'medium',
    attached: false,
    locked: false,
    revision,
    transcript: [],
    queuedSteer: [],
    queuedSteerCount: 0,
  };

  const commit = (updates: Partial<SessionSnapshot>): SessionSnapshot => {
    revision += 1;
    snapshot = { ...snapshot, ...updates, revision, updatedAt: Date.now() };
    return snapshot;
  };

  const journalTranscript = (entries: unknown[]): TranscriptItem[] => {
    const transcript: TranscriptItem[] = [];
    for (const raw of entries) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as Frame;
      const message =
        typeof entry.message === 'object' && entry.message !== null ? (entry.message as Frame) : undefined;
      const content: Frame[] = Array.isArray(message?.content)
        ? (message.content as Frame[])
        : typeof message?.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : [];
      const textContent = content
        .filter((part) => part.type === 'text')
        .map((part) => ({ type: 'text' as const, text: stringValue(part.text) }));
      if (message?.role === 'user') {
        transcript.push({
          id: String(entry.id),
          role: 'user',
          content: textContent,
          timestamp: now,
        });
      } else if (message?.role === 'assistant') {
        const assistantId = String(entry.id);
        const assistantContent: Extract<TranscriptItem, { role: 'assistant' }>['content'] = [];
        for (const part of content) {
          if (part.type === 'text') assistantContent.push({ type: 'text', text: stringValue(part.text) });
          else if (part.type === 'thinking')
            assistantContent.push({ type: 'thinking', thinking: stringValue(part.thinking) });
        }
        transcript.push({
          id: assistantId,
          role: 'assistant',
          content: assistantContent,
          model: { provider: 'unknown', id: 'unknown' },
          status: 'complete',
          stopReason: 'stop',
          timestamp: now,
        });
        for (const part of content) {
          if (part.type !== 'toolCall') continue;
          transcript.push({
            id: String(part.id),
            role: 'tool',
            toolCallId: String(part.id),
            toolName: stringValue(part.name, 'tool'),
            input: (typeof part.arguments === 'object' && part.arguments !== null ? part.arguments : {}) as never,
            content: [],
            status: 'running',
            isError: false,
            timestamp: now,
          });
        }
      } else if (message?.role === 'toolResult') {
        const toolCallId = String(message.toolCallId);
        const index = transcript.findIndex((item) => item.role === 'tool' && item.toolCallId === toolCallId);
        if (index === -1) continue;
        const tool = transcript[index];
        if (tool?.role !== 'tool') continue;
        const completed = { ...tool, content: textContent };
        transcript[index] =
          message.isError === true
            ? { ...completed, status: 'error', isError: true }
            : { ...completed, status: 'complete', isError: false };
      }
    }
    return transcript;
  };

  return {
    snapshot: () => structuredClone(snapshot),
    phase: () => snapshot.phase,
    apply(frame: Frame) {
      const transcript = [...snapshot.transcript];
      if (frame.type === 'agent_start') return { snapshot: commit({ phase: 'turn' }) };
      if (frame.type === 'agent_settled') {
        if (activeAssistantId) {
          const index = transcript.findIndex((item) => item.id === activeAssistantId);
          const assistant = transcript[index];
          if (assistant?.role === 'assistant')
            transcript[index] = { ...assistant, status: 'complete', stopReason: 'stop' };
          activeAssistantId = undefined;
        }
        return { snapshot: commit({ phase: 'idle', transcript }) };
      }
      if (frame.type === 'message_update') {
        const event = typeof frame.assistantMessageEvent === 'object' ? (frame.assistantMessageEvent as Frame) : {};
        if (!activeAssistantId) {
          activeAssistantId = `assistant-${nextId++}`;
          transcript.push({
            id: activeAssistantId,
            role: 'assistant',
            content: [],
            model: { provider: 'unknown', id: 'unknown' },
            status: 'streaming',
            timestamp: now,
          });
        }
        const index = transcript.findIndex((item) => item.id === activeAssistantId);
        const assistant = transcript[index];
        if (assistant?.role !== 'assistant') return {};
        const kind = event.type === 'thinking_delta' ? 'thinking' : 'text';
        const current = assistant.content.find((part) => part.type === kind);
        const value =
          kind === 'thinking' && current?.type === 'thinking'
            ? current.thinking
            : current?.type === 'text'
              ? current.text
              : '';
        const delta = stringValue(event.delta);
        const part =
          kind === 'thinking'
            ? ({ type: 'thinking', thinking: value + delta } as const)
            : ({ type: 'text', text: value + delta } as const);
        transcript[index] = {
          ...assistant,
          content: [...assistant.content.filter((item) => item.type !== kind), part],
        };
        return { snapshot: commit({ transcript }) };
      }
      if (frame.type === 'tool_execution_start') {
        transcript.push({
          id: String(frame.toolCallId),
          role: 'tool',
          toolCallId: String(frame.toolCallId),
          toolName: stringValue(frame.toolName, 'tool'),
          input: (typeof frame.args === 'object' && frame.args !== null ? frame.args : {}) as never,
          content: [],
          status: 'running',
          isError: false,
          timestamp: now,
        });
        return { snapshot: commit({ transcript }) };
      }
      if (frame.type === 'tool_execution_update' || frame.type === 'tool_execution_end') {
        const index = transcript.findIndex((item) => item.role === 'tool' && item.toolCallId === frame.toolCallId);
        const tool = transcript[index];
        if (tool?.role !== 'tool') return {};
        const result = (frame.type === 'tool_execution_update' ? frame.partialResult : frame.result) as
          | Frame
          | undefined;
        const content: ToolContent = Array.isArray(result?.content)
          ? (result.content as Frame[]).flatMap<ToolContent[number]>((part) => {
              if (part.type === 'text') return [{ type: 'text' as const, text: stringValue(part.text) }];
              if (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
                return [{ type: 'image' as const, data: part.data, mimeType: part.mimeType }];
              }
              return [];
            })
          : tool.content;
        if (frame.type === 'tool_execution_update') {
          transcript[index] = { ...tool, content, details: result as never };
        } else {
          const completed = {
            ...tool,
            content,
            ...(result?.details === undefined ? {} : { details: result.details as never }),
          };
          transcript[index] =
            frame.isError === true
              ? { ...completed, status: 'error', isError: true }
              : { ...completed, status: 'complete', isError: false };
        }
        return { snapshot: commit({ transcript }) };
      }
      if (frame.type === 'response' && frame.command === 'get_entries') {
        const data = typeof frame.data === 'object' && frame.data !== null ? (frame.data as Frame) : {};
        const entries = Array.isArray(data.entries) ? data.entries : [];
        return { snapshot: commit({ transcript: journalTranscript(entries).slice(-300) }) };
      }
      return {};
    },
  };
}

/**
 * A stand-in for doompi-server's socket.
 *
 * The cockpit is the thing under test, so the session it attaches to has to be
 * scriptable and instant; a real agent would make these tests depend on a model.
 */
export async function startFakeSession(options: FakeSessionOptions = {}): Promise<FakeSession> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-e2e-'));
  const id = options.id ?? `fake-${(fakeSessionCounter += 1)}`;
  const name = options.name ?? 'untitled';
  const cwd = options.cwd ?? dir;
  const socketPath = path.join(dir, 'session.sock');
  const tokenFile = path.join(dir, 'token');
  const token = `tok-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });

  const backlogLimit = options.backlogLimit ?? 512;
  const received: Frame[] = [];
  const connections = new Set<net.Socket>();
  let client: net.Socket | undefined;
  let closing = false;
  let backlog: Frame[] = [];
  let dropped = 0;
  const attachWaiters: Array<() => void> = [];
  const commandWaiters: Array<{ type: string; resolve: (frame: Frame) => void }> = [];
  const protocolListeners: Array<(frame: Frame) => void> = [];
  const protocolSocket = await serveProtocolSocket({
    socketPath: `${socketPath}.pi`,
    service: createAgentServerService({
      agent: {
        send: (frame: Frame) => received.push(frame),
        onFrame: (listener: (frame: Frame) => void) => protocolListeners.push(listener),
        exited: new Promise<number>(() => undefined),
        endInput: () => undefined,
        stop: () => undefined,
      },
      transcript: fixtureTranscript(id, cwd, name),
      sessionId: id,
      sessionName: name,
      cwd,
      createdAt: Date.now(),
    }),
  });
  const server = net.createServer((connection) => {
    connections.add(connection);
    if (closing) {
      connection.destroy();
      return;
    }
    connection.setEncoding('utf8');
    let buffered = '';
    let authenticated = false;

    connection.on('data', (chunk: string) => {
      buffered += chunk;
      const parts = buffered.split('\n');
      buffered = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.trim();
        if (!line) continue;
        const frame = JSON.parse(line) as Frame;

        if (!authenticated) {
          if (frame.type !== 'attach' || frame.token !== token) {
            connection.write(encode({ type: 'attach_error', reason: 'The attach token was rejected.' }));
            connection.destroy();
            return;
          }
          if (client) {
            connection.write(encode({ type: 'attach_error', reason: 'Another client already holds this session.' }));
            connection.destroy();
            return;
          }
          authenticated = true;
          client = connection;
          const drained = backlog;
          const lost = dropped;
          backlog = [];
          dropped = 0;
          connection.write(encode({ type: 'attached', replayed: drained.length, dropped: lost }));
          for (const missed of drained) connection.write(encode({ type: 'replay', frame: missed }));
          while (attachWaiters.length > 0) attachWaiters.shift()?.();
          continue;
        }

        received.push(frame);
        for (let index = commandWaiters.length - 1; index >= 0; index -= 1) {
          if (commandWaiters[index].type === frame.type) {
            commandWaiters[index].resolve(frame);
            commandWaiters.splice(index, 1);
          }
        }
      }
    });

    const detach = (): void => {
      connections.delete(connection);
      if (client === connection) client = undefined;
    };
    connection.on('close', detach);
    connection.on('error', detach);
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const recordPath =
    options.registryDir === undefined ? undefined : path.join(options.registryDir, 'sessions', `${id}.json`);
  if (recordPath !== undefined) {
    fs.mkdirSync(path.dirname(recordPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      recordPath,
      JSON.stringify({
        version: 1,
        id,
        name,
        cwd,
        socketPath,
        tokenFile,
        protocolSocketPath: protocolSocket.socketPath,
        ...(options.apiSocketPath === undefined ? {} : { apiSocketPath: options.apiSocketPath }),
        pid: options.pid ?? process.pid,
        createdAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
  }

  const waitFor = <T>(register: (resolve: (value: T) => void) => void, timeoutMs: number, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}.`)), timeoutMs);
      register((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });

  return {
    id,
    socketPath,
    token,
    tokenFile,
    received,
    emit(frame) {
      for (const listener of protocolListeners) listener(frame);
      if (client) {
        client.write(encode(frame));
        return;
      }
      backlog.push(frame);
      if (backlog.length > backlogLimit) {
        backlog = backlog.slice(backlog.length - backlogLimit);
        dropped += 1;
      }
    },
    waitForAttach(timeoutMs = 5000) {
      if (client) return Promise.resolve();
      return waitFor<void>((resolve) => attachWaiters.push(() => resolve()), timeoutMs, 'the cockpit to attach');
    },
    waitForCommand(type, timeoutMs = 5000) {
      const seen = received.find((frame) => frame.type === type);
      if (seen) return Promise.resolve(seen);
      return waitFor<Frame>(
        (resolve) => commandWaiters.push({ type, resolve }),
        timeoutMs,
        `a "${type}" command from the cockpit`,
      );
    },
    dropClient() {
      client?.destroy();
      client = undefined;
    },
    async holdFromAnotherClient() {
      client?.destroy();
      client = undefined;
      const rival = net.connect(socketPath);
      rival.setEncoding('utf8');
      await new Promise<void>((resolve, reject) => {
        rival.once('connect', () => {
          rival.write(encode({ type: 'attach', token }));
          resolve();
        });
        rival.once('error', reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      return () => rival.destroy();
    },
    async close() {
      closing = true;
      for (const connection of connections) connection.destroy();
      if (recordPath !== undefined) fs.rmSync(recordPath, { force: true });
      await protocolSocket.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
