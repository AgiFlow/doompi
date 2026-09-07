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
import { createDoomIgnoreMatcher } from '../src/services/doomIgnore.ts';
import type { FileEditsDetailView } from '../src/types/fileEditsApi.ts';
import { detailUrl } from '../src/types/fileEditsApi.ts';
import type { GitStatusPort } from '../src/types/gitStatus.ts';

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
function startExtension(options: { git?: GitStatusPort; isIgnored?: (filePath: string) => boolean } = {}) {
  const sessionKey = paths.sessionKey(SESSION_ID);
  const timelinePath = paths.timelinePath(cwd, sessionKey);
  const snapshotsPath = paths.snapshotsPath(cwd, sessionKey);
  const timeline = new TimelineStore();
  timeline.initialize(timelinePath);
  const snapshots = new NodeSnapshotStoreAdapter();
  snapshots.initialize(snapshotsPath);
  const tracker = new EditTracker(
    timeline,
    snapshots,
    new NodeTreeManifestAdapter(),
    options.git === undefined ? {} : { git: options.git },
  );
  tracker.reset({
    exclude: [timelinePath, `${timelinePath}.lock`, snapshotsPath],
    ...(options.isIgnored === undefined ? {} : { isIgnored: options.isIgnored }),
  });
  return { timeline, snapshots, tracker, timelinePath, snapshotsPath };
}

/** Every line the tracker actually appended, including the ones no surface shows. */
function readRawTimeline(timelinePath: string): Record<string, unknown>[] {
  return fs
    .readFileSync(timelinePath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Moves a file's modification time without touching a byte of it. */
function touch(filePath: string): void {
  // Ahead of now, so the write always lands inside the call being closed rather
  // than depending on how coarsely the filesystem stores a timestamp.
  const when = new Date(Date.now() + 1_000);
  fs.utimesSync(filePath, when, when);
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

  it('leaves out a file a command only touched, once it has the content to compare', async () => {
    const { tracker } = startExtension();
    const filePath = path.join(cwd, 'generated.txt');
    fs.writeFileSync(filePath, 'before');

    await tracker.start('call-1', 'bash', { command: 'node scripts/codemod.mjs' }, cwd);
    fs.writeFileSync(filePath, 'after the script ran');
    await tracker.end('call-1', false, cwd);

    // The second call rewrites the identical bytes, which moves the modification
    // time the walk reads and nothing a reader would call an edit.
    await tracker.start('call-2', 'bash', { command: 'touch generated.txt' }, cwd);
    fs.writeFileSync(filePath, 'after the script ran');
    await tracker.end('call-2', false, cwd);

    expect(readHubRows()).toEqual([
      { path: filePath, relPath: 'generated.txt', tool: 'bash', at: expect.any(Number), count: 1, diffable: false },
    ]);
  });

  it('leaves out a file something else wrote between two commands, and keeps the one written during', async () => {
    // The working tree is shared. Another session, a background agent, or the
    // user's own editor writes into it while this session is not running a
    // command, and the next walk sees a fingerprint that moved without anything
    // here having moved it.
    const { tracker } = startExtension();
    const outside = path.join(cwd, 'someone-else.ts');
    const mine = path.join(cwd, 'mine.ts');
    fs.writeFileSync(outside, 'before');
    fs.writeFileSync(mine, 'before');

    await tracker.start('call-1', 'bash', { command: 'ls' }, cwd);
    await tracker.end('call-1', false, cwd);

    fs.writeFileSync(outside, 'written by someone else entirely');
    const aWhileAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(outside, aWhileAgo, aWhileAgo);

    await tracker.start('call-2', 'bash', { command: 'node scripts/codemod.mjs' }, cwd);
    fs.writeFileSync(mine, 'written by the command');
    await tracker.end('call-2', false, cwd);

    expect(readHubRows().map((row) => row.relPath)).toEqual(['mine.ts']);
  });
  it('leaves out a first-seen file git reports as unmodified', async () => {
    const clean = path.join(cwd, 'committed.txt');
    const ignored = path.join(cwd, 'temp.log');
    // Git knows the tracked file and says its bytes never moved; it has nothing
    // to say about the ignored one, so that one is still recorded.
    const git: GitStatusPort = { unchanged: async () => new Set([clean]) };
    const { tracker } = startExtension({ git });
    fs.writeFileSync(clean, 'committed');
    fs.writeFileSync(ignored, 'log');

    await tracker.start('call-1', 'bash', { command: 'git checkout . && ./run.sh' }, cwd);
    fs.writeFileSync(clean, 'committed');
    fs.writeFileSync(ignored, 'log line two');
    await tracker.end('call-1', false, cwd);

    expect(readHubRows().map((row) => row.relPath)).toEqual(['temp.log']);
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

  it('leaves out a touched file git cannot vouch for, and still records the evidence', async () => {
    // The case nothing caught before: a path git has no opinion on, because it
    // is untracked or ignored, whose modification time moved while its bytes
    // did not, and which this session had never captured to compare against.
    const git: GitStatusPort = { unchanged: async () => new Set() };
    const { tracker, timelinePath } = startExtension({ git });
    const filePath = path.join(cwd, 'artifact.log');
    fs.writeFileSync(filePath, 'same bytes throughout');

    await tracker.start('call-1', 'bash', { command: 'pnpm test' }, cwd);
    touch(filePath);
    await tracker.end('call-1', false, cwd);

    // Nothing proved the content moved, so no surface claims it did.
    expect(readHubRows()).toEqual([]);
    // The row is still on disk: the timeline is the evidence, and hiding a
    // thing from a reader is not the same as never having seen it.
    const recorded = readRawTimeline(timelinePath);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.path).toBe(filePath);
    expect(recorded[0]?.origin).toBe('scan');
    expect(recorded[0]?.verified).toBeUndefined();
  });

  it('lists a file a command created, because appearing is proof enough', async () => {
    const { tracker } = startExtension();
    const filePath = path.join(cwd, 'built.txt');

    await tracker.start('call-1', 'bash', { command: 'node scripts/build.mjs' }, cwd);
    fs.writeFileSync(filePath, 'produced by the script\n');
    await tracker.end('call-1', false, cwd);

    expect(readHubRows().map((row) => row.relPath)).toEqual(['built.txt']);
  });

  it('lists a file a command rewrote to a different length without asking git', async () => {
    // Size alone settles it, so a git answer is never needed and a git failure
    // cannot turn this into a false negative.
    const git: GitStatusPort = { unchanged: async () => new Set() };
    const { tracker } = startExtension({ git });
    const filePath = path.join(cwd, 'grown.txt');
    fs.writeFileSync(filePath, 'short');

    await tracker.start('call-1', 'bash', { command: 'node scripts/append.mjs' }, cwd);
    fs.writeFileSync(filePath, 'much longer than it was before');
    await tracker.end('call-1', false, cwd);

    expect(readHubRows().map((row) => row.relPath)).toEqual(['grown.txt']);
  });

  it('never records or stores a path the project disowns', async () => {
    const ignored = createDoomIgnoreMatcher('build-output/\n');
    if (ignored === undefined) throw new Error('a rule line must produce a matcher');
    const { tracker, timelinePath, snapshotsPath } = startExtension({
      isIgnored: (filePath: string) => ignored(path.relative(cwd, filePath)),
    });
    const disowned = path.join(cwd, 'build-output', 'bundle.js');
    const kept = path.join(cwd, 'src.js');
    fs.mkdirSync(path.dirname(disowned), { recursive: true });

    await tracker.start('call-1', 'bash', { command: 'pnpm build' }, cwd);
    fs.writeFileSync(disowned, 'a bundle nobody edited');
    fs.writeFileSync(kept, 'source the script also rewrote');
    await tracker.end('call-1', false, cwd);

    expect(readHubRows().map((row) => row.relPath)).toEqual(['src.js']);
    // Dropped before it cost a read, so its content was never copied either.
    expect(readRawTimeline(timelinePath).map((row) => row.path)).toEqual([kept]);
    const stored = fs.existsSync(snapshotsPath) ? fs.readdirSync(snapshotsPath) : [];
    expect(stored).toHaveLength(1);
  });

  it('does not copy the content of a file git proves untouched', async () => {
    const filePath = path.join(cwd, 'clean.txt');
    const git: GitStatusPort = { unchanged: async () => new Set([filePath]) };
    const { tracker, snapshotsPath } = startExtension({ git });
    fs.writeFileSync(filePath, 'identical to what git holds');

    await tracker.start('call-1', 'bash', { command: 'git checkout .' }, cwd);
    touch(filePath);
    await tracker.end('call-1', false, cwd);

    expect(readHubRows()).toEqual([]);
    // Asking git first is what keeps this file out of the blob store entirely.
    const stored = fs.existsSync(snapshotsPath) ? fs.readdirSync(snapshotsPath) : [];
    expect(stored).toEqual([]);
  });

  it('still records what a failed command wrote before it failed', async () => {
    const { tracker } = startExtension();
    const filePath = path.join(cwd, 'half-written.txt');

    await tracker.start('call-1', 'bash', { command: 'node scripts/flaky.mjs' }, cwd);
    fs.writeFileSync(filePath, 'written before the command gave up\n');
    await tracker.end('call-1', true, cwd);

    // A command that failed can still have written, and skipping the walk would
    // also leave the baseline stale for whichever call closes next.
    expect(readHubRows().map((row) => row.relPath)).toEqual(['half-written.txt']);
  });

  it('lists the source a test run changed and none of the artifacts it produced', async () => {
    // The reported bug, in miniature. A single command writes one source file
    // and a pile of run output; only the source file is an edit.
    const { tracker } = startExtension();
    const source = path.join(cwd, 'src', 'app.spec.ts');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'the original expectation\n');

    await tracker.start('call-1', 'bash', { command: 'pnpm exec playwright test' }, cwd);
    fs.writeFileSync(source, 'the expectation, now corrected\n');
    for (const relative of [
      'test-results/.playwright-artifacts-0/trace.jsonl',
      'test-results/.playwright-artifacts-0/screenshot.png',
      'playwright-report/index.html',
      'logs/telemetry/doom-file-edit.jsonl',
    ]) {
      const artifact = path.join(cwd, relative);
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.writeFileSync(artifact, 'run output');
    }
    await tracker.end('call-1', false, cwd);

    expect(readHubRows().map((row) => row.relPath)).toEqual([path.join('src', 'app.spec.ts')]);
  });
});
