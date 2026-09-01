import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunnerWatcherFs, runnerStateDirFor, watchRunnerRuns } from '../src/adapters/webRunnerWatcher.ts';
import type { RunnerRecord } from '../src/types/runnerRegistry';

const SESSION_ID = 's1';
/** Long enough for the one-second poll to have run at least twice. */
const TWO_TICKS_MS = 2400;

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function freshStore(): string {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-runner-watch-'));
  cleanups.push(() => fs.rmSync(store, { recursive: true, force: true }));
  return store;
}

function writeRecord(store: string, overrides: Partial<RunnerRecord>): void {
  const directory = runnerStateDirFor(store, SESSION_ID);
  fs.mkdirSync(directory, { recursive: true });
  const record: RunnerRecord = {
    id: 'runner-a',
    name: 'api',
    pid: 42,
    command: 'pnpm dev',
    cwd: '/repo',
    logPath: '/tmp/api.log',
    interactive: false,
    sessionId: SESSION_ID,
    startedAt: new Date().toISOString(),
    state: 'running',
    promoted: true,
    backend: 'native',
    hostPid: 7,
    ...overrides,
  };
  fs.writeFileSync(path.join(directory, `${record.id}.json`), JSON.stringify(record));
}

function completedRecords(store: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    writeRecord(store, {
      id: `done-${index}`,
      state: 'completed',
      exit: { reason: 'completed', code: 0, signal: null, finishedAt: new Date().toISOString() },
    });
  }
}

interface CountingFs extends RunnerWatcherFs {
  reads: number;
}

function countingFs(): CountingFs {
  const port: CountingFs = {
    reads: 0,
    readdir: (directory) => fs.promises.readdir(directory),
    stat: async (target) => {
      const stats = await fs.promises.stat(target);
      return { mtimeMs: stats.mtimeMs, size: stats.size };
    },
    readFile: async (target) => {
      port.reads += 1;
      return fs.promises.readFile(target, 'utf8');
    },
  };
  return port;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, TWO_TICKS_MS));
}

describe('the runner runs watcher', () => {
  it('reads each metadata file once and does not re-read it while it is unchanged', { timeout: 15_000 }, async () => {
    const store = freshStore();
    completedRecords(store, 8);
    writeRecord(store, {});
    const port = countingFs();

    const source = watchRunnerRuns(SESSION_ID, () => undefined, { storeDir: store, fsPort: port });
    cleanups.push(() => source.close());
    await settle();

    // Nine files, read once each by the first scan; every later tick reused the cache.
    expect(port.reads).toBe(9);

    const afterFirstScan = port.reads;
    writeRecord(store, { id: 'runner-b', name: 'worker' });
    await settle();

    // Only the new file costs a read.
    expect(port.reads).toBe(afterFirstScan + 1);
  });

  it('keeps steady-state tick cost flat as completed runners accumulate', { timeout: 20_000 }, async () => {
    const measure = async (count: number): Promise<number> => {
      const store = freshStore();
      completedRecords(store, count);
      const port = countingFs();
      const source = watchRunnerRuns(SESSION_ID, () => undefined, { storeDir: store, fsPort: port });
      cleanups.push(() => source.close());
      await settle();
      const afterWarmup = port.reads;
      await settle();
      return port.reads - afterWarmup;
    };

    // Five times the history, the same per-tick cost: none.
    expect(await measure(4)).toBe(0);
    expect(await measure(20)).toBe(0);
  });

  it('drops cache entries for records that were swept', { timeout: 15_000 }, async () => {
    const store = freshStore();
    completedRecords(store, 2);
    const port = countingFs();
    const emitted: number[] = [];

    const source = watchRunnerRuns(SESSION_ID, (runs) => emitted.push(runs.length), {
      storeDir: store,
      fsPort: port,
    });
    cleanups.push(() => source.close());
    await settle();
    expect(emitted.at(-1)).toBe(2);

    fs.rmSync(path.join(runnerStateDirFor(store, SESSION_ID), 'done-0.json'));
    await settle();

    expect(emitted.at(-1)).toBe(1);
    // A file that came back would be a genuine change, so it is read again.
    completedRecords(store, 1);
    await settle();
    expect(emitted.at(-1)).toBe(2);
  });
});
