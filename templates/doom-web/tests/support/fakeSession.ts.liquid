import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export type Frame = Record<string, unknown>;

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
  const socketPath = path.join(dir, 'session.sock');
  const tokenFile = path.join(dir, 'token');
  const token = `tok-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });

  const backlogLimit = options.backlogLimit ?? 512;
  const received: Frame[] = [];
  let client: net.Socket | undefined;
  let backlog: Frame[] = [];
  let dropped = 0;
  const attachWaiters: Array<() => void> = [];
  const commandWaiters: Array<{ type: string; resolve: (frame: Frame) => void }> = [];

  const server = net.createServer((connection) => {
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
        name: options.name ?? 'untitled',
        cwd: options.cwd ?? dir,
        socketPath,
        tokenFile,
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
    close() {
      client?.destroy();
      if (recordPath !== undefined) fs.rmSync(recordPath, { force: true });
      return new Promise<void>((resolve) => {
        server.close(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      });
    },
  };
}
