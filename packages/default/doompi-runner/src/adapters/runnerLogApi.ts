import fs from 'node:fs';
import path from 'node:path';
import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-extension-contracts/package-api';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { parseRunnerRecord } from '../services/webRunnerRuns.ts';
import type { ILogReader, LogQuery } from '../types/logReader.ts';
import type { ILogTail } from '../types/logTail.ts';
import type { RunnerRecord } from '../types/runnerRegistry';
import {
  RUNNER_API_BASE_PATH,
  RUNNER_LOG_PARAMS,
  RUNNER_LOG_STREAM_EVENT,
  type RunnerLogResponse,
  type RunnerLogStreamEvent,
} from '../types/webRunnerLog.ts';
import { LogReader } from './LogReader/LogReader.ts';
import { LogTail } from './LogTail/LogTail.ts';
import { resolveRunnerStoreDirectory } from './RunnerPaths.ts';
import { runnerStateDirFor } from './webRunnerWatcher.ts';

const LOG_DIR_NAME = 'logs';
const STATE_EXTENSION = '.json';
const RUNNING_STATE = 'running';
/** How often a follow re-reads the record to notice the runner exiting. */
const STATE_POLL_MS = 1000;
/** Kept in step with LogQuery's own default, so an unasked-for tail is the same size everywhere. */
const DEFAULT_LINES = 200;
/** A page that asks for more than this gets this; the whole point of the route is a bounded read. */
const MAX_LINES = 5000;
/** Path segments the client supplies are names, never paths. */
const SAFE_SEGMENT = /^[\w.@-]+$/;

export interface RunnerLogApiOptions {
  /** The session these routes answer for; the host owns exactly one. */
  sessionId: string;
  /** The store root; defaults to this environment's agent directory. */
  storeDir?: string;
  logReader?: ILogReader;
  logTail?: ILogTail;
}

/** Rejects anything that could climb out of the session's own directory before a path is built. */
function isSafeSegment(value: string): boolean {
  return value !== '' && value !== '.' && value !== '..' && SAFE_SEGMENT.test(value);
}

/**
 * The log file a run wrote, or undefined when there is no such run or its
 * record points somewhere it has no business pointing.
 *
 * The record names its own log path, and that record is written by another
 * process, so the path is checked rather than trusted: it must sit inside this
 * session's own logs directory. Without that check a doctored record would
 * turn this route into an arbitrary file read.
 */
function resolveLogFile(storeDir: string, sessionId: string, runId: string): RunnerRecord | undefined {
  const statePath = path.join(runnerStateDirFor(storeDir, sessionId), `${runId}${STATE_EXTENSION}`);
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch {
    return undefined; // No such run in this session; the route answers 404.
  }
  const record = parseRunnerRecord(raw);
  if (record === undefined || record.id !== runId || record.sessionId !== sessionId) return undefined;
  const logsDir = path.resolve(storeDir, sessionId, LOG_DIR_NAME);
  const resolved = path.resolve(record.logPath);
  if (resolved !== logsDir && !resolved.startsWith(`${logsDir}${path.sep}`)) return undefined;
  return record;
}

function numberParam(value: string | undefined, fallback: number, max: number): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

function logQueryOf(url: URL): LogQuery {
  const grep = url.searchParams.get(RUNNER_LOG_PARAMS.grep) ?? undefined;
  return {
    lines: numberParam(url.searchParams.get(RUNNER_LOG_PARAMS.lines) ?? undefined, DEFAULT_LINES, MAX_LINES),
    ...(grep === undefined || grep === '' ? {} : { grep }),
    ignoreCase: url.searchParams.get(RUNNER_LOG_PARAMS.ignoreCase) === 'true',
    contextLines: numberParam(url.searchParams.get(RUNNER_LOG_PARAMS.contextLines) ?? undefined, 0, MAX_LINES),
  };
}

/**
 * This package's HTTP surface: one runner's log, as a bounded slice and as a
 * live tail.
 *
 * The routes are mounted inside one session's own server, so they name a runner
 * and nothing else; the session is the host, not a parameter. The reader only
 * ever returns the last N lines of what matched, so both routes stay bounded no
 * matter how large the file on disk is.
 */
export function createRunnerLogApi(options: RunnerLogApiOptions): Hono {
  const logReader = options.logReader ?? new LogReader();
  const logTail = options.logTail ?? new LogTail();
  const storeDir = options.storeDir ?? resolveRunnerStoreDirectory(process.env);
  const sessionId = options.sessionId;
  const app = new Hono();

  /** The record behind a request, or undefined when this session has no such run. */
  const runnerOf = (runId: string): RunnerRecord | undefined =>
    isSafeSegment(runId) ? resolveLogFile(storeDir, sessionId, runId) : undefined;

  app.get('/runners/:runId/log', (context) => {
    const runId = context.req.param('runId');
    const record = runnerOf(runId);
    if (record === undefined) return context.json({ error: `No runner '${runId}' in this session.` }, 404);
    const slice = logReader.read(record.logPath, logQueryOf(new URL(context.req.url)));
    const body: RunnerLogResponse = { ...slice, runId, running: record.state === RUNNING_STATE };
    return context.json(body);
  });

  app.get('/runners/:runId/log/stream', (context) => {
    const runId = context.req.param('runId');
    const record = runnerOf(runId);
    if (record === undefined) return context.json({ error: `No runner '${runId}' in this session.` }, 404);
    const from = numberParam(
      new URL(context.req.url).searchParams.get(RUNNER_LOG_PARAMS.from) ?? undefined,
      0,
      Number.MAX_SAFE_INTEGER,
    );

    return streamSSE(context, async (stream) => {
      const send = (event: RunnerLogStreamEvent): Promise<void> =>
        stream.writeSSE({ event: RUNNER_LOG_STREAM_EVENT, data: JSON.stringify(event) });

      // The tail and the state poll both push onto one queue, so the stream
      // writes in the order things happened rather than interleaving two
      // writers onto the same socket.
      let pump: Promise<void> = Promise.resolve();
      const queue = (event: RunnerLogStreamEvent): void => {
        pump = pump.then(() => send(event)).catch(() => undefined);
      };

      let finish = (): void => undefined;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const handle = logTail.follow(record.logPath, {
        from,
        onLines: (lines) => queue({ lines }),
        onError: () => finish(),
      });
      // A finished runner writes nothing more, so the page is told once and
      // the stream ends rather than holding a socket open forever.
      const poll = setInterval(() => {
        const current = runnerOf(runId);
        if (current !== undefined && current.state === RUNNING_STATE) return;
        queue({ lines: [], ended: true });
        finish();
      }, STATE_POLL_MS);

      stream.onAbort(() => finish());
      await done;
      clearInterval(poll);
      handle.close();
      await pump;
    });
  });

  return app;
}

/** The named export a host imports from this package's built session entry. */
export const api: DoomApi = {
  basePath: RUNNER_API_BASE_PATH,
  start(context: DoomApiContext): DoomApiHandler {
    // The host is one session's server, so its id is the whole scope; a hub
    // would have handed no session at all, and there is nothing to answer.
    const app = createRunnerLogApi({ sessionId: context.sessionId ?? '' });
    return {
      fetch: (request) => app.fetch(request),
      // Nothing outlives a request: a follow's watch and its poll are both
      // torn down when its own stream ends or the socket aborts.
      close: () => undefined,
    };
  },
};
