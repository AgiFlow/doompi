import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileEditPaths } from '../../../src/adapters/FileEditPaths/FileEditPaths.ts';

let agentDirectory: string;
let repository: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.PI_CODING_AGENT_DIR;
  agentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-file-edit-agent-'));
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  repository = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-file-edit-repo-'));
  execFileSync('git', ['init', '--quiet'], { cwd: repository, stdio: 'ignore' });
});

afterEach(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  fs.rmSync(agentDirectory, { recursive: true, force: true });
  fs.rmSync(repository, { recursive: true, force: true });
});

describe('FileEditPaths', () => {
  it('keeps session state out of the working tree, repository or not', () => {
    const paths = new FileEditPaths();
    const inside = paths.timelinePath(repository, 'session-a');
    // The snapshots are verbatim copies of files the session touched, so the
    // one place they must never land is git's own storage.
    expect(inside.startsWith(agentDirectory)).toBe(true);
    expect(inside).not.toContain(`${path.sep}.git${path.sep}`);
    expect(fs.existsSync(path.join(repository, '.git', 'doom-file-edit'))).toBe(false);
  });

  it('honours the configured agent directory', () => {
    const paths = new FileEditPaths();
    expect(paths.stateDirectory()).toBe(path.join(agentDirectory, 'doom-file-edit'));
    expect(paths.timelinePath(repository, 'session-a').startsWith(paths.stateDirectory())).toBe(true);
  });

  it('names a different file per working directory and per session', () => {
    const paths = new FileEditPaths();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-file-edit-other-'));
    try {
      expect(paths.timelinePath(repository, 'session-a')).not.toBe(paths.timelinePath(repository, 'session-b'));
      expect(paths.timelinePath(repository, 'session-a')).not.toBe(paths.timelinePath(other, 'session-a'));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('puts snapshots beside the timeline they belong to', () => {
    const paths = new FileEditPaths();
    const timelinePath = paths.timelinePath(repository, 'session-a');
    expect(paths.snapshotsPath(repository, 'session-a')).toBe(timelinePath.replace(/\.jsonl$/u, '.blobs'));
  });

  it('still points at where an older build kept its state, so it can be cleared', () => {
    const paths = new FileEditPaths();
    const legacy = paths.legacyStateDirectory(repository);
    expect(legacy).toBe(path.join(fs.realpathSync(repository), '.git', 'doom-file-edit'));
    // Outside a repository there was never an old location to clear.
    expect(paths.legacyStateDirectory(agentDirectory)).toBeUndefined();
  });
});
