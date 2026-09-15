import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchForFile } from '../../src/services/runnerSupervisor';

/** A sidecar directory of its own per case, so the pooled watcher never crosses tests. */
function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-supervisor-watch-'));
}

/** Writes a marker the way the log sink does: a temporary name, renamed into place. */
function writeMarker(target: string): void {
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, '');
  fs.renameSync(temporary, target);
}

/** A watcher that accepts every listener and reports nothing. */
function silentWatcher(close: () => void = vi.fn()): fs.FSWatcher {
  return { close, on: vi.fn(), unref: vi.fn() } as unknown as fs.FSWatcher;
}

describe('watchForFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a sidecar that already landed before the watch opened', async () => {
    const target = path.join(temporaryDirectory(), 'run-a.exit.json');
    fs.writeFileSync(target, '{}');

    const watch = watchForFile(target);
    try {
      await expect(watch.appeared(50)).resolves.toBe(true);
    } finally {
      watch.close();
    }
  });

  it('reports a sidecar that lands while a slice is waiting', async () => {
    const target = path.join(temporaryDirectory(), 'run-a.exit.json');

    const watch = watchForFile(target);
    try {
      setTimeout(() => {
        writeMarker(target);
      }, 10);
      await expect(watch.appeared(2_000)).resolves.toBe(true);
    } finally {
      watch.close();
    }
  });

  it('still reports a sidecar the watcher never announced', async () => {
    const target = path.join(temporaryDirectory(), 'run-a.log.done');
    // A watcher that reports nothing stands in for a coalesced event, a rename
    // seen only under its temporary name, and a platform that cannot watch at
    // all. Every slice has to end on the filesystem, not on the event, or a
    // missed create is never noticed again.
    vi.spyOn(fs, 'watch').mockReturnValue(silentWatcher());

    const watch = watchForFile(target);
    try {
      await expect(watch.appeared(10)).resolves.toBe(false);
      writeMarker(target);
      await expect(watch.appeared(10)).resolves.toBe(true);
    } finally {
      watch.close();
    }
  });

  it('reports nothing while the sidecar is still missing', async () => {
    const watch = watchForFile(path.join(temporaryDirectory(), 'run-a.exit.json'));
    try {
      await expect(watch.appeared(10)).resolves.toBe(false);
    } finally {
      watch.close();
    }
  });

  it('keeps one watcher for every waiter in the same directory', () => {
    const directory = temporaryDirectory();
    const close = vi.fn();
    const watcher = vi.spyOn(fs, 'watch').mockReturnValue(silentWatcher(close));

    const first = watchForFile(path.join(directory, 'run-a.exit.json'));
    const second = watchForFile(path.join(directory, 'run-b.exit.json'));
    expect(watcher).toHaveBeenCalledTimes(1);

    first.close();
    expect(close).not.toHaveBeenCalled();

    second.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('survives a directory it cannot watch', async () => {
    const target = path.join(temporaryDirectory(), 'run-a.exit.json');
    vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw new Error('too many open files');
    });

    const watch = watchForFile(target);
    try {
      await expect(watch.appeared(10)).resolves.toBe(false);
      fs.writeFileSync(target, '{}');
      await expect(watch.appeared(10)).resolves.toBe(true);
    } finally {
      watch.close();
    }
  });
});
