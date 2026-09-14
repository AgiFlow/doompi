import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchForFile } from '../../src/services/runnerSupervisor';

let cleanups: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function freshDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-runner-watch-'));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

describe('watchForFile', () => {
  it('reports a file that already exists without waiting for an event', async () => {
    const directory = freshDirectory();
    const target = path.join(directory, 'run.exit.json');
    fs.writeFileSync(target, '{}');

    const watch = watchForFile(target);
    try {
      await expect(watch.appeared(0)).resolves.toBe(true);
    } finally {
      watch.close();
    }
  });

  it('reports a file that lands while the slice is still open', async () => {
    const directory = freshDirectory();
    const target = path.join(directory, 'run.exit.json');

    const watch = watchForFile(target);
    try {
      const pending = watch.appeared(8000);
      setTimeout(() => fs.writeFileSync(target, '{}'), 10);
      await expect(pending).resolves.toBe(true);
    } finally {
      watch.close();
    }
  });

  it('gives the slice back to the caller when the file never lands', async () => {
    const directory = freshDirectory();
    const watch = watchForFile(path.join(directory, 'missing.exit.json'));
    try {
      await expect(watch.appeared(25)).resolves.toBe(false);
    } finally {
      watch.close();
    }
  });

  it('keeps one watcher for a directory shared by parallel runners', async () => {
    const directory = freshDirectory();
    const watch = vi.spyOn(fs, 'watch');

    const first = watchForFile(path.join(directory, 'first.exit.json'));
    const second = watchForFile(path.join(directory, 'second.exit.json'));
    try {
      expect(watch).toHaveBeenCalledTimes(1);
    } finally {
      first.close();
      second.close();
    }
  });

  it('does not resolve a waiter for another runner writing into the same directory', async () => {
    const directory = freshDirectory();
    const mine = watchForFile(path.join(directory, 'mine.exit.json'));
    try {
      const pending = mine.appeared(150);
      fs.writeFileSync(path.join(directory, 'theirs.exit.json'), '{}');
      await expect(pending).resolves.toBe(false);
    } finally {
      mine.close();
    }
  });

  it('closes the shared watcher only once the last waiter releases it', () => {
    const directory = freshDirectory();
    const closed = vi.fn();
    vi.spyOn(fs, 'watch').mockReturnValue({
      close: closed,
      on: () => undefined,
    } as unknown as fs.FSWatcher);

    const first = watchForFile(path.join(directory, 'first.exit.json'));
    const second = watchForFile(path.join(directory, 'second.exit.json'));

    first.close();
    expect(closed).not.toHaveBeenCalled();
    second.close();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('ignores a second release from the same waiter', () => {
    const directory = freshDirectory();
    const closed = vi.fn();
    vi.spyOn(fs, 'watch').mockReturnValue({
      close: closed,
      on: () => undefined,
    } as unknown as fs.FSWatcher);

    const first = watchForFile(path.join(directory, 'first.exit.json'));
    const second = watchForFile(path.join(directory, 'second.exit.json'));

    first.close();
    first.close();
    expect(closed).not.toHaveBeenCalled();
    second.close();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('falls back to timing slices out when the directory cannot be watched', async () => {
    const directory = freshDirectory();
    vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw new Error('watch unavailable');
    });

    const watch = watchForFile(path.join(directory, 'run.exit.json'));
    try {
      await expect(watch.appeared(25)).resolves.toBe(false);
    } finally {
      watch.close();
    }
  });
});
