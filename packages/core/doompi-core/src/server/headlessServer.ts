import fs from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';

import { DOOM_API_CALLER_HEADERS, parseDoomSocketPath, type DoomApiMount } from '../exports/packageApi';
import type { OpenSessionRecord } from '../services/openSessionRegistry';
import { observe, type ServerTelemetry } from '../services/serverTelemetry';
import type { SavedSession } from '../services/sqliteSessionHistory';
import type { HeadlessHub, HeadlessHubEvent, HeadlessHubSession } from './headlessHub';
import { createHeadlessProtocol } from './headlessProtocol';

/**
 * The canonical public shape of a package API request, as dispatch reads it.
 *
 * Groups: workspace id, session id, plugin base path, and the remainder handed
 * to the package. `settings` is the host's own API and sits beside `plugins`
 * rather than under it.
 *
 * Exported so the browser's URL construction can be pinned against it. The two
 * are written independently, in halves of this package that may not import each
 * other, and a disagreement between them is not a 404 from the route: the
 * service worker answers an unrecognised path out of the signed bundle cache,
 * so the symptom appears nowhere near the cause.
 */
export const DOOM_PACKAGE_API_PATH_PATTERN =
  /^\/api(?:\/workspaces\/([^/]+)(?:\/sessions\/([^/]+))?)?\/(?:plugins\/([^/]+)|settings)(?:\/(.*))?$/u;

const HEALTH_ROLE = 'hub';
const PROTOCOL_VERSION = 1;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_FILE_BYTES = 25 * 1024 * 1024;
const SESSION_FILE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

export interface HeadlessServerOptions {
  headlessHub: HeadlessHub;
  port: number;
  host?: string;
  /** Requests other than health require this bearer token when set. */
  token?: string;
  telemetry?: ServerTelemetry;
  onNotice?: (message: string) => void;
  compositions?: () => unknown;
  requestAsset?: (request: Request) => Promise<Response | undefined>;
  sessionHistory?: (session: HeadlessHubSession) => Promise<SavedSession[]>;
  restartSession?: (session: HeadlessHubSession) => Promise<void>;
  resumeSession?: (session: HeadlessHubSession, targetSessionId: string) => Promise<string>;
  /** Recorded sessions this server has not reopened, surfaced so a client can ask for one. */
  dormantSessions?: () => readonly OpenSessionRecord[];
  removeDormantSession?: (record: OpenSessionRecord) => void | Promise<void>;
  reviveSession?: (record: OpenSessionRecord) => Promise<void>;
}

export interface HeadlessServer {
  readonly url: string;
  close(): Promise<void>;
}

type ProtocolHandler = NonNullable<ReturnType<Awaited<ReturnType<typeof createHeadlessProtocol>>['accept']>>;
type Client = { socket: WebSocket; handler: ProtocolHandler };

function sessionView(session: HeadlessHubSession): Record<string, unknown> {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    webComposition: session.webComposition,
    name: session.name,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt ?? session.createdAt,
    phase: session.phase ?? 'idle',
    phaseSince: session.phaseSince ?? session.createdAt,
    attach: 'attached',
    pendingMessageCount: session.pendingMessageCount ?? 0,
    everPrompted: session.everPrompted ?? false,
    awaitingInput: session.awaitingInput ?? false,
    ...(session.lastSettledAt === undefined ? {} : { lastSettledAt: session.lastSettledAt }),
    ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
    ...(session.sessionProvenance === undefined ? {} : { sessionProvenance: session.sessionProvenance }),
  };
}

/** The dormant counterpart of `sessionView`; same shape, no runtime behind it. */
function dormantView(record: OpenSessionRecord): Record<string, unknown> {
  return {
    id: record.sessionId,
    workspaceId: record.workspaceId,
    name: record.name,
    cwd: record.cwd,
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
    phase: 'idle',
    phaseSince: record.createdAt,
    attach: 'attached',
    pendingMessageCount: 0,
    everPrompted: false,
    awaitingInput: false,
    dormant: true,
    ...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
    ...(record.sessionProvenance === undefined ? {} : { sessionProvenance: record.sessionProvenance }),
  };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function bearer(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  if (value?.startsWith('Bearer ')) return value.slice('Bearer '.length);
  const header = request.headers['x-doompi-token'];
  return typeof header === 'string' ? header : undefined;
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined) return true;
  if (bearer(request) === token) return true;
  try {
    return new URL(request.url ?? '/', 'http://doompi.local').searchParams.get('token') === token;
  } catch {
    return false;
  }
}

function requestPath(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://doompi.local');
}

async function sessionFile(session: HeadlessHubSession, relativePath: string | null): Promise<Response> {
  if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath))
    return Response.json({ error: 'Invalid session file path.' }, { status: 400 });
  let root: string;
  let filePath: string;
  try {
    root = await fs.promises.realpath(session.cwd);
    filePath = await fs.promises.realpath(path.resolve(root, relativePath));
  } catch {
    return Response.json({ error: 'Session file not found.' }, { status: 404 });
  }
  const contained = path.relative(root, filePath);
  if (contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained))
    return Response.json({ error: 'Session file is outside the working directory.' }, { status: 403 });
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, 'r');
  } catch {
    return Response.json({ error: 'Session file not found.' }, { status: 404 });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return Response.json({ error: 'Session file not found.' }, { status: 404 });
    if (stat.size > MAX_SESSION_FILE_BYTES)
      return Response.json({ error: 'Session file is too large.' }, { status: 413 });
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_SESSION_FILE_BYTES)
      return Response.json({ error: 'Session file is too large.' }, { status: 413 });
    return new Response(bytes, {
      headers: {
        'content-type': SESSION_FILE_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(bytes.byteLength),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } finally {
    await handle.close();
  }
}

async function directorySuggestions(query: string, sessions: readonly HeadlessHubSession[]): Promise<string[]> {
  const typed = query.trim();
  if (typed === '') return [];
  const matches = (value: string): boolean => value.toLowerCase().includes(typed.toLowerCase());
  const known = [...new Set([process.cwd(), ...sessions.map((session) => session.cwd)])].filter(matches);
  const candidates = path.isAbsolute(typed)
    ? [typed]
    : typed.includes(path.sep)
      ? [path.resolve(process.cwd(), typed)]
      : [path.join(path.dirname(process.cwd()), typed), path.join(process.cwd(), typed)];
  const completed: string[] = [];
  for (const candidate of candidates) {
    const drilling = typed.endsWith(path.sep);
    const parent = drilling ? candidate : path.dirname(candidate);
    const partial = drilling ? '' : path.basename(candidate).toLowerCase();
    try {
      const entries = await fs.promises.readdir(parent, { withFileTypes: true });
      completed.push(
        ...entries
          .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().includes(partial))
          .map((entry) => path.join(parent, entry.name)),
      );
    } catch {
      // A missing or unreadable parent simply has no completions.
    }
  }
  return [...new Set([...known, ...completed.sort((left, right) => left.localeCompare(right))])].slice(0, 12);
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJson(body: Uint8Array): unknown {
  if (body.byteLength === 0) return {};
  return JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
}

async function writeResponse(response: ServerResponse, result: Response): Promise<void> {
  response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
  if (result.body === null) {
    response.end();
    return;
  }
  await pipeline(Readable.fromWeb(result.body as import('node:stream/web').ReadableStream), response);
}

function eventFrame(event: HeadlessHubEvent): Record<string, unknown> {
  switch (event.kind) {
    case 'upsert':
      return { type: 'session_upsert', session: sessionView(event.session) };
    case 'removed':
      return { type: 'session_removed', sessionId: event.sessionId };
    case 'channel':
      return {
        type: 'channel_frame',
        frameType: event.frameType,
        sessionId: event.sessionId,
        payload: event.payload,
        ...(event.connectionId === undefined ? {} : { connectionId: event.connectionId }),
      };
  }
}

function writeSse(response: ServerResponse, event: string, value: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

/**
 * Client-neutral HTTP and WebSocket boundary for the process-local headless hub.
 * It deliberately delegates every session operation to HeadlessHub, so transport
 * clients cannot create a second session backend or bypass its lifecycle.
 */
export async function serveHeadlessServer(options: HeadlessServerOptions): Promise<HeadlessServer> {
  const clients = new Set<Client>();
  const scopedProtocols = new Set<Awaited<ReturnType<typeof createHeadlessProtocol>>>();
  const sse = new Set<ServerResponse>();
  let closed = false;
  const webSockets = new WebSocketServer({ noServer: true });
  /**
   * A recorded session is dormant exactly while the hub has no session for its
   * id, so reviving one needs no bookkeeping beyond the hub itself.
   */
  const dormant = (): readonly OpenSessionRecord[] =>
    (options.dormantSessions?.() ?? []).filter((record) => options.headlessHub.session(record.sessionId) === undefined);
  const protocol = await createHeadlessProtocol({
    hub: options.headlessHub,
    telemetry: options.telemetry,
    onNotice: options.onNotice,
    dormantSessions: dormant,
  });
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  const unsubscribe = options.headlessHub.onEvent((event) => {
    const frame = eventFrame(event);
    for (const response of sse) writeSse(response, String(frame.type), frame);
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = requestPath(request);
    if (url.pathname === '/api/health' && request.method === 'GET') {
      json(response, 200, {
        ok: true,
        role: HEALTH_ROLE,
        protocol: PROTOCOL_VERSION,
        sessions: options.headlessHub.snapshot().length,
      });
      return;
    }
    if (!authorized(request, options.token)) {
      json(response, 401, { error: 'Unauthorized.' });
      return;
    }
    if (url.pathname === '/api/remote' || url.pathname.startsWith('/api/remote/')) {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && name !== 'authorization' && name !== 'x-doompi-token')
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const result = await options.headlessHub.requestApi(
        { scope: 'global' },
        'remote',
        new Request(`http://doompi.local${url.pathname.slice('/api/remote'.length)}${url.search}`, {
          method: request.method,
          headers,
          ...(request.method === 'GET' || request.method === 'HEAD'
            ? {}
            : { body: Buffer.from(await readBody(request)) }),
        }),
      );
      await writeResponse(response, result);
      return;
    }
    if (url.pathname === '/api/telemetry/browser' && request.method === 'POST') {
      const body = JSON.parse(new TextDecoder().decode(await readBody(request))) as { v?: unknown; events?: unknown };
      if (body.v !== 1 || !Array.isArray(body.events) || body.events.length > 10) {
        json(response, 400, { error: 'Invalid browser telemetry batch.' });
        return;
      }
      for (const event of body.events) {
        if (
          !event ||
          typeof event !== 'object' ||
          typeof event.name !== 'string' ||
          !/^web\.browser\.[a-z_]{1,40}$/u.test(event.name)
        )
          continue;
        if (options.telemetry)
          observe(
            options.telemetry.recordEvent(event.name, {
              ...(typeof event.duration_ms === 'number' && Number.isFinite(event.duration_ms) && event.duration_ms >= 0
                ? { duration_ms: event.duration_ms }
                : {}),
              ...(typeof event.count === 'number' && Number.isFinite(event.count) && event.count >= 0
                ? { count: event.count }
                : {}),
            }),
          );
      }
      json(response, 200, { ok: true });
      return;
    }
    if (url.pathname === '/api/compositions' && request.method === 'GET') {
      json(response, 200, options.compositions?.() ?? { workspaces: [] });
      return;
    }
    if (
      (url.pathname.startsWith('/api/web-plugins/') ||
        url.pathname === '/bundle-manifest.json' ||
        url.pathname.startsWith('/bundle-assets/')) &&
      options.requestAsset
    ) {
      const result = await options.requestAsset(new Request(url, { method: request.method }));
      if (result) {
        await writeResponse(response, result);
        return;
      }
    }
    if (url.pathname === '/api/directories' && request.method === 'GET') {
      json(response, 200, {
        directories: await directorySuggestions(url.searchParams.get('q') ?? '', options.headlessHub.snapshot()),
      });
      return;
    }
    // Verified browser bundles can remain active across a server upgrade. Keep
    // their former create route working while they refresh to workspace routes.
    if (url.pathname === '/api/sessions' && request.method === 'POST') {
      const body = parseJson(await readBody(request));
      if (
        !body ||
        typeof body !== 'object' ||
        !('cwd' in body) ||
        typeof body.cwd !== 'string' ||
        !body.cwd.trim() ||
        ('name' in body && typeof body.name !== 'string')
      ) {
        json(response, 400, { error: 'A session needs a working directory and an optional name.' });
        return;
      }
      const created = await options.headlessHub.sessionService.create({
        cwd: body.cwd,
        name: 'name' in body ? String(body.name) : path.basename(body.cwd),
      });
      json(response, 201, { sessionId: created.sessionId });
      return;
    }
    const workspaceSessions = /^\/api\/workspaces\/([^/]+)\/sessions$/u.exec(url.pathname);
    if (workspaceSessions) {
      const workspaceId = decodeURIComponent(workspaceSessions[1]);
      const workspace = options.headlessHub.workspaces().find((entry) => entry.id === workspaceId);
      if (!workspace) {
        json(response, 404, { error: 'Workspace not found.' });
        return;
      }
      if (request.method === 'GET') {
        json(response, 200, {
          sessions: [
            ...options.headlessHub
              .snapshot()
              .filter((session) => session.workspaceId === workspaceId)
              .map(sessionView),
            ...dormant()
              .filter((record) => record.workspaceId === workspaceId)
              .map(dormantView),
          ],
        });
        return;
      }
      if (request.method === 'POST') {
        const body = parseJson(await readBody(request));
        if (!body || typeof body !== 'object' || ('name' in body && typeof body.name !== 'string')) {
          json(response, 400, { error: 'A session accepts an optional name.' });
          return;
        }
        const created = await options.headlessHub.sessionService.create({
          cwd: workspace.root,
          name: 'name' in body ? String(body.name) : path.basename(workspace.root),
        });
        json(response, 201, { sessionId: created.sessionId });
        return;
      }
    }
    if (url.pathname === '/api/events' && request.method === 'GET') {
      response.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
      });
      sse.add(response);
      response.on('close', () => sse.delete(response));
      writeSse(response, 'sessions_snapshot', {
        type: 'sessions_snapshot',
        sessions: [...options.headlessHub.snapshot().map(sessionView), ...dormant().map(dormantView)],
      });
      return;
    }
    if (url.pathname === '/api/workspaces') {
      if (request.method === 'GET') {
        json(response, 200, { workspaces: options.headlessHub.workspaces() });
        return;
      }
      if (request.method === 'POST') {
        const body = parseJson(await readBody(request));
        if (typeof body !== 'object' || body === null || !('root' in body) || typeof body.root !== 'string') {
          json(response, 400, { error: 'A workspace root is required.' });
          return;
        }
        const workspace = await options.headlessHub.admitWorkspace(body.root);
        json(response, 201, { workspace });
        return;
      }
    }
    const workspaceMatch = /^\/api\/workspaces\/([^/]+)$/u.exec(url.pathname);
    if (workspaceMatch && request.method === 'GET') {
      const workspace = options.headlessHub
        .workspaces()
        .find((entry) => entry.id === decodeURIComponent(workspaceMatch[1]));
      json(response, workspace ? 200 : 404, workspace ? { workspace } : { error: 'Workspace not found.' });
      return;
    }
    if (workspaceMatch && request.method === 'DELETE') {
      const id = decodeURIComponent(workspaceMatch[1]);
      if (!options.headlessHub.workspaces().some((workspace) => workspace.id === id)) {
        json(response, 404, { error: 'Workspace not found.' });
        return;
      }
      if (options.headlessHub.snapshot().some((session) => session.workspaceId === id)) {
        json(response, 409, { error: 'Workspace still has live sessions.' });
        return;
      }
      await options.headlessHub.removeWorkspace(id);
      json(response, 200, { ok: true });
      return;
    }
    const pluginMatch = DOOM_PACKAGE_API_PATH_PATTERN.exec(url.pathname);
    if (pluginMatch !== null && request.method !== 'CONNECT') {
      const workspaceId = pluginMatch[1] === undefined ? undefined : decodeURIComponent(pluginMatch[1]);
      const sessionId = pluginMatch[2] === undefined ? undefined : decodeURIComponent(pluginMatch[2]);
      if (workspaceId !== undefined && !options.headlessHub.workspaces().some((entry) => entry.id === workspaceId)) {
        json(response, 404, { error: 'Workspace not found.' });
        return;
      }
      if (sessionId !== undefined && options.headlessHub.session(sessionId)?.workspaceId !== workspaceId) {
        json(response, 404, { error: 'Session not found.' });
        return;
      }
      const mount: DoomApiMount =
        sessionId !== undefined
          ? { scope: 'session', sessionId }
          : workspaceId !== undefined
            ? { scope: 'workspace', workspaceId }
            : { scope: 'global' };
      const basePath = pluginMatch[3] === undefined ? 'settings' : decodeURIComponent(pluginMatch[3]);
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(basePath)) {
        json(response, 400, { error: 'Invalid package API base path.' });
        return;
      }
      if (pluginMatch[3] === 'settings' || (sessionId !== undefined && basePath === 'settings')) {
        json(response, 404, { error: 'Not found.' });
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value !== undefined &&
          !['host', 'authorization', 'x-doompi-token', ...DOOM_API_CALLER_HEADERS].includes(name)
        )
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const abort = new AbortController();
      const disconnected = (): void => {
        if (!response.writableEnded) abort.abort();
      };
      response.once('close', disconnected);
      try {
        const started = performance.now();
        const attributes = {
          scope: mount.scope,
          'plugin.name': basePath,
          'http.operation': request.method,
          ...(mount.scope === 'workspace' ? { 'workspace.id': mount.workspaceId } : {}),
          ...(mount.scope === 'session' ? { 'session.id': mount.sessionId } : {}),
        };
        const dispatch = async () =>
          options.headlessHub.requestApi(
            mount,
            basePath,
            new Request(`http://doompi.local/${pluginMatch[4] ?? ''}${url.search}`, {
              method: request.method,
              headers,
              signal: abort.signal,
              ...(request.method === 'GET' || request.method === 'HEAD'
                ? {}
                : { body: Buffer.from(await readBody(request)) }),
            }),
          );
        const result = options.telemetry
          ? await options.telemetry.runInSpan('doompi_server.plugin.request', attributes, dispatch)
          : await dispatch();
        if (options.telemetry)
          observe(
            options.telemetry.recordEvent('doompi_server.plugin.response', {
              ...attributes,
              status: result.status,
              durationMs: performance.now() - started,
            }),
            options.onNotice,
          );
        await writeResponse(response, result);
      } finally {
        response.off('close', disconnected);
      }
      return;
    }
    const sessionMatch = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)(?:\/(.*))?$/u.exec(url.pathname);
    if (sessionMatch === null) {
      json(response, 404, { error: 'Not found.' });
      return;
    }
    const sessionId = decodeURIComponent(sessionMatch[2]);
    const workspaceId = decodeURIComponent(sessionMatch[1]);
    const session = options.headlessHub.session(sessionId);
    // Revive is the one session route that answers before a runtime exists: it
    // is what creates one.
    if (sessionMatch[3] === 'revive' && request.method === 'POST' && options.reviveSession) {
      const record = dormant().find(
        (candidate) => candidate.sessionId === sessionId && candidate.workspaceId === workspaceId,
      );
      if (record === undefined) {
        json(response, 404, { error: 'Dormant session not found.' });
        return;
      }
      await options.reviveSession(record);
      json(response, 200, { ok: true });
      return;
    }
    if (session === undefined || session.workspaceId !== workspaceId) {
      const record = dormant().find(
        (candidate) => candidate.sessionId === sessionId && candidate.workspaceId === workspaceId,
      );
      if (request.method === 'DELETE' && record !== undefined && options.removeDormantSession !== undefined) {
        await options.removeDormantSession(record);
        json(response, 200, { ok: true });
        return;
      }
      json(response, 404, { error: 'Session not found.' });
      return;
    }
    const suffix = sessionMatch[3] === undefined ? '' : `/${sessionMatch[3]}`;
    if (suffix === '' && request.method === 'GET') {
      json(response, 200, sessionView(session));
      return;
    }
    if (suffix === '' && request.method === 'DELETE') {
      await options.headlessHub.closeSession(sessionId);
      json(response, 200, { ok: true });
      return;
    }
    if (suffix === '/history' && request.method === 'GET' && options.sessionHistory) {
      json(response, 200, { sessions: await options.sessionHistory(session) });
      return;
    }
    if (suffix === '/file' && request.method === 'GET') {
      await writeResponse(response, await sessionFile(session, url.searchParams.get('path')));
      return;
    }
    if (suffix === '/restart' && request.method === 'POST' && options.restartSession) {
      await options.restartSession(session);
      json(response, 200, { ok: true });
      return;
    }
    if (suffix === '/resume' && request.method === 'POST' && options.resumeSession) {
      const body = parseJson(await readBody(request));
      const targetSessionId =
        body && typeof body === 'object' && 'targetSessionId' in body ? body.targetSessionId : undefined;
      if (typeof targetSessionId !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(targetSessionId)) {
        json(response, 400, { error: 'Invalid target session id.' });
        return;
      }
      json(response, 200, { sessionId: await options.resumeSession(session, targetSessionId) });
      return;
    }
    if (suffix === '/channels' && request.method === 'GET') {
      json(response, 200, { channels: options.headlessHub.channelFrames(sessionId) });
      return;
    }
    const channelMatch = /^\/channel\/([^/]+)$/u.exec(suffix);
    if (channelMatch !== null && request.method === 'POST') {
      const frameType = decodeURIComponent(channelMatch[1]);
      const connectionId = request.headers['x-doompi-connection'];
      options.headlessHub.receiveChannel(
        sessionId,
        frameType,
        parseJson(await readBody(request)),
        typeof connectionId === 'string' ? connectionId : 'http',
      );
      json(response, 202, { ok: true });
      return;
    }
    json(response, 404, { error: 'Not found.' });
  }

  server.on('upgrade', (request, socket, head) => {
    const url = requestPath(request);
    const mount = parseDoomSocketPath(url.pathname);
    if (!mount) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!authorized(request, options.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (
      mount.scope !== 'global' &&
      (!options.headlessHub.workspaces().some((entry) => entry.id === mount.workspaceId) ||
        (mount.scope === 'session' && options.headlessHub.session(mount.sessionId)?.workspaceId !== mount.workspaceId))
    ) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const prepare =
      mount.scope === 'global'
        ? Promise.resolve(protocol)
        : createHeadlessProtocol({
            hub: options.headlessHub,
            mount,
            telemetry: options.telemetry,
            onNotice: options.onNotice,
            dormantSessions: dormant,
          });
    void prepare
      .then(async (selected) => {
        if (closed || socket.destroyed) {
          if (selected !== protocol) await selected.close();
          socket.destroy();
          return;
        }
        if (selected !== protocol) {
          scopedProtocols.add(selected);
          socket.once('close', () => {
            void selected.close().finally(() => scopedProtocols.delete(selected));
          });
        }
        webSockets.handleUpgrade(request, socket, head, (client) => {
          webSockets.emit('connection', client, selected);
        });
      })
      .catch(() => {
        socket.destroy();
      });
  });
  webSockets.on('connection', (socket, selected: typeof protocol) => {
    const handler = selected.accept(socket);
    if (!handler) return;
    const client: Client = { socket, handler };
    clients.add(client);
    socket.on('message', (data) => {
      if (Buffer.isBuffer(data)) handler.onData(data);
      else if (Array.isArray(data)) handler.onData(Buffer.concat(data));
      else handler.onData(new Uint8Array(data as ArrayBuffer));
    });
    socket.on('close', () => {
      clients.delete(client);
      handler.onClose();
    });
    socket.on('error', (error) => handler.onError(error));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('The headless server did not expose a TCP address.');
  }
  const host = options.host ?? '127.0.0.1';
  const url = `http://${host}:${address.port}`;
  return {
    url,
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      for (const response of sse) response.end();
      sse.clear();
      for (const client of clients) client.socket.terminate();
      clients.clear();
      await Promise.all([protocol.close(), ...[...scopedProtocols].map((selected) => selected.close())]);
      webSockets.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}
