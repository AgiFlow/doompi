import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  doomApiCallerFrom,
  type DoomApi,
  type DoomApiContext,
  type DoomApiHandler,
} from '@agimon-ai/doompi-core/packageApi';
import {
  WorkflowRegistryService,
  WorkflowTerminalService as WorkflowTerminalFacade,
  type WorkflowRunRecord,
  type WorkflowStage,
} from '@agimon-ai/workflow-mcp';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import {
  createStepPaneTerminal,
  createStepPaneTerminalDependencies,
  removeStepPaneLogs,
} from '../../services/stepPaneTerminal';
import type { RunTerminalTarget } from '../../services/stepPaneTerminal/type';
import { createWorkflowTerminalService } from '../../services/workflowTerminal';
import routes, { ARTIFACT_DOWNLOAD_PARAM, ARTIFACT_RAW_PARAM, STEP_TARGET_PARAM } from '../../types/apiRoutes';
import { STEP_SESSION_REF_KIND } from '../../types/webWorkflows';
import {
  WORKFLOW_API_BASE_PATH,
  WORKFLOW_SCREEN_EVENT,
  type WorkflowArtifactContentResponse,
  type WorkflowArtifactsResponse,
  type WorkflowArtifactView,
  type WorkflowControlResponse,
  type WorkflowDeleteResponse,
  type WorkflowLaunchResponse,
  type WorkflowScreenEvent,
  type WorkflowSteerResponse,
  type WorkflowStopResponse,
} from '../../types/webWorkflowTerminal';

/** Stages a run can be recorded under, newest first: a live run is the common case. */
const STAGES: readonly WorkflowStage[] = ['running', 'error', 'completed'];
/** Lines of screen the stream sends, which is a terminal's visible height plus room. */
const SCREEN_LINES = 48;
/** How often the stream re-reads; the service coalesces, so this is an upper bound. */
const STREAM_TICK_MS = 500;
/** How often a settled run is re-checked before the stream closes itself. */
const SETTLED_POLL_TICKS = 4;
/** Bytes of one textual artifact returned as JSON; binary previews use a stream. */
const MAX_ARTIFACT_BYTES = 512 * 1024;
/** Recorded with a stop the web panel asks for, so the run log says where it came from. */
const WEB_STOP_REASON = 'Stopped from the web workflow panel.';
/** Path segments a client supplies are names, never paths. */
const SAFE_SEGMENT = /^[\w.@-]+$/;
const ARTIFACT_MIME_TYPES: Readonly<Record<string, string>> = {
  '.aac': 'audio/aac',
  '.bmp': 'image/bmp',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.jsx': 'text/jsx',
  // A run's engine log, which a reader opens to see why a step failed.
  '.log': 'text/plain',
  '.m4a': 'audio/mp4',
  '.markdown': 'text/markdown',
  '.md': 'text/markdown',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.ogv': 'video/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.sh': 'text/x-shellscript',
  '.svg': 'image/svg+xml',
  '.toml': 'text/toml',
  '.ts': 'text/typescript',
  '.tsv': 'text/tab-separated-values',
  '.tsx': 'text/tsx',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
};

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
  return value !== '' && value !== '../adapters' && value !== '..' && SAFE_SEGMENT.test(value);
}

/**
 * One terminal's identity for caches and leases, stable across stage moves: a
 * run's, or one step's pane in it, which keeps its own screen and keyboard.
 */
function runIdentityOf(workspace: string, runKey: string, step?: string): string {
  return step === undefined ? `${workspace}/${runKey}` : `${workspace}/${runKey}#${step}`;
}

/** The step a terminal request names, from its query or body; absent follows the current step. */
function stepOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export interface WorkflowHubApiOptions {
  registry?: WorkflowRegistryService;
  terminal?: WorkflowTerminalFacade;
  now?: () => number;
  /**
   * Guides a live session that the mounting session started. Present only on a
   * session mount, whose session service refuses sessions it did not start.
   */
  steer?: (sessionId: string, message: string) => Promise<void>;
  /**
   * Runs a workflow in the mounting session, which then owns it. Present only on
   * the mount of a session with a workflow runtime.
   */
  launch?: (parameters: Record<string, unknown>) => Promise<WorkflowLaunchResponse>;
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
  const stepPanes = createStepPaneTerminalDependencies(registry);
  const terminal = createWorkflowTerminalService<RunTerminalTarget>({
    // A run executing in the server has a pane per command step instead of one for the whole run.
    terminal: createStepPaneTerminal(facade, stepPanes),
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

  app.get(routes.screen.path, async (context) => {
    const workspace = context.req.param('workspace');
    const runKey = context.req.param('runKey');
    const record = await runOf(workspace, runKey);
    if (record === undefined) return context.json(missing(workspace, runKey), 404);
    const step = stepOf(context.req.query(STEP_TARGET_PARAM));
    const identity = runIdentityOf(workspace, runKey, step);

    return streamSSE(context, async (stream) => {
      let settledTicks = 0;
      let running = true;
      let latest = record;
      stream.onAbort(() => {
        running = false;
      });
      while (running) {
        const current = (await runOf(workspace, runKey)) ?? record;
        latest = current;
        const target: RunTerminalTarget = { record: current, ...(step === undefined ? {} : { step }) };
        const capabilities = terminal.capabilities(target);
        const lines = capabilities.readable ? await terminal.screen(identity, target, SCREEN_LINES) : [];
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
      // Only a settled run is forgotten, and only this one. A reader closing its
      // stream, which happens whenever a panel unmounts, must not drop the
      // keyboard lease someone just took on another panel, or on another run.
      if (latest.stage !== 'running') terminal.forgetRun(identity);
    });
  });

  app.post(routes.control.path, async (context) => {
    const workspace = context.req.param('workspace');
    const runKey = context.req.param('runKey');
    const record = await runOf(workspace, runKey);
    if (record === undefined) return context.json(missing(workspace, runKey), 404);
    const body = await jsonBody(context);
    const step = stepOf(body.step);
    const identity = runIdentityOf(workspace, runKey, step);
    const capabilities = terminal.capabilities({ record, ...(step === undefined ? {} : { step }) });

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

  app.post(routes.keys.path, async (context) => {
    const workspace = context.req.param('workspace');
    const runKey = context.req.param('runKey');
    const record = await runOf(workspace, runKey);
    if (record === undefined) return context.json(missing(workspace, runKey), 404);
    const body = await jsonBody(context);
    if (typeof body.token !== 'string' || typeof body.data !== 'string') {
      return context.json({ error: 'A keystroke needs a control token and its data.' }, 400);
    }
    const step = stepOf(body.step);
    try {
      await terminal.write(
        runIdentityOf(workspace, runKey, step),
        { record, ...(step === undefined ? {} : { step }) },
        body.token,
        body.data,
      );
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
    return context.body(null, 204);
  });

  app.post(routes.resize.path, async (context) => {
    const workspace = context.req.param('workspace');
    const runKey = context.req.param('runKey');
    const record = await runOf(workspace, runKey);
    if (record === undefined) return context.json(missing(workspace, runKey), 404);
    const body = await jsonBody(context);
    const { token, columns, rows } = body;
    if (typeof token !== 'string' || typeof columns !== 'number' || typeof rows !== 'number') {
      return context.json({ error: 'A resize needs a control token, columns and rows.' }, 400);
    }
    const step = stepOf(body.step);
    try {
      const resized = await terminal.resize(
        runIdentityOf(workspace, runKey, step),
        { record, ...(step === undefined ? {} : { step }) },
        token,
        columns,
        rows,
      );
      return context.json({ resized });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.post(routes.stop.path, async (context) => {
    const workspace = context.req.param('workspace');
    const runKey = context.req.param('runKey');
    const record = await runOf(workspace, runKey);
    if (record === undefined) return context.json(missing(workspace, runKey), 404);
    if (record.stage !== 'running' || record.runId === undefined) {
      return context.json({ error: 'Only a running workflow can be stopped.' }, 409);
    }
    try {
      // The same request the workflow tool's stop writes; the engine that owns the
      // run reads it wherever that engine lives, in this server or in a terminal.
      await registry.requestStop(workspace, runKey, WEB_STOP_REASON, record.runId);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
    const response: WorkflowStopResponse = { requested: true };
    return context.json(response);
  });

  app.post(routes.steer.path, async (context) => {
    const workspace = context.req.param('workspace');
    const runKey = context.req.param('runKey');
    const record = await runOf(workspace, runKey);
    if (record === undefined) return context.json(missing(workspace, runKey), 404);
    const body = await jsonBody(context);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (message === '') return context.json({ error: 'Guidance needs a message.' }, 400);
    if (record.stage !== 'running') return context.json({ error: 'Only a running workflow can be steered.' }, 409);
    // Only a step running now, and only an agent session. A browser names the
    // run, and inside a parallel group the step's own session; any other
    // session is out of reach.
    const refs = stepPanes.stepRefs(record);
    const step = typeof body.step === 'string' ? body.step : undefined;
    const current = step === undefined ? refs.current : (refs.running ?? []).find((candidate) => candidate.id === step);
    if (current?.kind !== STEP_SESSION_REF_KIND) {
      return context.json({ error: 'The running step is not an agent session.' }, 409);
    }
    if (options.steer === undefined) {
      return context.json({ error: 'Steering is available from the session that launched this run.' }, 409);
    }
    try {
      await options.steer(current.id, message);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
    const response: WorkflowSteerResponse = { delivered: true };
    return context.json(response);
  });

  app.post(routes.launch.path, async (context) => {
    if (options.launch === undefined) {
      return context.json({ error: 'Launching needs the mount of a session with a workflow runtime.' }, 409);
    }
    const response: WorkflowLaunchResponse = await options.launch(await jsonBody(context));
    return context.json(response);
  });

  app.delete(routes.remove.path, async (context) => {
    const workspace = context.req.param('workspace');
    const runKey = context.req.param('runKey');
    const record = await runOf(workspace, runKey);
    if (record === undefined) return context.json(missing(workspace, runKey), 404);
    if (record.stage === 'running') {
      return context.json({ error: 'A running workflow must be stopped before it can be deleted.' }, 409);
    }
    // Read before the run directory goes: its progress log is what names the panes.
    const refs = stepPanes.stepRefs(record);
    try {
      fs.rmSync(registry.runDirectoryFor(record), { recursive: true, force: true });
      await removeStepPaneLogs(refs);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
    const response: WorkflowDeleteResponse = { deleted: true };
    return context.json(response);
  });

  app.post(routes.openRunDirectory.path, async (context) => {
    if (doomApiCallerFrom(context.req.raw.headers)?.locality !== 'local') {
      return context.json({ error: 'Opening Finder is only available on the host.' }, 403);
    }
    const workspace = context.req.param('workspace');
    const runKey = context.req.param('runKey');
    const record = await runOf(workspace, runKey);
    if (record === undefined) return context.json(missing(workspace, runKey), 404);
    if (process.platform !== 'darwin') {
      return context.json({ error: 'Finder is only available on macOS.' }, 409);
    }
    try {
      const runDir = path.resolve(registry.runDirectoryFor(record));
      if (!fs.statSync(runDir).isDirectory()) {
        return context.json({ error: 'The run directory is not a folder.' }, 409);
      }
      await new Promise<void>((resolve, reject) => {
        execFile('/usr/bin/open', ['-a', 'Finder', runDir], { timeout: 5_000 }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return context.json({ opened: true });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.get(routes.artifacts.path, async (context) => {
    const workspace = context.req.param('workspace');
    const runKey = context.req.param('runKey');
    const record = await runOf(workspace, runKey);
    if (record === undefined) return context.json(missing(workspace, runKey), 404);
    const runDir = registry.runDirectoryFor(record);
    const directory = context.req.query('directory') ?? '';
    const resolved = resolveInside(runDir, directory);
    if (resolved === undefined) return context.json({ error: 'That folder is not inside this run.' }, 400);
    try {
      const body: WorkflowArtifactsResponse = {
        runDir,
        description: record.runDirectory?.description ?? '',
        artifacts: readArtifacts(runDir, record, directory),
      };
      return context.json(body);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.get(routes.artifact.path, async (context) => {
    const workspace = context.req.param('workspace');
    const runKey = context.req.param('runKey');
    const record = await runOf(workspace, runKey);
    if (record === undefined) return context.json(missing(workspace, runKey), 404);
    const runDir = registry.runDirectoryFor(record);
    const requested = context.req.param('name');
    const resolved = resolveInside(runDir, requested);
    if (resolved === undefined) return context.json({ error: `'${requested}' is not inside this run.` }, 400);
    if (context.req.query(ARTIFACT_RAW_PARAM) === '1') {
      const response = streamArtifact(
        resolved,
        requested,
        context.req.header('range'),
        context.req.query(ARTIFACT_DOWNLOAD_PARAM) === '1',
      );
      return response ?? context.json({ error: `'${requested}' has not been written.` }, 404);
    }
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
  try {
    const realRoot = fs.realpathSync(root);
    // Check the nearest existing ancestor too, so pending paths through symlinks stay confined.
    let ancestor = resolved;
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return undefined;
      ancestor = parent;
    }
    const real = fs.realpathSync(ancestor);
    if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) return undefined;
    return resolved;
  } catch {
    return undefined; // Missing or inaccessible run roots cannot safely be read.
  }
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
  const target = resolveInside(runDir, entry.path);
  const stats = target === undefined ? undefined : statOf(target);
  return {
    ...entry,
    kind: stats?.isDirectory() ? 'directory' : entry.kind,
    state: target === undefined ? 'unreadable' : stateOf(stats),
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
function readArtifacts(runDir: string, record: WorkflowRunRecord, directory = ''): WorkflowArtifactView[] {
  const declared = (record.runDirectory?.entries ?? []).map((entry) =>
    viewOf(runDir, {
      path: entry.path,
      kind: entry.kind,
      description: entry.description,
      producedBy: entry['produced-by'] ?? [],
      declared: true,
    }),
  );
  const children = declared.filter((entry) => path.posix.dirname(entry.path) === (directory || '.'));
  const claimed = new Set(children.map((entry) => entry.path));
  const names = fs.readdirSync(path.join(runDir, directory), { withFileTypes: true });
  const found = names
    .filter((entry) => !claimed.has(path.posix.join(directory, entry.name)))
    .map((entry) =>
      viewOf(runDir, {
        path: path.posix.join(directory, entry.name),
        kind: entry.isDirectory() ? 'directory' : 'file',
        description: '',
        producedBy: [],
        declared: false,
      }),
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  return [...(directory === '' ? declared : children), ...found];
}

/** Browser content type inferred from a filename without trusting client input. */
function artifactMimeType(requested: string): string {
  return ARTIFACT_MIME_TYPES[path.extname(requested).toLowerCase()] ?? 'application/octet-stream';
}

function isTextArtifact(mimeType: string): boolean {
  return mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml';
}

/** One artifact's metadata and bounded text, or undefined when it is not readable. */
function readArtifact(resolved: string, requested: string): WorkflowArtifactContentResponse | undefined {
  const stats = statOf(resolved);
  if (stats === undefined || stats.isDirectory()) return undefined;
  const mimeType = artifactMimeType(requested);
  let text: string | undefined;
  if (isTextArtifact(mimeType)) {
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
      return undefined;
    }
  }
  return {
    path: requested,
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    mimeType,
    ...(text === undefined ? {} : { text }),
    truncated: text !== undefined && stats.size > MAX_ARTIFACT_BYTES,
  };
}

/** Streams media with byte-range support so browser audio, video, and PDF controls can seek. */
function streamArtifact(
  resolved: string,
  requested: string,
  rangeHeader: string | undefined,
  download: boolean,
): Response | undefined {
  const stats = statOf(resolved);
  if (stats === undefined || stats.isDirectory()) return undefined;
  const mimeType = artifactMimeType(requested);
  let start = 0;
  let end = Math.max(0, stats.size - 1);
  let partial = false;
  const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  if (match !== null && match !== undefined && stats.size > 0) {
    const requestedStart = match[1] === '' ? undefined : Number(match[1]);
    const requestedEnd = match[2] === '' ? undefined : Number(match[2]);
    if (requestedStart === undefined && requestedEnd !== undefined) {
      start = Math.max(0, stats.size - requestedEnd);
    } else if (requestedStart !== undefined) {
      start = requestedStart;
      end = requestedEnd === undefined ? end : Math.min(requestedEnd, end);
    }
    if (start >= stats.size || start > end) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${String(stats.size)}` } });
    }
    partial = true;
  }
  const filename = path.basename(requested).replace(/["\\\r\n]/g, '_');
  const forceDownload = download || mimeType === 'text/html';
  const headers = new Headers({
    'accept-ranges': 'bytes',
    'content-disposition': `${forceDownload ? 'attachment' : 'inline'}; filename="${filename}"`,
    'content-length': String(stats.size === 0 ? 0 : end - start + 1),
    'content-type': mimeType,
    'x-content-type-options': 'nosniff',
  });
  if (partial) headers.set('content-range', `bytes ${String(start)}-${String(end)}/${String(stats.size)}`);
  if (stats.size === 0) return new Response(null, { status: 200, headers });
  const body = Readable.toWeb(fs.createReadStream(resolved, { start, end }));
  return new Response(body, { status: partial ? 206 : 200, headers });
}

/**
 * This package's API, mounted by a session with its runtime's `launch` and by
 * the hub without one.
 */
export function createWorkflowApi(launch?: WorkflowHubApiOptions['launch']): DoomApi {
  return {
    basePath: WORKFLOW_API_BASE_PATH,
    start(context: DoomApiContext): DoomApiHandler {
      // A run is addressed by its registry identity, which is machine-wide. Only
      // steering and launching need a session: the one mounting this API, which
      // may guide only the step sessions it started.
      const steer = context.sessionService?.steer?.bind(context.sessionService);
      const app = createWorkflowHubApi({
        ...(steer === undefined ? {} : { steer: (sessionId, message) => steer(sessionId, message) }),
        ...(launch === undefined ? {} : { launch }),
      });
      return {
        fetch: (request) => app.fetch(request),
        // Nothing outlives a request: a stream's loop ends when its own socket
        // aborts, and the caches it touched are per run rather than per client.
        close: () => undefined,
      };
    },
  };
}

/** The named export a host imports from this package's built hub entry. */
export const api: DoomApi = createWorkflowApi();
