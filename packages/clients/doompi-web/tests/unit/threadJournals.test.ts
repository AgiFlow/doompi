import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createThreadJournals, type ThreadFrameEvent } from '../../src/adapters/threadJournals.ts';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-thread-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const entry = (id: string, text: string): Record<string, unknown> => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: '2026-08-25T00:00:00.000Z',
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const lines = (...entries: Array<Record<string, unknown>>): string =>
  entries.map((value) => `${JSON.stringify(value)}\n`).join('');
const ids = (frames: Array<Record<string, unknown>>): string[] =>
  frames.map((frame) => (frame.entry as { id: string }).id);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(15);
  }
};

describe('threadJournals', () => {
  it('replays the journal on subscribe, streams whole appended lines, and stops when nobody follows', async () => {
    const file = path.join(tempDir(), 'run.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: 'session', id: 'x' })}\n${lines(entry('m1', 'one'), entry('m2', 'two'))}`,
    );
    let resolved = 0;
    const journals = createThreadJournals({
      resolve: () => {
        resolved += 1;
        return file;
      },
      pollMs: 20,
      retainLimit: 2,
    });
    cleanups.push(() => journals.close());
    const seen: ThreadFrameEvent[] = [];
    journals.onFrame((event) => seen.push(event));

    expect(ids(journals.subscribe('s1', 'run-1'))).toEqual(['m1', 'm2']);

    // A torn line waits for its newline rather than being folded half-way.
    fs.appendFileSync(file, JSON.stringify(entry('m3', 'three')));
    await sleep(80);
    expect(seen).toEqual([]);
    fs.appendFileSync(file, '\n');
    await waitFor(() => seen.length === 1, 'the appended entry');
    expect(seen[0]).toMatchObject({ sessionId: 's1', threadId: 'run-1' });
    expect(ids([seen[0]!.frame])).toEqual(['m3']);

    // A second follower shares the tail and gets the newest within the limit.
    expect(ids(journals.subscribe('s1', 'run-1'))).toEqual(['m2', 'm3']);
    expect(resolved).toBe(1);

    journals.unsubscribe('s1', 'run-1');
    journals.unsubscribe('s1', 'run-1');
    fs.appendFileSync(file, lines(entry('m4', 'four')));
    await sleep(80);
    expect(seen).toHaveLength(1);

    // A fresh follow reads the file anew.
    expect(ids(journals.subscribe('s1', 'run-1'))).toEqual(['m3', 'm4']);
    expect(resolved).toBe(2);
  });

  it('waits for a journal that is not named or written yet, and starts over when the file shrinks', async () => {
    const dir = tempDir();
    let file: string | undefined;
    const journals = createThreadJournals({ resolve: () => file, pollMs: 20 });
    cleanups.push(() => journals.close());
    const seen: ThreadFrameEvent[] = [];
    journals.onFrame((event) => seen.push(event));

    expect(journals.subscribe('s1', 'late')).toEqual([]);
    file = path.join(dir, 'late.jsonl');
    await sleep(60);
    expect(seen).toEqual([]);
    fs.writeFileSync(file, lines(entry('m1', 'one'), entry('m2', 'two')));
    await waitFor(() => seen.length === 2, 'the late journal');

    fs.writeFileSync(file, lines(entry('n', 'x')));
    await waitFor(() => seen.length === 3, 'the rewritten journal');
    expect(ids(seen.map((event) => event.frame))).toEqual(['m1', 'm2', 'n']);
    expect(ids(journals.subscribe('s1', 'late'))).toEqual(['n']);
  });

  it('cuts a first read of a long journal to its newest whole lines', () => {
    const file = path.join(tempDir(), 'long.jsonl');
    const tail = lines(entry('m4', 'four'), entry('m5', 'five'));
    fs.writeFileSync(file, lines(entry('m1', 'one'), entry('m2', 'two'), entry('m3', 'three')) + tail);
    const journals = createThreadJournals({ resolve: () => file, maxInitialBytes: Buffer.byteLength(tail) + 5 });
    cleanups.push(() => journals.close());
    expect(ids(journals.subscribe('s1', 'long'))).toEqual(['m4', 'm5']);
  });

  it('refuses a path that is not a journal, with one notice', () => {
    const notices: string[] = [];
    const journals = createThreadJournals({
      resolve: () => '/etc/passwd',
      onNotice: (message) => notices.push(message),
    });
    cleanups.push(() => journals.close());
    expect(journals.subscribe('s1', 'bad')).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('/etc/passwd');
  });
});
