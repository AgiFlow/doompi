import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { TASK_EVENT, type TaskErrorSink, type TaskEventSink } from '../src/exports/logSinkTelemetry';
import {
  ERR_ORPHANED_BY_RESTART,
  ERR_ORPHANED_BY_SESSION,
  reconcileOrphanedDelegations,
} from '../src/exports/store/reconcile';
import { applyTaskMutation, isCommittingOp, type Op, singleItemOutcome } from '../src/exports/store/reducer';
import { TaskStore } from '../src/exports/store/taskStore';
import { emptyDocument, type TaskDocument } from '../src/exports/store/types';

const NOW = '2026-07-31T00:00:00.000Z';
const DEAD_PID = 2 ** 30;

let directory: string;
let storePath: string;

function makeReport(): { error: Mock<TaskErrorSink>; warn: Mock<TaskErrorSink>; event: Mock<TaskEventSink> } {
  return { error: vi.fn(), warn: vi.fn(), event: vi.fn() };
}

function delegatedDocument(state: 'running' | 'requested', pid: number): TaskDocument {
  return {
    ...emptyDocument(),
    tasks: [
      {
        id: 1,
        subject: 'orphan',
        status: 'in_progress',
        delegation: { requestId: 'r1', agent: 'reviewer', state, pid },
      },
    ],
  };
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-task-'));
  storePath = path.join(directory, 'tasks.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

function createTask(store: TaskStore, subject: string): Promise<unknown> {
  return store.mutate((document) => {
    const result = applyTaskMutation(document, 'upsert', { tasks: [{ subject }] });
    return { document: result.document, value: result.op };
  });
}

function createTasks(store: TaskStore, subjects: string[]): Promise<unknown> {
  return store.mutate((document) => {
    const result = applyTaskMutation(document, 'upsert', { tasks: subjects.map((subject) => ({ subject })) });
    return { document: result.document, value: result.op };
  });
}

describe('TaskStore', () => {
  it('starts empty when the file does not exist', () => {
    const store = new TaskStore({ storePath });

    expect(store.read()).toEqual(emptyDocument());
  });

  it('reads the initial document asynchronously', async () => {
    fs.writeFileSync(storePath, JSON.stringify({ ...emptyDocument(), rev: 3 }), 'utf8');
    const store = new TaskStore({ storePath });

    await expect(store.readAsync()).resolves.toMatchObject({ rev: 3 });
  });

  it('does not publish an asynchronous read after its session becomes stale', async () => {
    fs.writeFileSync(storePath, JSON.stringify({ ...emptyDocument(), rev: 3 }), 'utf8');
    const store = new TaskStore({ storePath });

    await expect(store.readAsync(() => false)).resolves.toMatchObject({ rev: 3 });

    expect(store.snapshot).toEqual(emptyDocument());
  });

  it('persists mutations and bumps rev on each commit', async () => {
    const store = new TaskStore({ storePath });

    await createTask(store, 'first');
    await createTask(store, 'second');

    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8')) as TaskDocument;
    expect(persisted.tasks.map((task) => task.subject)).toEqual(['first', 'second']);
    expect(persisted.rev).toBe(2);
    store.dispose();
  });

  it('notifies committed listeners with before and durable after snapshots', async () => {
    const onCommitted = vi.fn();
    const store = new TaskStore({ storePath, onCommitted });

    await createTask(store, 'first');
    await store.mutate((document) => ({ value: document.tasks.length }));

    expect(onCommitted).toHaveBeenCalledOnce();
    expect(onCommitted.mock.calls[0]?.[0]).toMatchObject({ rev: 0, tasks: [] });
    expect(onCommitted.mock.calls[0]?.[1]).toMatchObject({
      rev: 1,
      tasks: [expect.objectContaining({ subject: 'first' })],
    });
  });

  it('reports committed listener failures without failing the durable mutation', async () => {
    const report = makeReport();
    const store = new TaskStore({
      storePath,
      report,
      onCommitted: () => {
        throw new Error('listener unavailable');
      },
    });

    await expect(createTask(store, 'first')).resolves.toBeDefined();

    expect(store.read().tasks).toHaveLength(1);
    expect(report.error).toHaveBeenCalledWith(
      TASK_EVENT.storeCommitListenerFailed,
      expect.objectContaining({ message: 'listener unavailable' }),
      { 'store.path': storePath },
    );
  });

  it('commits a whole batch as one write', async () => {
    const store = new TaskStore({ storePath });

    await createTasks(
      store,
      Array.from({ length: 8 }, (_, index) => `task-${index}`),
    );

    // One call, one commit: the overlay's external-change poll keys off `rev`,
    // so a batch must not wake every sibling session eight times.
    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8')) as TaskDocument;
    expect(persisted.rev).toBe(1);
    expect(new Set(persisted.tasks.map((task) => task.id)).size).toBe(8);
    expect(persisted.nextId).toBe(9);
    store.dispose();
  });

  it('does not bump rev for read-only mutations', async () => {
    const store = new TaskStore({ storePath });
    await createTask(store, 'first');

    await store.mutate((document) => ({ value: document.tasks.length }));

    expect(store.read().rev).toBe(1);
    store.dispose();
  });

  it('makes concurrent writers serialize instead of clobbering', async () => {
    const writers = Array.from({ length: 8 }, (_, index) => {
      const store = new TaskStore({ storePath });
      return createTask(store, `task-${index}`);
    });

    await Promise.all(writers);

    const persisted = new TaskStore({ storePath }).read();
    expect(persisted.tasks).toHaveLength(8);
    expect(new Set(persisted.tasks.map((task) => task.id)).size).toBe(8);
  });

  it('recovers from a corrupt file rather than throwing', () => {
    fs.writeFileSync(storePath, '{ this is not json', 'utf8');
    const store = new TaskStore({ storePath });

    expect(store.read().tasks).toEqual([]);
  });

  it('repairs nextId when it trails the highest existing id', () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify({ version: 1, rev: 3, nextId: 1, tasks: [{ id: 7, subject: 'a', status: 'pending' }] }),
      'utf8',
    );
    const store = new TaskStore({ storePath });

    expect(store.read().nextId).toBe(8);
  });

  it('normalizes duplicate task ids to the newest snapshot', () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        rev: 3,
        nextId: 2,
        tasks: [
          { id: 1, subject: 'stale', status: 'pending', updatedAt: '2026-08-18T10:22:00.000Z' },
          { id: 1, subject: 'current', status: 'in_progress', updatedAt: '2026-08-18T10:23:00.000Z' },
        ],
      }),
      'utf8',
    );
    const store = new TaskStore({ storePath });

    expect(store.read().tasks).toEqual([expect.objectContaining({ id: 1, subject: 'current', status: 'in_progress' })]);
  });

  it('breaks a lock left behind by a dead process', async () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(`${storePath}.lock`, JSON.stringify({ pid: DEAD_PID, time: Date.now() }), 'utf8');
    const store = new TaskStore({ storePath });

    await createTask(store, 'first');

    expect(store.read().tasks).toHaveLength(1);
    store.dispose();
  });

  it('gives up on a lock that never clears instead of looping forever', async () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(`${storePath}.lock`, JSON.stringify({ pid: DEAD_PID, time: Date.now() }), 'utf8');
    // The holder looks dead, so every pass tries to break the lock. Removing it
    // never succeeds here, which is the shape that used to spin without bound.
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    const report = makeReport();
    const store = new TaskStore({ storePath, lockTimeoutMs: 100, report });

    await createTask(store, 'first');

    expect(report.warn).toHaveBeenCalledWith(TASK_EVENT.storeLockTimeout, expect.any(Error), expect.anything());
    expect(store.read().tasks).toHaveLength(1);
    store.dispose();
  });

  it('reports an unreadable store but stays quiet about a missing one', () => {
    const report = makeReport();

    expect(new TaskStore({ storePath, report }).read().tasks).toEqual([]);
    expect(report.error).not.toHaveBeenCalled();

    fs.writeFileSync(storePath, '{ this is not json', 'utf8');
    expect(new TaskStore({ storePath, report }).read().tasks).toEqual([]);

    expect(report.error).toHaveBeenCalledWith(TASK_EVENT.storeReadFailed, expect.anything(), expect.anything());
  });

  it('contains a failing change listener instead of letting it escape the poll timer', async () => {
    const report = makeReport();
    const store = new TaskStore({ storePath, pollIntervalMs: 20, report });
    store.read();
    const unsubscribe = store.onExternalChange(() => {
      throw new Error('extension context is stale');
    });

    await createTask(new TaskStore({ storePath }), 'external');
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(report.error).toHaveBeenCalledWith(TASK_EVENT.storeListenerFailed, expect.any(Error), expect.anything());
    unsubscribe();
    store.dispose();
  });

  it('keeps asynchronous polling checks non-overlapping', async () => {
    fs.writeFileSync(storePath, JSON.stringify(emptyDocument()), 'utf8');
    const realReadFile = fs.promises.readFile.bind(fs.promises);
    let concurrent = 0;
    let maximumConcurrent = 0;
    vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 40));
      try {
        return await realReadFile(...args);
      } finally {
        concurrent -= 1;
      }
    });
    const store = new TaskStore({ storePath, pollIntervalMs: 10 });
    const unsubscribe = store.onExternalChange(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(maximumConcurrent).toBe(1);
    unsubscribe();
    store.dispose();
  });

  it('notifies listeners when another process writes the file', async () => {
    const store = new TaskStore({ storePath, pollIntervalMs: 20 });
    store.read();
    const seen: number[] = [];
    const unsubscribe = store.onExternalChange((document) => seen.push(document.rev));

    await createTask(new TaskStore({ storePath }), 'external');
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(seen.at(-1)).toBe(1);
    unsubscribe();
    store.dispose();
  });
});

describe('Task Space commit path', () => {
  /** Returns the entry outcome, which is what the overlay reads to report a rejection. */
  async function updateTask(store: TaskStore, item: Record<string, unknown>): Promise<unknown> {
    const outcome = await store.mutate<Op>((document) => {
      const result = applyTaskMutation(document, 'upsert', { tasks: [item] });
      // A rejected mutation is not committed, so the store keeps the prior row.
      if (!isCommittingOp(result.op)) return { value: result.op };
      return { document: result.document, value: result.op };
    });
    return singleItemOutcome(outcome.value);
  }

  it('persists a status change and bumps rev exactly once', async () => {
    const store = new TaskStore({ storePath });
    await createTask(store, 'pick me');
    const revBefore = store.read().rev;

    await updateTask(store, { id: 1, status: 'in_progress' });

    expect(store.read().tasks[0].status).toBe('in_progress');
    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8')) as TaskDocument;
    expect(persisted.tasks[0].status).toBe('in_progress');
    expect(store.read().rev).toBe(revBefore + 1);
    store.dispose();
  });

  it('does not rewrite the store or bump rev for an unchanged update', async () => {
    const store = new TaskStore({ storePath });
    await createTask(store, 'pick me');
    const revBefore = store.read().rev;
    const contentsBefore = fs.readFileSync(storePath, 'utf8');
    const write = vi.spyOn(fs, 'writeFileSync');
    const rename = vi.spyOn(fs, 'renameSync');

    const outcome = await updateTask(store, { id: 1, status: 'pending' });

    expect(outcome).toMatchObject({ kind: 'unchanged', id: 1, status: 'pending' });
    expect(write).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(store.read().rev).toBe(revBefore);
    expect(fs.readFileSync(storePath, 'utf8')).toBe(contentsBefore);
    store.dispose();
  });

  it('commits a mixed changed and unchanged batch with one write', async () => {
    const store = new TaskStore({ storePath });
    await createTasks(store, ['first', 'second']);
    const revBefore = store.read().rev;
    const write = vi.spyOn(fs, 'writeFileSync');
    const rename = vi.spyOn(fs, 'renameSync');

    const outcome = await store.mutate<Op>((document) => {
      const result = applyTaskMutation(document, 'upsert', {
        tasks: [
          { id: 1, status: 'pending' },
          { id: 2, status: 'in_progress' },
        ],
      });
      return {
        ...(isCommittingOp(result.op) ? { document: result.document } : {}),
        value: result.op,
      };
    });

    expect(outcome.value).toMatchObject({
      applied: 2,
      items: [
        { kind: 'unchanged', id: 1 },
        { kind: 'updated', id: 2 },
      ],
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(store.read().rev).toBe(revBefore + 1);
    store.dispose();
  });

  it('rejects a status outside TASK_STATUSES and leaves the stored status alone', async () => {
    const store = new TaskStore({ storePath });
    await createTask(store, 'pick me');

    const op = await updateTask(store, { id: 1, status: 'archived' });

    expect(op).toMatchObject({ kind: 'failed' });
    expect(store.read().tasks[0].status).toBe('pending');
    store.dispose();
  });

  it('persists an edited subject across a fresh store instance', async () => {
    const store = new TaskStore({ storePath });
    await createTask(store, 'original subject');

    await updateTask(store, { id: 1, subject: 'edited subject' });

    expect(store.read().tasks[0].subject).toBe('edited subject');
    expect(new TaskStore({ storePath }).read().tasks[0].subject).toBe('edited subject');
    store.dispose();
  });

  it('rejects a blank subject rather than persisting an empty row', async () => {
    const store = new TaskStore({ storePath });
    await createTask(store, 'original subject');

    const op = await updateTask(store, { id: 1, subject: '   ' });

    expect(op).toMatchObject({ kind: 'failed' });
    expect(store.read().tasks[0].subject).toBe('original subject');
    store.dispose();
  });
});

describe('reconcileOrphanedDelegations', () => {
  it('returns tasks owned by a dead pid to pending', () => {
    const document = delegatedDocument('running', 999);

    const result = reconcileOrphanedDelegations(document, NOW, () => false);

    expect(result.orphaned).toHaveLength(1);
    expect(result.document.tasks[0].status).toBe('pending');
    expect(result.document.tasks[0].delegation?.state).toBe('failed');
    expect(result.document.tasks[0].delegation?.result?.error).toBe(ERR_ORPHANED_BY_RESTART);
  });

  it('leaves delegations owned by a live pid alone', () => {
    const document = delegatedDocument('running', process.pid);

    const result = reconcileOrphanedDelegations(document, NOW, () => true);

    expect(result.orphaned).toEqual([]);
    expect(result.document).toBe(document);
  });

  it('recovers a delegation this process is no longer tracking', () => {
    const document = delegatedDocument('running', process.pid);

    const result = reconcileOrphanedDelegations(document, NOW, () => true, {
      pid: process.pid,
      liveRequestIds: new Set(),
    });

    expect(result.orphaned).toHaveLength(1);
    expect(result.document.tasks[0].status).toBe('pending');
    expect(result.document.tasks[0].delegation?.result?.error).toBe(ERR_ORPHANED_BY_SESSION);
  });

  it('leaves a delegation this process is still tracking alone', () => {
    const document = delegatedDocument('running', process.pid);

    const result = reconcileOrphanedDelegations(document, NOW, () => true, {
      pid: process.pid,
      liveRequestIds: new Set(['r1']),
    });

    expect(result.orphaned).toEqual([]);
    expect(result.document).toBe(document);
  });

  it('does not claim a live delegation belonging to a parallel session', () => {
    const document = delegatedDocument('running', process.pid + 1);

    const result = reconcileOrphanedDelegations(document, NOW, () => true, {
      pid: process.pid,
      liveRequestIds: new Set(),
    });

    expect(result.orphaned).toEqual([]);
  });
});
