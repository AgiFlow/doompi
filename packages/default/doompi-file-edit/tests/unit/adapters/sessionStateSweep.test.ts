import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STATE_MAX_AGE_MS, sweepSessionState } from '../../../src/adapters/node/sessionStateSweep.ts';

let directory: string;

const NOW = 1_800_000_000_000;

/** One session's state, aged by however long ago it last wrote. */
function place(name: string, agedMs: number, options: { blobs?: boolean; lock?: boolean } = {}): string {
  const timelinePath = path.join(directory, `${name}.jsonl`);
  fs.writeFileSync(timelinePath, '{"version":2}\n');
  const when = new Date(NOW - agedMs);
  fs.utimesSync(timelinePath, when, when);
  if (options.blobs !== false) {
    const blobs = path.join(directory, `${name}.blobs`);
    fs.mkdirSync(blobs, { recursive: true });
    fs.writeFileSync(path.join(blobs, 'abc'), 'content');
    fs.utimesSync(blobs, when, when);
  }
  if (options.lock === true) {
    const lockPath = `${timelinePath}.lock`;
    fs.writeFileSync(lockPath, '');
    fs.utimesSync(lockPath, when, when);
  }
  return timelinePath;
}

const exists = (relative: string): boolean => fs.existsSync(path.join(directory, relative));

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-file-edit-sweep-'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('sweepSessionState', () => {
  it('clears the state of a session that never got to clean up after itself', async () => {
    place('dead', STATE_MAX_AGE_MS * 2, { lock: true });
    expect(await sweepSessionState({ directory, now: NOW })).toBe(1);
    expect(exists('dead.jsonl')).toBe(false);
    expect(exists('dead.blobs')).toBe(false);
    // The lock goes too, or the next session with that key waits on a ghost.
    expect(exists('dead.jsonl.lock')).toBe(false);
  });

  it('leaves a session that is still writing alone', async () => {
    place('live', 60_000);
    expect(await sweepSessionState({ directory, now: NOW })).toBe(0);
    expect(exists('live.jsonl')).toBe(true);
    expect(exists('live.blobs')).toBe(true);
  });

  it('never removes the caller’s own state, however old it looks', async () => {
    // A resumed session opens a timeline that has not moved in weeks, and it is
    // the one file the sweep must not touch.
    const keep = place('mine', STATE_MAX_AGE_MS * 3);
    expect(await sweepSessionState({ directory, keep, now: NOW })).toBe(0);
    expect(exists('mine.jsonl')).toBe(true);
  });

  it('judges age by the newest of the timeline and its snapshots', async () => {
    place('busy', STATE_MAX_AGE_MS * 2);
    // Snapshots written just now: the session is alive even if the timeline
    // line it is about to append has not landed yet.
    const blobs = path.join(directory, 'busy.blobs');
    const recent = new Date(NOW - 1_000);
    fs.utimesSync(blobs, recent, recent);
    expect(await sweepSessionState({ directory, now: NOW })).toBe(0);
    expect(exists('busy.jsonl')).toBe(true);
  });

  it('clears a blob tree whose timeline is already gone', async () => {
    place('halfway', STATE_MAX_AGE_MS * 2);
    fs.rmSync(path.join(directory, 'halfway.jsonl'));
    // Exactly what a cleanup interrupted midway leaves, and what nothing else
    // will ever name again.
    await sweepSessionState({ directory, now: NOW });
    expect(exists('halfway.blobs')).toBe(false);
  });

  it('keeps a recent orphan, which may belong to a session still starting up', async () => {
    place('starting', 1_000);
    fs.rmSync(path.join(directory, 'starting.jsonl'));
    await sweepSessionState({ directory, now: NOW });
    expect(exists('starting.blobs')).toBe(true);
  });

  it('removes the directory itself only once nothing is left in it', async () => {
    place('old', STATE_MAX_AGE_MS * 2);
    place('new', 1_000);
    await sweepSessionState({ directory, removeDirectory: true, now: NOW });
    expect(fs.existsSync(directory)).toBe(true);

    fs.rmSync(path.join(directory, 'new.jsonl'));
    fs.rmSync(path.join(directory, 'new.blobs'), { recursive: true });
    await sweepSessionState({ directory, removeDirectory: true, now: NOW });
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('says nothing happened for a directory that is not there', async () => {
    expect(await sweepSessionState({ directory: path.join(directory, 'absent'), now: NOW })).toBe(0);
  });
});
