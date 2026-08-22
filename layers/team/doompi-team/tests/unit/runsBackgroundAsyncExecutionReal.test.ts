import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AsyncSubagentSpawner } from '../../src/adapters/runs/background/asyncExecution';
import { CoalescedStatusWriter } from '../../src/adapters/runs/background/statusWriter';
import { SpawnHandshake } from '../../src/adapters/runs/background/spawnHandshake';
import type { AsyncJobTrackerContract, TrackedAsyncJob } from '../../src/adapters/asyncJobTracker';
import type {
  TerminalPersistenceContract,
  TerminalTrigger,
} from '../../src/adapters/runs/background/terminalPersistence';
import type { StatusWithRecentEntries } from '../../src/adapters/runs/background/statusWriter';

class NoopAsyncJobTracker implements AsyncJobTrackerContract {
  forSession() {
    return this;
  }
  track(): void {}
  untrack(): void {}
  list(): TrackedAsyncJob[] {
    return [];
  }
  get(): TrackedAsyncJob | undefined {
    return undefined;
  }
  reset(): void {}
  start(): void {}
  stop(): void {}
}

class NoopTerminalPersistenceService implements TerminalPersistenceContract {
  begin(
    _runId: string,
    _mutate: (status: StatusWithRecentEntries, trigger: TerminalTrigger | undefined) => void,
  ): void {}
  trackChild(): void {}
  untrackChild(): void {}
  finalize(): void {}
  dispose(): void {}
}

/** Exposes the base (real) seam implementations directly, without overriding them. */
class RealAsyncSubagentSpawner extends AsyncSubagentSpawner {
  publicNow(): number {
    return this.now();
  }
  publicCreateStatusWriter() {
    return this.createStatusWriter();
  }
  publicCreateSpawnHandshake() {
    return this.createSpawnHandshake();
  }
  publicRemoveLaunchConfig(filePath: string): void {
    this.removeLaunchConfig(filePath);
  }
  publicSpawnChild(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    return this.spawnChild(command, args, options);
  }
}

function newSpawner(): RealAsyncSubagentSpawner {
  return new RealAsyncSubagentSpawner(new NoopAsyncJobTracker(), new NoopTerminalPersistenceService());
}

describe('AsyncSubagentSpawner base seams', () => {
  it('now() returns a real, current timestamp', () => {
    const spawner = newSpawner();
    const before = Date.now();

    const value = spawner.publicNow();

    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Date.now());
  });

  it('createStatusWriter() returns a real, independent CoalescedStatusWriter each time', () => {
    const spawner = newSpawner();

    const first = spawner.publicCreateStatusWriter();
    const second = spawner.publicCreateStatusWriter();

    expect(first).toBeInstanceOf(CoalescedStatusWriter);
    expect(first).not.toBe(second);
  });

  it('createSpawnHandshake() returns a real, independent SpawnHandshake each time', () => {
    const spawner = newSpawner();

    const first = spawner.publicCreateSpawnHandshake();
    const second = spawner.publicCreateSpawnHandshake();

    expect(first).toBeInstanceOf(SpawnHandshake);
    expect(first).not.toBe(second);
  });
});

describe('AsyncSubagentSpawner.removeLaunchConfig against a real filesystem', () => {
  let tempDir: string;

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('removes a real file', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-async-execution-remove-'));
    const filePath = path.join(tempDir, 'launch-config.json');
    fs.writeFileSync(filePath, '{}');
    const spawner = newSpawner();

    spawner.publicRemoveLaunchConfig(filePath);

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('is a no-op, not a throw, when the file does not exist', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-async-execution-remove-'));
    const spawner = newSpawner();

    expect(() => spawner.publicRemoveLaunchConfig(path.join(tempDir, 'never-existed.json'))).not.toThrow();
  });

  it('propagates a real removal failure', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-async-execution-remove-'));
    // A non-empty directory passed without `recursive: true` reliably makes a
    // real `fs.rmSync` throw; `force: true` alone does not suppress it.
    const nonEmptyDir = path.join(tempDir, 'not-empty');
    fs.mkdirSync(nonEmptyDir);
    fs.writeFileSync(path.join(nonEmptyDir, 'child.txt'), 'x');
    const spawner = newSpawner();

    expect(() => spawner.publicRemoveLaunchConfig(nonEmptyDir)).toThrow();
    expect(fs.existsSync(nonEmptyDir)).toBe(true);
  });
});

describe('AsyncSubagentSpawner.spawnChild against a real child process', () => {
  it('spawns a real, detached, unref-ed process and returns its pid', async () => {
    const spawner = newSpawner();

    const { pid, onError } = spawner.publicSpawnChild(process.execPath, ['-e', '""'], {
      cwd: os.tmpdir(),
      env: process.env as NodeJS.ProcessEnv,
    });

    expect(typeof pid).toBe('number');
    expect(() => onError(() => {})).not.toThrow();

    // Let the trivial child actually exit rather than leaving it dangling for the test run.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it('reports a spawn failure through onError for a command that cannot be executed', async () => {
    const spawner = newSpawner();
    const errors: Error[] = [];

    const { onError } = spawner.publicSpawnChild('definitely-not-a-real-command-xyz', [], {
      cwd: os.tmpdir(),
      env: process.env as NodeJS.ProcessEnv,
    });
    onError((error) => errors.push(error));

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(errors.length).toBeGreaterThan(0);
  });
});
