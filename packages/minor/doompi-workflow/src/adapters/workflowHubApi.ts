import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  WorkflowRegistryService,
  WorkflowTerminalService as WorkflowTerminalFacade,
  type WorkflowRunRecord,
  type WorkflowStage,
} from '@agimon-ai/workflow-mcp';
import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-extension-contracts/package-api';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createWorkflowTerminalService } from '../services/workflowTerminal.ts';
import {
  WORKFLOW_API_BASE_PATH,
  WORKFLOW_SCREEN_EVENT,
  type WorkflowArtifactContentResponse,
  type WorkflowArtifactsResponse,
  type WorkflowArtifactView,
  type WorkflowControlResponse,
  type WorkflowScreenEvent,
} from '../types/webWorkflowTerminal.ts';

/** Stages a run can be recorded under, newest first: a live run is the common case. */
const STAGES: readonly WorkflowStage[] = ['running', 'error', 'completed'];
/** Lines of screen the stream sends, which is a terminal's visible height plus room. */
const SCREEN_LINES = 48;
/** How often the stream re-reads; the service coalesces, so this is an upper bound. */
const STREAM_TICK_MS = 500;
/** How often a settled run is re-checked before the stream closes itself. */
const SETTLED_POLL_TICKS = 4;
/** Bytes of one artifact a viewer receives; a run directory holds prose, not archives. */
const MAX_ARTIFACT_BYTES = 512 * 1024;
/** Path segments a client supplies are names, never paths. */
const SAFE_SEGMENT = /^[\w.@-]+$/;

/**
 * One request's JSON body as a plain record.
 *
 * A body that is absent, malformed, or not an object reads as empty rather
 * than failing the route: every field is checked by the route anyway, and a
 * 400 naming the missing field beats a parse error naming nothing.
 */
async function jsonBody(context: Context): Promise<Record<string, unknown>> {
  const parsed: unknown = await context.req.json().catch(() => undefined);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** Rejects anything that could climb out of the registry before a path is built. */
function isSafeSegment(value: string): boolean {
  return value !== '' && value !== '.' && value !== '..' && SAFE_SEGMENT.test(value);
}

/** One run's identity for caches and leases, stable across stage moves. */
function runIdentityOf(workspace: string, runKey: string): string {
  return `${workspace}/${runKey}`;
}

export interface WorkflowHubApiOptions {
  registry?: WorkflowRegistryService;
  terminal?: WorkflowTerminalFacade;
  now?: () => number;
}

/**
 * This package's HTTP surface: one workflow run's terminal, and the files its
 * run directory holds.
 *
 * Mounted in the hub rather than in a session's server, because a run's
 * terminal belongs to its multiplexer rather than to the session that launched
 * it: any process can read a tmux pane, and the session's own server cannot
 * reach anything more. The routes therefore name a run, never a session.
 */
export function createWorkflowHubApi(options: WorkflowHubApiOptions = {}): Hono {
  const registry = options.registry ?? new WorkflowRegistryService();
  const facade = options.terminal ?? new WorkflowTerminalFacade();
  const terminal = createWorkflowTerminalService<WorkflowRunRecord>({
    terminal: facade,
    now: options.now ?? (() => Date.now()),
  });
  const app = new Hono();

  /** The record behind a request, whichever stage it now sits in. */
  const runOf = async (workspace: string, runKey: string): Promise<WorkflowRunRecord | undefined> => {
    if (!isSafeSegment(workspace) || !isSafeSegment(runKey)) return undefined;
    for (const stage of STAGES) {
      try {
        return await registry.readRunByKey(workspace, stage, runKey);
      } catch {
        // Not in this stage. A run moves between them as it settles, so a miss
        // here is ordinary; only a miss in every stage means no such run.
      }
    }
    return undefined;
  };

  const missing = (workspace: string, runKey: string): { error: string } => ({
    error: `No workflow run '${runKey}' in workspace '${workspace}'.`,
  });

  app.get('/runs/:workspace/:runKey/screen/stream', async (context) => {
    const workspace = context.req.param('workspace');
    const runKey = context.req.param('runKey');
    const record = await runOf(workspace, runKey);
    if (record === undefined) return context.json(missing(workspace, runKey), 404);
    const identity = runIdentityOf(workspace, runKey);

    return streamSSE(context, async (stream) => {
      let settledTicks = 0;
      let running = true;
      stream.onAbort(() => {
        running = false;
      });
      while (running) {
        const current = (await runOf(workspace, runKey)) ?? record;
        const capabilities = terminal.capabilities(current);
        const lines = capabilities.readable ? await terminal.screen(identity, current, SCREEN_LINES) : [];
        // A settled run is read a few more times before the stream closes: the
        // last thing a failing step printed is what the reader came for, and it
        // lands after the record has already moved to its final stage.
        const settled = current.stage !== 'running';
        if (settled) settledTicks += 1;
        const ended = settled && settledTicks >= SETTLED_POLL_TICKS;
        const event: WorkflowScreenEvent = { lines, capabilities, ...(ended ? { ended: true } : {}) };
        await stream.writeSSE({ event: WORKFLOW_SCREEN_EVENT, data: JSON.stringify(event) });
        if (ended) break;
        await stream.sleep(STREAM_TICK_MS);
      }
      terminal.forget(new Set());
    });
  });

  app.post('/runs/:workspace/:runKey/control', async (context) => {
    const workspace = context.req.param('workspace');
    const runKey = context.req.param('runKey');
    const record = await runOf(workspace, runKey);
    if (record === undefined) return context.json(missing(workspace, runKey), 404);
    const identity = runIdentityOf(workspace, runKey);
    const body = await jsonBody(context);
    const capabilities = terminal.capabilities(record);

    if (body.release === true) {
      if (typeof body.token === 'string') terminal.releaseControl(identity, body.token);
      const released: WorkflowControlResponse = { held: false };
      return context.json(released);
    }
    if (!capabilities.writable) {
      const refused: WorkflowControlResponse = { held: false, reason: capabilities.reason };
      return context.json(refused, 409);
    }
    const token = typeof body.token === 'string' && body.token !== '' ? body.token : randomUUID();
    if (!terminal.takeControl(identity, token)) {
      const taken: WorkflowControlResponse = { held: false, reason: 'Another reader holds the keyboard.' };
      return context.json(taken, 409);
    }
    const held: WorkflowControlResponse = { held: true, token };
    return context.json(held);
  });

  app.post('/runs/:workspace/:runKey/keys', async (context) => {
    const workspace = context.req.param('workspace');
    const runKey = context.req.param('runKey');
    const record = await runOf(workspace, runKey);
    if (record === undefined) return context.json(missing(workspace, runKey), 404);
    const body = await jsonBody(context);
    if (typeof body.token !== 'string' || typeof body.data !== 'string') {
      return context.json({ error: 'A keystroke needs a control token and its data.' }, 400);
    }
    try {
      await terminal.write(runIdentityOf(workspace, runKey), record, body.token, body.data);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
    return context.body(null, 204);
  });

  app.post('/runs/:workspace/:runKey/resize', async (context) => {
    const workspace = context.req.param('workspace');
    const runKey = context.req.param('runKey');
    const record = await runOf(workspace, runKey);
    if (record === undefined) return context.json(missing(workspace, runKey), 404);
    const body = await jsonBody(context);
    const { token, columns, rows } = body;
    if (typeof token !== 'string' || typeof columns !== 'number' || typeof rows !== 'number') {
      return context.json({ error: 'A resize needs a control token, columns and rows.' }, 400);
    }
    try {
      const resized = await terminal.resize(runIdentityOf(workspace, runKey), record, token, columns, rows);
      return context.json({ resized });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.get('/runs/:workspace/:runKey/artifacts', async (context) => {
    const workspace = context.req.param('workspace');
    const runKey = context.req.param('runKey');
    const record = await runOf(workspace, runKey);
    if (record === undefined) return context.json(missing(workspace, runKey), 404);
    const runDir = registry.runDirectoryFor(record);
    const body: WorkflowArtifactsResponse = {
      runDir,
      description: record.runDirectory?.description ?? '',
      artifacts: readArtifacts(runDir, record),
    };
    return context.json(body);
  });

  app.get('/runs/:workspace/:runKey/artifacts/:name{.+}', async (context) => {
    const workspace = context.req.param('workspace');
    const runKey = context.req.param('runKey');
    const record = await runOf(workspace, runKey);
    if (record === undefined) return context.json(missing(workspace, runKey), 404);
    const runDir = registry.runDirectoryFor(record);
    const requested = context.req.param('name');
    const resolved = resolveInside(runDir, requested);
    if (resolved === undefined) return context.json({ error: `'${requested}' is not inside this run.` }, 400);
    const body = readArtifact(resolved, requested);
    if (body === undefined) return context.json({ error: `'${requested}' has not been written.` }, 404);
    return context.json(body);
  });

  return app;
}

/**
 * A path inside the run directory, or undefined when it points anywhere else.
 *
 * The client supplies this one verbatim, unlike the run key, so it is resolved
 * and then checked rather than trusted: without the check the route would read
 * any file the hub can reach.
 */
function resolveInside(runDir: string, requested: string): string | undefined {
  const resolved = path.resolve(runDir, requested);
  const root = path.resolve(runDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return undefined;
  return resolved;
}

/** Size and modification time of one path, or undefined when it is not there. */
function statOf(target: string): fs.Stats | undefined {
  try {
    return fs.statSync(target);
  } catch {
    return undefined; // Not written yet, which is an ordinary state for an artifact.
  }
}

function stateOf(stats: fs.Stats | undefined): WorkflowArtifactView['state'] {
  if (stats === undefined) return 'pending';
  if (stats.isDirectory()) return 'written';
  return stats.size === 0 ? 'empty' : 'written';
}

function viewOf(
  runDir: string,
  entry: Omit<WorkflowArtifactView, 'state' | 'size' | 'modifiedAt'>,
): WorkflowArtifactView {
  const stats = statOf(path.join(runDir, entry.path));
  return {
    ...entry,
    state: stateOf(stats),
    ...(stats === undefined ? {} : { size: stats.size, modifiedAt: stats.mtime.toISOString() }),
  };
}

/**
 * What the run directory holds: the workflow's own declaration first, then the
 * files nobody declared.
 *
 * The declaration is the point of the folder, so it leads and keeps its order
 * even for entries no job has written yet. The rest follows rather than being
 * hidden: the engine's own context.md and progress log are often exactly what a
 * reader is looking for.
 */
function readArtifacts(runDir: string, record: WorkflowRunRecord): WorkflowArtifactView[] {
  const declared = (record.runDirectory?.entries ?? []).map((entry) =>
    viewOf(runDir, {
      path: entry.path,
      kind: entry.kind,
      description: entry.description,
      producedBy: entry['produced-by'] ?? [],
      declared: true,
    }),
  );
  const claimed = new Set(declared.map((entry) => entry.path));
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(runDir, { withFileTypes: true });
  } catch {
    return declared; // The directory is gone; the declaration is still worth showing.
  }
  const found = names
    .filter((entry) => !claimed.has(entry.name))
    .map((entry) =>
      viewOf(runDir, {
        path: entry.name,
        kind: entry.isDirectory() ? 'directory' : 'file',
        description: '',
        producedBy: [],
        declared: false,
      }),
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  return [...declared, ...found];
}

/** One artifact's text, bounded, or undefined when it is not a readable file. */
function readArtifact(resolved: string, requested: string): WorkflowArtifactContentResponse | undefined {
  const stats = statOf(resolved);
  if (stats === undefined || stats.isDirectory()) return undefined;
  let text: string;
  try {
    const handle = fs.openSync(resolved, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stats.size, MAX_ARTIFACT_BYTES));
      fs.readSync(handle, buffer, 0, buffer.length, 0);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return undefined; // Unreadable right now; the list already says it exists.
  }
  return {
    path: requested,
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    text,
    truncated: stats.size > MAX_ARTIFACT_BYTES,
  };
}

/** The named export a host imports from this package's built hub entry. */
export const api: DoomApi = {
  basePath: WORKFLOW_API_BASE_PATH,
  start(_context: DoomApiContext): DoomApiHandler {
    // Hub-scoped: the host hands no session, and these routes want none. A run
    // is addressed by its registry identity, which is machine-wide.
    const app = createWorkflowHubApi();
    return {
      fetch: (request) => app.fetch(request),
      // Nothing outlives a request: a stream's loop ends when its own socket
      // aborts, and the caches it touched are per run rather than per client.
      close: () => undefined,
    };
  },
};
