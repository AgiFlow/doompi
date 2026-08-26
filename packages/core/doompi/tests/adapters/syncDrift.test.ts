import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeSyncDrift, readSyncDrift } from '../../src/adapters/syncDrift.ts';

let home: string;
let repoRoot: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-drift-home-'));
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-drift-repo-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

function stageArtifacts(): void {
  fs.mkdirSync(path.join(home, '.doompi', 'web', 'current'), { recursive: true });
  fs.mkdirSync(path.join(home, '.doompi', 'api', 'current'), { recursive: true });
}

describe('sync drift', () => {
  it('reports a repository that was never synced', () => {
    const drift = readSyncDrift({ repoRoot, homeDirectory: home });

    expect(drift).toMatchObject({ fresh: false, reasons: ['never-synced'] });
    expect(describeSyncDrift(drift)).toContain('never been synced');
  });

  it('reads a launch as needing a sync rather than throwing on unusable state', () => {
    // A half-written state file is a reason to sync, not a reason to fail.
    const drift = readSyncDrift({ repoRoot: path.join(repoRoot, 'missing'), homeDirectory: home });

    expect(drift.fresh).toBe(false);
  });

  it('describes a synced repository as needing nothing', () => {
    expect(describeSyncDrift({ fresh: true, reasons: [] })).toBe('the repository is synced');
  });

  it('names every artifact a session would have read', () => {
    const description = describeSyncDrift({
      fresh: false,
      reasons: ['cockpit-bundle-missing', 'package-apis-missing'],
    });

    expect(description).toContain('cockpit bundle is missing');
    expect(description).toContain('package API routes are missing');
  });

  it('treats staged artifacts as present', () => {
    stageArtifacts();

    const drift = readSyncDrift({ repoRoot, homeDirectory: home });

    // Still unsynced overall, but not for the artifacts that now exist.
    expect(drift.reasons).not.toContain('cockpit-bundle-missing');
    expect(drift.reasons).not.toContain('package-apis-missing');
  });
});
