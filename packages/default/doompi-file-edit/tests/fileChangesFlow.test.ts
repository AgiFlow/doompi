import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditTracker } from '../src/adapters/EditTracker/EditTracker.ts';
import { createFileEditsApi } from '../src/adapters/fileEditsApi.ts';
import { FileEditPaths } from '../src/adapters/FileEditPaths/FileEditPaths.ts';
import { NodeSnapshotStoreAdapter } from '../src/adapters/node/snapshotStore.ts';
import { NodeTreeManifestAdapter } from '../src/adapters/node/treeManifest.ts';
import { readSessionFiles } from '../src/adapters/webFilesChannel.ts';
import { TimelineStore } from '../src/adapters/TimelineStore/TimelineStore.ts';
import type { FileEditsDetailView } from '../src/types/fileEditsApi.ts';
import { detailUrl } from '../src/types/fileEditsApi.ts';

/**
 * The three halves meeting on disk.
 *
 * The extension writes the timeline, the cockpit hub reads it, and the session
 * API answers from it, each in its own process. Nothing passes a path between
 * them: all three derive it from the session id and working directory through
 * FileEditPaths. That agreement is the whole integration, so it is worth a test
 * that exercises the real adapters rather than doubles.
 */

const SESSION_ID = 'session-under-test';

let agentDirectory: string;
let cwd: string;
let paths: FileEditPaths;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-file-edit-flow-'));
  agentDirectory = path.join(root, 'agent');
  cwd = path.join(root, 'repo');
  fs.mkdirSync(agentDirectory, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  paths = new FileEditPaths();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(path.dirname(cwd), { recursive: true, force: true });
});

/** The extension half: what the Pi adapter wires up at session_start. */
function startExtension() {
  const sessionKey = paths.sessionKey(SESSION_ID);
  const timelinePath = paths.timelinePath(cwd, sessionKey);
  const snapshotsPath = paths.snapshotsPath(cwd, sessionKey);
  const timeline = new TimelineStore();
  timeline.initialize(timelinePath);
  const snapshots = new NodeSnapshotStoreAdapter();
  snapshots.initialize(snapshotsPath);
  const tracker = new EditTracker(timeline, snapshots, new NodeTreeManifestAdapter());
  tracker.reset({ exclude: [timelinePath, `${timelinePath}.lock`, snapshotsPath] });
  return { timeline, snapshots, tracker, timelinePath };
}

/** The hub half: it is handed only a session id and a working directory. */
function readHubRows() {
  const timelinePath = paths.timelinePath(cwd, paths.sessionKey(SESSION_ID));
  return readSessionFiles(timelinePath, cwd);
}

/** The API half: it is handed only a session id and a working directory too. */
async function readApiDetail(filePath: string): Promise<FileEditsDetailView> {
  const app = createFileEditsApi({ sessionId: SESSION_ID, cwd });
  const response = await app.fetch(
    new Request(`http://host${detailUrl(SESSION_ID, filePath).replace('/api/plugin/file-edits', '')}`),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as FileEditsDetailView;
}

describe('a session’s file changes, end to end', () => {
  it('carries a tool edit from the tracker to the dock row and the file’s detail', async () => {
    const { tracker } = startExtension();
    const filePath = path.join(cwd, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'one\ntwo\n');

    await tracker.start('call-1', 'edit', { path: filePath }, cwd);
    fs.writeFileSync(filePath, 'one\ntwo\nthree\n');
    await tracker.end('call-1', false, cwd);

    // The hub finds the timeline from the session id and cwd alone.
    expect(readHubRows()).toEqual([
      {
        path: filePath,
        relPath: path.join('src', 'app.ts'),
        tool: 'edit',
        at: expect.any(Number),
        count: 1,
        diffable: true,
      },
    ]);

    const detail = await readApiDetail(filePath);
    expect(detail.relPath).toBe(path.join('src', 'app.ts'));
    expect(detail.versions).toHaveLength(1);
    expect(detail.versions[0]?.hunks?.[0]?.rows).toContainEqual({ marker: '+', line: 3, content: 'three' });
    expect(detail.cumulative.additions).toBe(1);
    expect(detail.working.content).toBe('one\ntwo\nthree\n');
  });

  it('carries a scripted bash change through as listed but undiffable', async () => {
    const { tracker } = startExtension();
    const filePath = path.join(cwd, 'generated.txt');
    fs.writeFileSync(filePath, 'before');

    await tracker.start('call-1', 'bash', { command: 'node scripts/codemod.mjs' }, cwd);
    fs.writeFileSync(filePath, 'after the script ran');
    await tracker.end('call-1', false, cwd);

    expect(readHubRows()).toEqual([
      { path: filePath, relPath: 'generated.txt', tool: 'bash', at: expect.any(Number), count: 1, diffable: false },
    ]);

    const detail = await readApiDetail(filePath);
    expect(detail.versions[0]?.hunks).toBeUndefined();
    expect(detail.versions[0]?.note).toContain('no baseline');
    // Still readable and therefore still editable, which is why it is listed.
    expect(detail.working.content).toBe('after the script ran');
  });

  it('shows a file edited twice as two changes with one cumulative diff', async () => {
    const { tracker } = startExtension();
    const filePath = path.join(cwd, 'app.ts');
    fs.writeFileSync(filePath, 'a\n');

    await tracker.start('call-1', 'edit', { path: filePath }, cwd);
    fs.writeFileSync(filePath, 'a\nb\n');
    await tracker.end('call-1', false, cwd);
    await tracker.start('call-2', 'edit', { path: filePath }, cwd);
    fs.writeFileSync(filePath, 'a\nb\nc\n');
    await tracker.end('call-2', false, cwd);

    expect(readHubRows()[0]?.count).toBe(2);
    const detail = await readApiDetail(filePath);
    expect(detail.versions.map((version) => version.index)).toEqual([1, 2]);
    // Each change shows only what it did.
    expect(detail.versions[0]?.additions).toBe(1);
    expect(detail.versions[1]?.additions).toBe(1);
    // The whole session's change runs from the first baseline to what is on disk.
    expect(detail.cumulative.additions).toBe(2);
  });

  it('keeps the package’s own storage out of the changes it reports', async () => {
    // Inside a git worktree the timeline lands under the repository's own git
    // directory, which can sit inside the tree the tracker walks.
    const { tracker, timelinePath } = startExtension();
    expect(timelinePath.startsWith(agentDirectory)).toBe(true);
    const filePath = path.join(cwd, 'app.ts');
    fs.writeFileSync(filePath, 'before');

    await tracker.start('call-1', 'bash', { command: 'true' }, cwd);
    fs.writeFileSync(filePath, 'after');
    await tracker.end('call-1', false, cwd);
    await tracker.start('call-2', 'bash', { command: 'true' }, cwd);
    await tracker.end('call-2', false, cwd);

    // The second call recorded nothing: the first call's own bookkeeping is
    // not a change, and neither is the file it already accounted for.
    expect(readHubRows().map((row) => [row.relPath, row.count])).toEqual([['app.ts', 1]]);
  });

  it('stops listing a file the session deleted, while a tab open on it still answers', async () => {
    const { tracker } = startExtension();
    const kept = path.join(cwd, 'kept.ts');
    const removed = path.join(cwd, 'removed.ts');
    fs.writeFileSync(kept, 'a\n');
    fs.writeFileSync(removed, 'b\n');

    await tracker.start('call-1', 'edit', { path: kept }, cwd);
    fs.writeFileSync(kept, 'a\nb\n');
    await tracker.end('call-1', false, cwd);
    await tracker.start('call-2', 'bash', { command: 'rm removed.ts' }, cwd);
    fs.rmSync(removed);
    await tracker.end('call-2', false, cwd);

    // The dock drops it, because there is nothing left to open.
    expect(readHubRows().map((row) => row.relPath)).toEqual(['kept.ts']);
    // The timeline still holds the change, so a tab already open keeps working
    // and says why it has nothing to show.
    const detail = await readApiDetail(removed);
    expect(detail.working.unavailable).toBe(true);
    expect(detail.working.reason).toContain('no longer exists');
  });

  it('reports nothing before the session has changed anything', () => {
    startExtension();
    expect(readHubRows()).toEqual([]);
  });
});
