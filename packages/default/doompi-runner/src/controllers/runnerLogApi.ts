import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-core/package-api';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_LINES,
  HEARTBEAT_MS,
  LOG_DIR_NAME,
  MAX_INPUT_CHARS,
  MAX_LINES,
  NOT_ATTACHABLE,
  RAW_LOG_SUFFIX,
  RUNNING_STATE,
  SAFE_SEGMENT,
  SCREEN_POLL_MS,
  STATE_EXTENSION,
  STATE_POLL_MS,
} from '../constants/runnerLogApi';
import {
  RUNNER_API_BASE_PATH,
  RUNNER_LOG_PING_EVENT,
  RUNNER_LOG_STREAM_EVENT,
  RUNNER_SCREEN_EVENT,
} from '../constants/webRunnerLog';
import { LogReader } from '../services/logReader';
import { LogTail } from '../services/logTail';
import { PtyBackendChain } from '../services/ptyBackendChain';
import { RmuxBackend } from '../services/rmuxBackend';
import { RunnerPaths, resolveRunnerStoreDirectory, runnerStateDirFor } from '../services/runnerPaths';
import { TmuxBackend } from '../services/tmuxBackend';
import { parseRunnerRecord } from '../services/webRunnerRuns';
import type { ILogReader, LogQuery } from '../types/logReader';
import type { ILogTail } from '../types/logTail';
import type { IRmuxBackend } from '../types/rmuxBackend';
import type { RunnerRecord } from '../types/runnerRegistry';
import {
  RUNNER_LOG_PARAMS,
  type RunnerLogResponse,
  type RunnerLogStreamEvent,
  type RunnerScreenEvent,
} from '../types/webRunnerLog';

/** How often a follow re-reads the record to notice the runner exiting. */
/**
 * How often a silent but living stream proves it is still there. Short enough
 * that an idle proxy does not reap the socket, long enough to cost nothing.
 */
/** Kept in step with LogQuery's own default, so an unasked-for tail is the same size everywhere. */
/** A page that asks for more than this gets this; the whole point of the route is a bounded read. */
/** Path segments the client supplies are names, never paths. */
/** Backends that expose a pane another process can read and write. */
const MULTIPLEXER_BACKENDS: ReadonlySet<string> = new Set(['rmux', 'tmux']);
/** How often an attached pane's new bytes are picked up. */
/** The unscrubbed copy the runner's sink writes beside the log, for interactive runs. */
/** One keystroke batch; a paste is not a file transfer. */
/** Said the same way for every reason, so the route never reports which check failed. */

export interface RunnerLogApiOptions {
  /** The session these routes answer for; the host owns exactly one. */
  sessionId: string;
  /** The store root; defaults to this environment's agent directory. */
  storeDir?: string;
  logReader?: ILogReader;
  logTail?: ILogTail;
  /**
   * Reaches a live pane to read its screen and send it input.
   *
   * A session API is handed nothing but its session id, so it cannot touch the
   * in-process PTY handles the extension holds. This talks to the multiplexer
   * over its own socket instead, the same way the CLI's `input` verb does,
   * which is what makes an attached pane reachable across processes at all.
   */
  pane?: IRmuxBackend;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

  // Built on first use, not on mount: most sessions never attach to a pane,
  // and constructing this probes the filesystem for a multiplexer binary.
  let paneBackend: IRmuxBackend | undefined = options.pane;
  const pane = (): IRmuxBackend => {
    paneBackend ??= (() => {
      const paths = new RunnerPaths();
      return new PtyBackendChain(new RmuxBackend(paths), new TmuxBackend(paths));
    })();
    return paneBackend;
  };

  /** The record behind a request, or undefined when this session has no such run. */
  const runnerOf = (runId: string): RunnerRecord | undefined =>
    isSafeSegment(runId) ? resolveLogFile(storeDir, sessionId, runId) : undefined;

  /**
   * The pane a request may attach to.
   *
   * Same posture as the log routes: the record is written by another process,
   * so nothing on it is trusted until it is checked. The target must be one
   * this package owns, the run must still be up, and it must have been started
   * interactive. A non-interactive run has no terminal to type into, and a
   * subprocess-backed run has no pane at all.
   */
  const attachableOf = (runId: string): { record: RunnerRecord; target: string } | undefined => {
    const record = runnerOf(runId);
    if (record === undefined || record.state !== RUNNING_STATE || record.interactive !== true) return undefined;
    const target = record.backendTarget;
    if (target === undefined || !MULTIPLEXER_BACKENDS.has(record.backend) || !isSafeSegment(target)) return undefined;
    return { record, target };
  };
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
        onLines: (lines, completeThrough) => queue({ lines, offset: completeThrough }),
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
      // A runner can be alive and produce nothing for minutes. Without this the
      // page cannot tell that from a stream that quietly died.
      const heartbeat = setInterval(() => {
        pump = pump.then(() => stream.writeSSE({ event: RUNNER_LOG_PING_EVENT, data: '' })).catch(() => undefined);
      }, HEARTBEAT_MS);

      stream.onAbort(() => finish());
      await done;
      clearInterval(poll);
      clearInterval(heartbeat);
      handle.close();
      await pump;
    });
  });

  app.get('/runners/:runId/screen/stream', (context) => {
    const runId = context.req.param('runId');
    const attachable = attachableOf(runId);
    if (attachable === undefined) return context.json({ error: NOT_ATTACHABLE }, 404);
    // The record's log path is already proven to sit inside this session's own
    // logs directory, and the raw copy is that same path with a suffix, so it
    // cannot point anywhere new.
    const rawPath = `${attachable.record.logPath}${RAW_LOG_SUFFIX}`;
    const from = numberParam(
      new URL(context.req.url).searchParams.get(RUNNER_LOG_PARAMS.from) ?? undefined,
      0,
      Number.MAX_SAFE_INTEGER,
    );

    return streamSSE(context, async (stream) => {
      let pump: Promise<void> = Promise.resolve();
      const queue = (event: RunnerScreenEvent): void => {
        pump = pump
          .then(() => stream.writeSSE({ event: RUNNER_SCREEN_EVENT, data: JSON.stringify(event) }))
          .catch(() => undefined);
      };

      let finish = (): void => undefined;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });

      let offset = from;
      const drain = (): void => {
        let size: number;
        try {
          size = fs.statSync(rawPath).size;
        } catch {
          return; // The sink has not opened the file yet; the next tick settles it.
        }
        // The sink starts the file over when it passes its ceiling, so a
        // smaller file is a fresh one rather than a bad offset.
        if (size < offset) offset = 0;
        if (size === offset) return;
        const length = size - offset;
        const buffer = Buffer.alloc(length);
        const descriptor = fs.openSync(rawPath, 'r');
        let read: number;
        try {
          read = fs.readSync(descriptor, buffer, 0, length, offset);
        } finally {
          fs.closeSync(descriptor);
        }
        if (read <= 0) return;
        offset += read;
        // Bytes, not lines: a terminal's escape sequences straddle newlines and
        // mean nothing once split on them.
        queue({ chunk: buffer.subarray(0, read).toString('base64'), offset });
      };

      const poll = setInterval(() => {
        const current = runnerOf(runId);
        drain();
        if (current === undefined || current.state !== RUNNING_STATE) {
          queue({ chunk: '', offset, ended: true });
          finish();
        }
      }, SCREEN_POLL_MS);

      stream.onAbort(() => finish());
      await done;
      clearInterval(poll);
      await pump;
    });
  });

  /**
   * Types into a live pane.
   *
   * This is the one route in the package that writes rather than reads, so it
   * is deliberately narrow: an owned target, still running, started
   * interactive, and a body that is nothing but text.
   */
  app.post('/runners/:runId/screen/input', async (context) => {
    const runId = context.req.param('runId');
    const attachable = attachableOf(runId);
    if (attachable === undefined) return context.json({ error: NOT_ATTACHABLE }, 404);

    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'Expected a JSON body carrying text.' }, 400);
    }
    const text = isRecord(body) ? body.text : undefined;
    if (typeof text !== 'string' || text === '') return context.json({ error: 'Expected a non-empty text.' }, 400);
    if (text.length > MAX_INPUT_CHARS) return context.json({ error: 'That is more input than a pane takes.' }, 413);

    const delivered = await pane().input(attachable.target, text);
    if (!delivered) return context.json({ error: 'The runner did not take the input.' }, 502);
    return context.json({ delivered: true });
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
