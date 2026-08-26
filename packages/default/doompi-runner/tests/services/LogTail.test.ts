import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LogTail } from '../../src/adapters/LogTail/LogTail.ts';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function freshLog(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-runner-tail-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, 'run.log');
  fs.writeFileSync(logPath, contents);
  return logPath;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('LogTail', () => {
  it('emits only complete lines appended after the offset it was given', async () => {
    const logPath = freshLog('already read\n');
    const seen: string[] = [];
    const tail = new LogTail();
    const handle = tail.follow(logPath, {
      from: fs.statSync(logPath).size,
      onLines: (lines) => seen.push(...lines),
      onError: () => undefined,
    });
    cleanups.push(() => handle.close());

    fs.appendFileSync(logPath, 'one\ntwo\n');
    await waitFor(() => seen.length >= 2, 'two appended lines');
    expect(seen).toEqual(['one', 'two']);
  }, 15_000);

  it('holds a partial line back until its newline arrives', async () => {
    const logPath = freshLog('');
    const seen: string[] = [];
    const handle = new LogTail().follow(logPath, {
      from: 0,
      onLines: (lines) => seen.push(...lines),
      onError: () => undefined,
    });
    cleanups.push(() => handle.close());

    fs.appendFileSync(logPath, 'half a li');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(seen).toEqual([]);

    fs.appendFileSync(logPath, 'ne\n');
    await waitFor(() => seen.length >= 1, 'the completed line');
    expect(seen).toEqual(['half a line']);
  }, 15_000);

  it('starts over when the file is truncated rather than reading from a stale offset', async () => {
    const logPath = freshLog('');
    const seen: string[] = [];
    const handle = new LogTail().follow(logPath, {
      from: 0,
      onLines: (lines) => seen.push(...lines),
      onError: () => undefined,
    });
    cleanups.push(() => handle.close());

    // Wait for the first delivery before truncating: a poll that has not yet
    // taken its first stat would adopt the truncated file as its baseline and
    // see no change at all, which is the watcher's behaviour, not the tail's.
    fs.appendFileSync(logPath, 'old and rather long content\n');
    await waitFor(() => seen.length >= 1, 'the line before truncation');

    fs.writeFileSync(logPath, 'fresh\n');
    await waitFor(() => seen.length >= 2, 'the line written after truncation');
    // The stale offset pointed past 'fresh\n', so reading from it would have
    // returned nothing at all rather than the new content.
    expect(seen).toEqual(['old and rather long content', 'fresh']);
  }, 15_000);

  it('stops delivering once closed', async () => {
    const logPath = freshLog('');
    const seen: string[] = [];
    const handle = new LogTail().follow(logPath, {
      from: 0,
      onLines: (lines) => seen.push(...lines),
      onError: () => undefined,
    });

    fs.appendFileSync(logPath, 'before\n');
    await waitFor(() => seen.length >= 1, 'the line before closing');
    handle.close();
    fs.appendFileSync(logPath, 'after\n');
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(seen).toEqual(['before']);
  }, 15_000);
});
