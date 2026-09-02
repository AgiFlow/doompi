import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

// Self-contained mirror of doom-runner's per-session store layout: the e2e
// suite writes real metadata records the doompi-runner plugin's watcher
// reads, so this fixture depends on that package's disk contract, not on any
// source.
const STATE_DIR_NAME = 'runs';

export interface RunnerRecordFixture {
  id: string;
  name: string;
  command: string;
  /** Merged over the minimal valid running record; pass state, exit, etc. here. */
  record?: Record<string, unknown>;
  /** Written to the run's log file, which the log API reads back through the record. */
  logText?: string;
}

/** Writes one runner record the way doom-runner's registry lays it out. */
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
    hostPid: process.pid,
    ...fixture.record,
  };
  if (fixture.logText !== undefined) {
    fs.mkdirSync(path.dirname(record.logPath), { recursive: true });
    fs.writeFileSync(record.logPath, fixture.logText);
  }
  fs.writeFileSync(path.join(stateDir, `${fixture.id}.json`), JSON.stringify(record));
}

/** Appends to a run's log the way the runner would while it keeps working. */
export function appendRunnerLog(storeDir: string, sessionId: string, runId: string, text: string): void {
  fs.appendFileSync(path.join(storeDir, sessionId, 'logs', `${runId}.log`), text);
}

/**
 * A stand-in for the runner package's session API, served the way
 * doompi-server serves one: HTTP on a unix socket, routes under the package's
 * base path with the mount prefix stripped.
 *
 * Like the record writer above, this mirrors doom-runner's disk contract
 * rather than importing its source, so the cockpit's suite stays independent
 * of that package's build.
 */
export function startRunnerApiSocket(storeDir: string, sessionId: string, socketPath: string): () => Promise<void> {
  const server = http.createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', 'http://session.local');
    const streaming = /^\/api\/plugin\/runner\/runners\/([^/]+)\/log\/stream$/u.exec(url.pathname);
    if (streaming) {
      // The follow half of the same contract: server-sent events carrying the
      // lines written after `from`, polled off the file the way the real route
      // tails it. Only what the cockpit reads is implemented.
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
  server.listen(socketPath);
  return () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        fs.rmSync(socketPath, { force: true });
        resolve();
      });
    });
}
