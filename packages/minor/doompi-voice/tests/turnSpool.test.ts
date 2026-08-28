import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeTurnSpool } from '../src/adapters/process/turnSpool.ts';

const directories: string[] = [];

function temporaryRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-voice-turn-spool-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('NodeTurnSpool', () => {
  it('returns the exact frozen snapshot without incrementing its revision', () => {
    const spool = NodeTurnSpool.create(temporaryRoot(), {
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
    });
    spool.append(Buffer.from([1, 0, 2, 0]));
    const created = spool.createSnapshot();

    expect(spool.getSnapshot(created.revision)).toEqual(created);
    expect(spool.snapshotManifest().revision).toBe(1);
    expect(() => spool.getSnapshot(2)).toThrow('snapshot revision is invalid');
  });

  it('accepts only the exact latest acknowledgement and makes an identical duplicate idempotent', () => {
    const spool = NodeTurnSpool.create(temporaryRoot(), {
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
    });
    spool.append(Buffer.from([1, 0]));
    spool.createSnapshot();
    spool.createSnapshot();

    expect(() => spool.acknowledge(1, 'committed')).toThrow('acknowledgement revision is invalid');
    spool.acknowledge(2, 'committed');
    expect(() => spool.acknowledge(2, 'committed')).not.toThrow();
    expect(() => spool.acknowledge(2, 'discarded')).toThrow('conflicts with the durable outcome');
    expect(spool.snapshotManifest()).toMatchObject({ acknowledgedRevision: 2, acknowledgedOutcome: 'committed' });
  });
});
