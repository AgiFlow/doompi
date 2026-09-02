import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-extension-contracts/package-api';
import { Hono } from 'hono';
import { baselineOf } from '../services/fileChanges.ts';
import { lineDiff } from '../services/lineDiff.ts';
import type { FileEditVersion } from '../types/domain.ts';
import {
  API_BASE_PATH,
  type FileEditsCumulativeView,
  type FileEditsDetailView,
  type FileEditsPreviewView,
  type FileEditsSaveRequest,
  type FileEditsSaveView,
  type FileEditsVersionView,
  type FileEditsWorkingView,
  PATH_QUERY_PARAM,
} from '../types/fileEditsApi.ts';
import type { IFileEditPaths } from '../types/fileEditPaths.ts';
import type { SnapshotStorePort } from '../types/snapshotStore.ts';
import type { ITimelineStore } from '../types/timelineStore.ts';
import { FileEditPaths } from './FileEditPaths/FileEditPaths.ts';
import { NodeSnapshotStoreAdapter } from './node/snapshotStore.ts';
import { TimelineStore } from './TimelineStore/TimelineStore.ts';

/**
 * This package's HTTP surface: one file's history, and the manual save.
 *
 * Routes are relative to the mount its host gives it, so nothing here repeats
 * where it was mounted. The host is one session's own server, which is what
 * makes the session id and working directory available without the page
 * supplying either: a page names a file, never a session's private paths.
 *
 * The detail route answers everything a reader needs to open a changed file,
 * because splitting it would make the page stitch three responses together for
 * one click. The save route is the only mutation, and it refuses unless the
 * reader proves they were looking at the content that is still on disk. The
 * preview route is the read-only way in to a file the session never changed,
 * bounded by the working directory instead of by the timeline.
 */

/** Past this, the working view reports the file rather than carrying it. */
export const MAX_WORKING_BYTES = 1024 * 1024;

const BINARY_SAMPLE_BYTES = 8192;
const NO_BASELINE_NOTE = 'changed by a command, so no baseline was captured; showing the file as it stands';
/**
 * A change the tool layer named but never captured content for. That is what
 * every record written before this package learned to snapshot looks like, and
 * calling those "changed by a command" would be wrong: the tool is right there
 * in the record.
 */
const NO_SNAPSHOT_NOTE = 'recorded before this session began capturing content, so there is no diff for it';
const APPROXIMATE_NOTE = 'the changed region was too large to match line by line';

export interface FileEditsApiOptions {
  /** The session these routes answer for; absent when the host is the hub. */
  sessionId?: string;
  /** The session's working directory, which relative paths are shown against. */
  cwd?: string;
  timeline?: ITimelineStore;
  snapshots?: SnapshotStorePort;
  paths?: IFileEditPaths;
}

function hashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads the file as the source view will show it, or says why it cannot. */
async function readWorking(filePath: string): Promise<FileEditsWorkingView> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(filePath);
  } catch {
    return { content: '', hash: '', unavailable: true, reason: 'the file no longer exists' };
  }
  if (raw.byteLength > MAX_WORKING_BYTES) {
    return { content: '', hash: '', unavailable: true, reason: `the file is larger than ${MAX_WORKING_BYTES} bytes` };
  }
  if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    return { content: '', hash: '', unavailable: true, reason: 'the file is binary' };
  }
  const content = raw.toString('utf8');
  return { content, hash: hashOf(content), unavailable: false };
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * The same containment check after symlinks are followed. A path that does not
 * exist yet resolves to nothing, and there is nothing to hand out, so it
 * passes and the read below reports it missing.
 */
async function isRealPathInside(root: string, candidate: string): Promise<boolean> {
  let realRoot: string;
  let real: string;
  try {
    realRoot = await fs.realpath(root);
    real = await fs.realpath(candidate);
  } catch {
    return true;
  }
  return isInside(realRoot, real);
}

/**
 * One recorded change as the page renders it. A change with both sides captured
 * carries its own diff; one without says why, rather than showing nothing.
 */
async function toVersionView(version: FileEditVersion, snapshots: SnapshotStorePort): Promise<FileEditsVersionView> {
  const view: FileEditsVersionView = {
    index: version.index,
    tool: version.tool,
    at: version.at,
    origin: version.origin,
    additions: version.additions ?? 0,
    removals: version.removals ?? 0,
  };
  if (version.before === undefined || version.after === undefined) {
    // A scan found the path only after it changed, so no baseline exists. A
    // tool named the path but the content was not stored: either it did not
    // fit, or the record predates content capture, which the tool tells apart.
    if (version.origin === 'tool') {
      return { ...view, note: 'this change could not be captured: the file is binary or past the size cap' };
    }
    return { ...view, note: version.tool === 'bash' ? NO_BASELINE_NOTE : NO_SNAPSHOT_NOTE };
  }
  const [before, after] = await Promise.all([snapshots.read(version.before), snapshots.read(version.after)]);
  if (before === undefined || after === undefined) {
    return { ...view, note: 'the content behind this change is no longer held' };
  }
  const diff = lineDiff(before, after);
  return {
    ...view,
    additions: diff.additions,
    removals: diff.removals,
    hunks: diff.hunks,
    ...(diff.approximate ? { note: APPROXIMATE_NOTE } : {}),
  };
}

/** Everything the session did to the file: its oldest baseline against what is on disk now. */
async function toCumulativeView(
  versions: readonly FileEditVersion[],
  working: FileEditsWorkingView,
  snapshots: SnapshotStorePort,
): Promise<FileEditsCumulativeView> {
  const baseline = baselineOf(versions);
  if (baseline === undefined) return { additions: 0, removals: 0, note: NO_BASELINE_NOTE };
  if (working.unavailable) {
    return { additions: 0, removals: 0, note: working.reason ?? 'the file cannot be read' };
  }
  const before = await snapshots.read(baseline);
  if (before === undefined) {
    return { additions: 0, removals: 0, note: 'the content this session started from is no longer held' };
  }
  const diff = lineDiff(before, working.content);
  return {
    additions: diff.additions,
    removals: diff.removals,
    hunks: diff.hunks,
    ...(diff.approximate ? { note: APPROXIMATE_NOTE } : {}),
  };
}

export function createFileEditsApi(options: FileEditsApiOptions = {}): Hono {
  const timeline = options.timeline ?? new TimelineStore();
  const snapshots = options.snapshots ?? new NodeSnapshotStoreAdapter();
  const paths = options.paths ?? new FileEditPaths();
  const cwd = options.cwd ?? '';
  const app = new Hono();

  // The routes and the extension run in different processes, so this half
  // opens the same two locations from the same inputs rather than sharing an
  // instance with the half that writes them.
  //
  // Only what this function built gets pointed at them. A store handed in
  // through the options arrives already configured, and repointing it would
  // make the option a lie: the caller would be injecting a store the routes
  // then read somewhere else entirely.
  if (options.sessionId !== undefined && cwd !== '') {
    const sessionKey = paths.sessionKey(options.sessionId);
    if (options.timeline === undefined) timeline.initialize(paths.timelinePath(cwd, sessionKey));
    if (options.snapshots === undefined) snapshots.initialize(paths.snapshotsPath(cwd, sessionKey));
  }

  /**
   * The file a request names, rejected unless this session actually recorded a
   * change to it. That check is the authorization: these routes read and write
   * whatever path they are handed, so the timeline is what bounds them to files
   * the session already touched.
   */
  const recordedVersions = async (filePath: string | undefined): Promise<FileEditVersion[] | undefined> => {
    if (filePath === undefined || filePath === '') return undefined;
    const versions = await timeline.versions(path.resolve(cwd, filePath));
    return versions.length === 0 ? undefined : versions;
  };

  app.get('/detail', async (context) => {
    const requested = context.req.query(PATH_QUERY_PARAM);
    const versions = await recordedVersions(requested);
    if (versions === undefined || requested === undefined) {
      return context.json({ error: 'This session recorded no changes to that file.' }, 404);
    }
    const filePath = path.resolve(cwd, requested);
    const working = await readWorking(filePath);
    const body: FileEditsDetailView = {
      path: filePath,
      relPath: cwd === '' ? filePath : path.relative(cwd, filePath),
      versions: await Promise.all(versions.map((version) => toVersionView(version, snapshots))),
      cumulative: await toCumulativeView(versions, working, snapshots),
      working,
    };
    return context.json(body);
  });

  /**
   * The file a request names, read only, for a file the timeline knows nothing
   * about: a path the agent read but never changed is still a path the reader
   * clicked, and refusing it would leave the link dead.
   *
   * The working directory is the boundary here, since the timeline is not.
   * Containment is checked lexically and again on the real path, so a symlink
   * inside the tree cannot hand out something beyond it, and a host that gave
   * these routes no working directory has no boundary to enforce and so serves
   * nothing.
   */
  app.get('/preview', async (context) => {
    const requested = context.req.query(PATH_QUERY_PARAM);
    if (requested === undefined || requested === '' || requested.includes('\0')) {
      return context.json({ error: 'A preview names a path.' }, 400);
    }
    if (cwd === '') return context.json({ error: 'This session has no working directory to read from.' }, 403);
    const root = path.resolve(cwd);
    const filePath = path.resolve(root, requested);
    if (!isInside(root, filePath) || !(await isRealPathInside(root, filePath))) {
      return context.json({ error: 'The path leaves the session directory.' }, 403);
    }
    const body: FileEditsPreviewView = {
      path: filePath,
      relPath: path.relative(root, filePath),
      working: await readWorking(filePath),
    };
    return context.json(body);
  });

  app.put('/content', async (context) => {
    let request: FileEditsSaveRequest;
    try {
      request = (await context.req.json()) as FileEditsSaveRequest;
    } catch {
      return context.json({ error: 'The save body is not JSON.' }, 400);
    }
    if (typeof request.path !== 'string' || typeof request.content !== 'string') {
      return context.json({ error: 'A save names a path and the content to write.' }, 400);
    }
    if ((await recordedVersions(request.path)) === undefined) {
      return context.json({ error: 'This session recorded no changes to that file.' }, 404);
    }
    const filePath = path.resolve(cwd, request.path);
    const current = await readWorking(filePath);
    if (current.unavailable) {
      return context.json({ error: current.reason ?? 'The file cannot be read.' }, 409);
    }
    // The agent runs in the same working directory, so it can rewrite the file
    // while a reader is still editing it. Refusing on a moved hash is what
    // stops the save from silently discarding whatever it did.
    if (current.hash !== request.expectedHash) {
      return context.json({ error: 'The file changed since it was opened.', hash: current.hash }, 409);
    }
    await fs.writeFile(filePath, request.content, 'utf8');
    const body: FileEditsSaveView = { hash: hashOf(request.content) };
    return context.json(body);
  });

  app.delete('/content', async (context) => {
    const requested = context.req.query(PATH_QUERY_PARAM);
    if ((await recordedVersions(requested)) === undefined || requested === undefined) {
      return context.json({ error: 'This session recorded no changes to that file.' }, 404);
    }
    const filePath = path.resolve(cwd, requested);
    try {
      await fs.unlink(filePath);
    } catch (error) {
      // Already gone is the outcome the caller wanted, so it is not a failure.
      if (!hasCode(error, 'ENOENT')) {
        return context.json({ error: `The file could not be deleted: ${describe(error)}` }, 409);
      }
    }
    return context.body(null, 204);
  });

  return app;
}

/** The named export a host imports from this package's built entry. */
export const api: DoomApi = {
  basePath: API_BASE_PATH,
  start(context: DoomApiContext): DoomApiHandler {
    const app = createFileEditsApi({
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
    });
    return {
      fetch: (request) => app.fetch(request),
      // Nothing outlives a request here: every route reads, answers and closes.
      close: () => undefined,
    };
  },
};
