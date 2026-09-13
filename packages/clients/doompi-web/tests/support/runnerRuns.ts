import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const STATE_DIR_NAME = 'runs';

export interface RunnerRecordFixture {
  id: string;
  name: string;
  command: string;
  record?: Record<string, unknown>;
  logText?: string;
}

export function writeRunnerRecord(storeDir: string, sessionId: string, fixture: RunnerRecordFixture): void {
  const stateDir = path.join(storeDir, sessionId, STATE_DIR_NAME);
  fs.mkdirSync(stateDir, { recursive: true });
  const record = {
    id: fixture.id,
    name: fixture.name,
    pid: 4242,
    command: fixture.command,
    cwd: '/workspace/doompi',
    logPath: path.join(storeDir, sessionId, 'logs', `${fixture.id}.log`),
    interactive: false,
    sessionId,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    state: 'running',
    promoted: true,
    backend: 'native',
    hostPid: 4242,
    ...fixture.record,
  };
  if (fixture.logText !== undefined) {
    fs.mkdirSync(path.dirname(record.logPath), { recursive: true });
    fs.writeFileSync(record.logPath, fixture.logText);
  }
  fs.writeFileSync(path.join(stateDir, `${fixture.id}.json`), JSON.stringify(record));
}

export function appendRunnerLog(storeDir: string, sessionId: string, runId: string, text: string): void {
  fs.appendFileSync(path.join(storeDir, sessionId, 'logs', `${runId}.log`), text);
}

export interface RunnerApiServer {
  readonly url: string;
  close(): Promise<void>;
}

/** A TCP package API fixture consumed through the headless server's public API boundary. */
export async function startRunnerApiServer(storeDir: string, sessionId: string): Promise<RunnerApiServer> {
  const server = http.createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', 'http://session.local');
    const streaming = /^\/api\/plugin\/runner\/runners\/([^/]+)\/log\/stream$/u.exec(url.pathname);
    if (streaming) {
      const runId = decodeURIComponent(streaming[1] ?? '');
      const logPath = path.join(storeDir, sessionId, 'logs', `${runId}.log`);
      let offset = Number.parseInt(url.searchParams.get('from') ?? '0', 10) || 0;
      outgoing.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const timer = setInterval(() => {
        const size = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
        if (size <= offset) return;
        const handle = fs.openSync(logPath, 'r');
        const buffer = Buffer.alloc(size - offset);
        fs.readSync(handle, buffer, 0, buffer.length, offset);
        fs.closeSync(handle);
        offset = size;
        const lines = buffer
          .toString('utf8')
          .split('\n')
          .filter((line) => line !== '');
        if (lines.length > 0) outgoing.write(`event: append\ndata: ${JSON.stringify({ lines })}\n\n`);
      }, 50);
      incoming.on('close', () => clearInterval(timer));
      return;
    }
    const match = /^\/api\/plugin\/runner\/runners\/([^/]+)\/log$/u.exec(url.pathname);
    if (!match) {
      outgoing.writeHead(404, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'Not found.' }));
      return;
    }
    const runId = decodeURIComponent(match[1] ?? '');
    const logPath = path.join(storeDir, sessionId, 'logs', `${runId}.log`);
    const whole = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    const all = whole.split('\n').filter((line) => line !== '');
    const grep = url.searchParams.get('grep');
    const context = Number.parseInt(url.searchParams.get('contextLines') ?? '0', 10) || 0;
    const kept = grep
      ? all.filter((_, index) => all.some((line, other) => line.includes(grep) && Math.abs(other - index) <= context))
      : all;
    outgoing.writeHead(200, { 'content-type': 'application/json' });
    outgoing.end(
      JSON.stringify({
        runId,
        running: true,
        text: kept.join('\n'),
        lineCount: kept.length,
        totalLines: all.length,
        fileSize: Buffer.byteLength(whole),
        path: logPath,
        exists: fs.existsSync(logPath),
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Runner fixture did not expose a TCP address.');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
