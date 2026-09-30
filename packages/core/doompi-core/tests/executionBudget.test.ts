import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExecutionBudget, createServerExecutionBudget } from '../src/services/executionBudget';

let directory: string;
const budgets: Array<ReturnType<typeof createExecutionBudget>> = [];
function budget(limit = 2): ReturnType<typeof createExecutionBudget> {
  const instance = createExecutionBudget(limit, path.join(directory, 'budget.db'));
  budgets.push(instance);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  directory = mkdtempSync(path.join(os.tmpdir(), 'doom-budget-test-'));
});
afterEach(() => {
  for (const instance of budgets.splice(0)) instance.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('shared execution admission', () => {
  it('keeps 100 logical jobs inside two execution slots', async () => {
    const instance = budget();
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 100 }, async () => {
        const release = await instance.acquire();
        running += 1;
        peak = Math.max(peak, running);
        await delay(1);
        running -= 1;
        release();
        release();
      }),
    );
    expect(peak).toBe(2);
    expect(instance.getSnapshot()).toEqual({ running: 0, queued: 0, limit: 2 });
  });

  it('shares permits between independent budget instances', async () => {
    const first = budget(1);
    const second = budget(1);
    const release = await first.acquire();
    const entered = vi.fn();
    const pending = second.acquire().then((lease) => {
      entered();
      return lease;
    });
    await delay(25);
    expect(entered).not.toHaveBeenCalled();
    release();
    const next = await pending;
    expect(entered).toHaveBeenCalledOnce();
    next();
  });

  it('honors the smaller active limit when hosts have different settings', async () => {
    const first = budget(1);
    const second = budget(4);
    const release = await first.acquire();
    const controller = new AbortController();
    const rejected = expect(second.acquire(controller.signal)).rejects.toThrow('cancelled');
    await delay(10);
    expect(second.getSnapshot().running).toBe(0);
    controller.abort(new Error('cancelled'));
    await rejected;
    release();
  });

  it('does not block the event loop while another connection holds the write lock', async () => {
    const instance = budget(1);
    const initial = await instance.acquire();
    initial();
    const db = new DatabaseSync(path.join(directory, 'budget.db'));
    db.exec('BEGIN IMMEDIATE');
    let advanced = false;
    const pending = instance.acquire();
    await delay(10).then(() => {
      advanced = true;
    });
    expect(advanced).toBe(true);
    expect(instance.getSnapshot().running).toBe(0);
    db.exec('COMMIT');
    db.close();
    (await pending)();
  });

  it('retries a busy release without over-admitting work', async () => {
    const instance = budget(1);
    const release = await instance.acquire();
    const db = new DatabaseSync(path.join(directory, 'budget.db'));
    db.exec('BEGIN IMMEDIATE');
    release();
    expect(instance.getSnapshot().running).toBe(1);
    const pending = instance.acquire();
    db.exec('COMMIT');
    db.close();
    (await pending)();
    expect(instance.getSnapshot().running).toBe(0);
  });

  it('keeps a queued retry alive after a busy release', async () => {
    const source = new URL('../src/services/executionBudget/index.ts', import.meta.url).href;
    const databasePath = path.join(directory, 'retry.db');
    const script = `import {createExecutionBudget} from ${JSON.stringify(source)};
import {DatabaseSync} from 'node:sqlite';
const budget=createExecutionBudget(1,${JSON.stringify(databasePath)});
const release=await budget.acquire();
const lock=new DatabaseSync(${JSON.stringify(databasePath)});
lock.exec('BEGIN IMMEDIATE');
release();
const pending=budget.acquire();
lock.exec('COMMIT'); lock.close();
(await pending)(); budget.close();`;
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    });
    expect(exitCode, stderr).toBe(0);
  });

  it('keeps another independent consumer operational after a server budget closes', async () => {
    const environment = { DOOM_RUNNER_BUDGET_DB: path.join(directory, 'server.db'), DOOM_RUNNER_MAX_HEAVY_JOBS: '1' };
    const first = createServerExecutionBudget(environment);
    const second = createServerExecutionBudget(environment);
    budgets.push(first, second);
    expect(first).not.toBe(second);
    const release = await first.acquire();
    const pending = second.acquire();
    first.close();
    release();
    const next = await pending;
    next();
    expect(second.getSnapshot()).toEqual({ running: 0, queued: 0, limit: 1 });
  });

  it('does not reclaim a dead owner while its attached child is alive', async () => {
    const instance = budget(1);
    const initial = await instance.acquire();
    initial();
    const db = new DatabaseSync(path.join(directory, 'budget.db'));
    // The invalid PID represents an owner that cannot still be running.
    db.prepare('INSERT INTO execution_leases VALUES (?, ?, ?, ?)').run('orphan', -1, process.pid, 1);
    const controller = new AbortController();
    const pending = expect(instance.acquire(controller.signal)).rejects.toThrow('cancelled');
    await delay(10);
    expect(instance.getSnapshot().running).toBe(0);
    controller.abort(new Error('cancelled'));
    await pending;
    db.exec('DELETE FROM execution_leases');
    db.close();
  });

  it('reclaims permits only after both recorded processes are gone', async () => {
    const instance = budget(1);
    const initial = await instance.acquire();
    initial();
    const db = new DatabaseSync(path.join(directory, 'budget.db'));
    db.prepare('INSERT INTO execution_leases VALUES (?, ?, ?, ?)').run('dead', -1, -1, 1);
    const release = await instance.acquire();
    await release.attachProcess?.(process.pid);
    const row = db.prepare('SELECT child_pid FROM execution_leases').get();
    expect(row?.child_pid).toBe(process.pid);
    release();
    expect(db.prepare('SELECT COUNT(*) AS n FROM execution_leases').get()?.n).toBe(0);
    db.close();
  });

  it('cancels queued work and closes without prematurely releasing an active owner', async () => {
    const instance = budget(1);
    const release = await instance.acquire();
    const pending = expect(instance.acquire()).rejects.toThrow('closed');
    instance.close();
    await pending;
    expect(instance.getSnapshot().running).toBe(1);
    await expect(instance.acquire()).rejects.toThrow('closed');
    release();
    expect(instance.getSnapshot().running).toBe(0);
  });

  it('enforces a shared limit across three real Node processes', async () => {
    const source = new URL('../src/services/executionBudget/index.ts', import.meta.url).href;
    const databasePath = path.join(directory, 'processes.db');
    let active = 0;
    let peak = 0;
    const children: ReturnType<typeof spawn>[] = [];
    try {
      await Promise.all(
        Array.from(
          { length: 3 },
          () =>
            new Promise<void>((resolve, reject) => {
              const script = `import {createExecutionBudget} from ${JSON.stringify(source)};
          const b=createExecutionBudget(1,${JSON.stringify(databasePath)});
          const release=await b.acquire();
          await release.attachProcess?.(process.pid);
          process.send('enter');
          await new Promise(r=>setTimeout(r,35));
          process.send('exit');
          release(); b.close(); process.disconnect();`;
              const child = spawn(
                process.execPath,
                ['--experimental-strip-types', '--input-type=module', '-e', script],
                { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
              );
              children.push(child);
              let stderr = '';
              child.stderr?.on('data', (data: Buffer) => {
                stderr += data.toString();
              });
              child.on('message', (message) => {
                active += message === 'enter' ? 1 : -1;
                peak = Math.max(peak, active);
              });
              child.on('error', reject);
              child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
            }),
        ),
      );
      expect(peak).toBe(1);
      expect(active).toBe(0);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
    }
  }, 10_000);
});
