import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AsyncJobTracker } from '../../src/adapters/asyncJobTracker';

/**
 * Exercises the base (real `node:fs`) `readFile` seam directly, against an
 * isolated `mkdtemp` directory of its own rather than the real, shared
 * `currentRunsDir()`: `readFile` takes its target path as an explicit argument, so
 * this is safe to do without touching anything another test file might be
 * reading or writing concurrently.
 */
class RealFsAsyncJobTracker extends AsyncJobTracker {
  publicReadFile(filePath: string): string | undefined {
    return this.readFile(filePath);
  }
}

class FakeScheduler {
  register(): () => void {
    return () => {};
  }
  wake(): void {}
  start(): void {}
  stop(): void {}
}

describe('AsyncJobTracker.readFile against a real filesystem', () => {
  let tempDir: string;
  let tracker: RealFsAsyncJobTracker;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-async-job-tracker-'));
    tracker = new RealFsAsyncJobTracker(
      new FakeScheduler() as unknown as ConstructorParameters<typeof AsyncJobTracker>[0],
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns a real file's contents", () => {
    const filePath = path.join(tempDir, 'status.json');
    fs.writeFileSync(filePath, JSON.stringify({ state: 'running' }));

    expect(tracker.publicReadFile(filePath)).toBe(JSON.stringify({ state: 'running' }));
  });

  it('returns undefined rather than throwing when the file does not exist', () => {
    expect(tracker.publicReadFile(path.join(tempDir, 'missing.json'))).toBeUndefined();
  });

  it('lets a non-ENOENT failure propagate, rather than mistaking it for "not started yet"', () => {
    // Reading a directory as a file reliably provokes a real, non-ENOENT
    // error (EISDIR) without touching permissions.
    expect(() => tracker.publicReadFile(tempDir)).toThrow();
  });
});
