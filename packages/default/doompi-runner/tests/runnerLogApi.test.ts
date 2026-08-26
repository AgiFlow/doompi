import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunnerLogApi } from '../src/adapters/runnerLogApi.ts';
import { runnerStateDirFor } from '../src/adapters/webRunnerWatcher.ts';
import type { RunnerRecord } from '../src/types/runnerRegistry';
import type { ILogTail, LogTailHandle, LogTailOptions } from '../src/types/logTail.ts';
import type { RunnerLogResponse, RunnerLogStreamEvent } from '../src/types/webRunnerLog.ts';

const SESSION = 'session-a';
const RUN = 'runner-a';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function freshStore(): string {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-runner-api-'));
  cleanups.push(() => fs.rmSync(store, { recursive: true, force: true }));
  return store;
}

/** Writes a runner record and its log the way the registry lays them out. */
function writeRun(store: string, overrides: Partial<RunnerRecord> = {}, logText?: string): RunnerRecord {
  const logsDir = path.join(store, SESSION, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const record: RunnerRecord = {
    id: RUN,
    name: 'playwriter',
    pid: 42,
    command: 'playwriter -s 8',
    cwd: '/repo',
    logPath: path.join(logsDir, `${overrides.id ?? RUN}.log`),
    interactive: false,
    sessionId: SESSION,
    startedAt: new Date().toISOString(),
    state: 'running',
    promoted: true,
    backend: 'native',
    hostPid: 7,
    ...overrides,
  };
  const stateDir = runnerStateDirFor(store, record.sessionId);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, `${record.id}.json`), JSON.stringify(record));
  if (logText !== undefined) fs.writeFileSync(record.logPath, logText);
  return record;
}

function logUrl(runId: string, query = ''): string {
  return `http://session/runners/${runId}/log${query}`;
}

/** The app as a session server mounts it: one session, named once at start. */
function appFor(store: string, sessionId = SESSION) {
  return createRunnerLogApi({ storeDir: store, sessionId });
}

describe('the runner log API', () => {
  it('answers a bounded tail of the run its record names', async () => {
    const store = freshStore();
    writeRun(store, {}, 'first\nsecond\nthird\n');
    const app = appFor(store);

    const response = await app.fetch(new Request(logUrl(RUN)));
    expect(response.status).toBe(200);
    const body = (await response.json()) as RunnerLogResponse;
    expect(body.runId).toBe(RUN);
    expect(body.running).toBe(true);
    expect(body.exists).toBe(true);
    expect(body.totalLines).toBe(3);
    expect(body.text.split('\n').filter((line) => line !== '')).toEqual(['first', 'second', 'third']);
  });

  it('greps a literal substring with context, case-folded on request', async () => {
    const store = freshStore();
    writeRun(store, {}, 'alpha\nNEEDLE here\nbravo\ncharlie\nneedle again\ndelta\n');
    const app = appFor(store);

    const matched = await app.fetch(new Request(logUrl(RUN, '?grep=needle&ignoreCase=true&contextLines=1')));
    const body = (await matched.json()) as RunnerLogResponse;
    const lines = body.text.split('\n').filter((line) => line !== '');
    expect(lines).toEqual(['alpha', 'NEEDLE here', 'bravo', 'charlie', 'needle again', 'delta']);
    // The whole file is still reported, so a filtered view can say what it left out.
    expect(body.totalLines).toBe(6);

    const exact = await app.fetch(new Request(logUrl(RUN, '?grep=NEEDLE')));
    const exactBody = (await exact.json()) as RunnerLogResponse;
    expect(exactBody.text.split('\n').filter((line) => line !== '')).toEqual(['NEEDLE here']);
  });

  it('reports a run whose log file does not exist yet rather than failing', async () => {
    const store = freshStore();
    writeRun(store);
    const app = appFor(store);

    const body = (await (await app.fetch(new Request(logUrl(RUN)))).json()) as RunnerLogResponse;
    expect(body.exists).toBe(false);
    expect(body.text).toBe('');
  });

  it('reports a finished run as not running, so the page stops offering to follow it', async () => {
    const store = freshStore();
    writeRun(
      store,
      {
        state: 'completed',
        exit: { reason: 'completed', code: 0, signal: null, finishedAt: new Date().toISOString() },
      },
      'done\n',
    );
    const app = appFor(store);

    const body = (await (await app.fetch(new Request(logUrl(RUN)))).json()) as RunnerLogResponse;
    expect(body.running).toBe(false);
  });

  it('refuses a runner the session does not have', async () => {
    const store = freshStore();
    writeRun(store, {}, 'x\n');
    const app = appFor(store);

    expect((await app.fetch(new Request(logUrl('nope')))).status).toBe(404);
  });

  it("cannot reach another session's runs, because the session is the host", async () => {
    const store = freshStore();
    writeRun(store, {}, 'x\n');
    // Same store on disk, a server that owns a different session: the run is
    // simply not there, and no parameter a caller could set would reach it.
    const app = appFor(store, 'a-different-session');

    expect((await app.fetch(new Request(logUrl(RUN)))).status).toBe(404);
  });

  it('never lets a runner id climb out of the session directory', async () => {
    const store = freshStore();
    writeRun(store, {}, 'x\n');
    const app = appFor(store);

    for (const runId of ['..', '..%2F..%2Fetc%2Fpasswd', 'a%2Fb']) {
      const response = await app.fetch(new Request(logUrl(SESSION, runId)));
      expect(response.status, runId).not.toBe(200);
    }
    for (const sessionId of ['..', '..%2F..', 'a%2Fb']) {
      const response = await app.fetch(new Request(logUrl(sessionId, RUN)));
      expect(response.status, sessionId).not.toBe(200);
    }
  });

  it('refuses a record whose log path points outside the session logs directory', async () => {
    const store = freshStore();
    const outside = path.join(store, 'elsewhere.log');
    fs.writeFileSync(outside, 'secret\n');
    // A record is written by another process, so its own claim about where its
    // log lives is checked rather than believed.
    writeRun(store, { logPath: outside });
    const app = appFor(store);

    expect((await app.fetch(new Request(logUrl(RUN)))).status).toBe(404);
  });

  it('streams appended lines and ends when the runner does', async () => {
    const store = freshStore();
    writeRun(store, {}, 'already read\n');
    let emit: ((lines: string[]) => void) | undefined;
    const logTail: ILogTail = {
      follow(_logPath: string, options: LogTailOptions): LogTailHandle {
        emit = options.onLines;
        return { close: () => undefined };
      },
    };
    const app = createRunnerLogApi({ storeDir: store, sessionId: SESSION, logTail });

    const response = await app.fetch(new Request(`${logUrl(RUN)}/stream?from=13`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    emit?.(['fresh line']);
    // The runner exiting is what ends the stream; the poll notices the record.
    writeRun(store, {
      state: 'completed',
      exit: { reason: 'completed', code: 0, signal: null, finishedAt: new Date().toISOString() },
    });

    const events: RunnerLogStreamEvent[] = [];
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = '';
    while (events.every((event) => event.ended !== true)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += value;
      for (const chunk of buffered.split('\n\n')) {
        const data = /^data: (.*)$/m.exec(chunk);
        if (data?.[1] !== undefined) events.push(JSON.parse(data[1]) as RunnerLogStreamEvent);
      }
      buffered = '';
    }

    expect(events.some((event) => event.lines.includes('fresh line'))).toBe(true);
    expect(events.at(-1)?.ended).toBe(true);
  }, 15_000);
});
