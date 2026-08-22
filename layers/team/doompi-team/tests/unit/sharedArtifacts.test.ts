import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendJsonl,
  cleanupOldArtifacts,
  ensureArtifactsDir,
  formatOutputArtifactContent,
  getArtifactPaths,
  getArtifactsDir,
  getProjectArtifactsDir,
  getProjectChainRunsDir,
  getProjectSubagentsDir,
  writeArtifact,
  writeMetadata,
} from '../../src/adapters/filesystem/artifacts';
import { TEMP_ARTIFACTS_DIR } from '../../src/adapters/filesystem/paths';
import type { ArtifactDirPreference } from '../../src/types';

const temporaryDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-artifacts-'));
  temporaryDirs.push(dir);
  return dir;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Write a file and backdate it so a retention sweep sees it as old. */
function writeAgedFile(filePath: string, ageMs: number): void {
  fs.writeFileSync(filePath, 'x');
  const stamp = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, stamp, stamp);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('project artifact directories', () => {
  it('nests every project directory under one root', () => {
    const root = getProjectSubagentsDir('/repo');
    expect(root).toBe(path.join('/repo', '.doom-team'));
    expect(path.dirname(getProjectArtifactsDir('/repo'))).toBe(root);
    expect(path.dirname(getProjectChainRunsDir('/repo'))).toBe(root);
  });

  it('keeps the root disjoint from the predecessor package', () => {
    // Both packages sweep their own root on a retention timer, so a shared name
    // would let one package delete the other's live artifacts during cutover.
    expect(getProjectSubagentsDir('/repo')).not.toContain('pi-subagents');
  });

  it('keeps artifacts and chain runs apart', () => {
    expect(getProjectArtifactsDir('/repo')).not.toBe(getProjectChainRunsDir('/repo'));
  });
});

describe('getArtifactsDir', () => {
  const sessionFile = path.join('/home', 'u', '.pi', 'sessions', 'abc', 'transcript.jsonl');
  const sessionArtifacts = path.join(path.dirname(sessionFile), 'subagent-artifacts');

  it('places session artifacts beside the transcript and defaults to them', () => {
    expect(getArtifactsDir(sessionFile, '/repo', 'session')).toBe(sessionArtifacts);
    expect(getArtifactsDir(sessionFile, '/repo')).toBe(sessionArtifacts);
  });

  it('falls back to temp when session storage has no session file', () => {
    expect(getArtifactsDir(null, '/repo', 'session')).toBe(TEMP_ARTIFACTS_DIR);
    expect(getArtifactsDir(null, '/repo')).toBe(TEMP_ARTIFACTS_DIR);
  });

  it('ignores both inputs when temp is asked for', () => {
    expect(getArtifactsDir(sessionFile, '/repo', 'temp')).toBe(TEMP_ARTIFACTS_DIR);
  });

  it('uses the project directory when explicitly requested', () => {
    expect(getArtifactsDir(sessionFile, '/repo', 'project')).toBe(getProjectArtifactsDir('/repo'));
  });

  it('degrades from project to the session directory when there is no cwd', () => {
    expect(getArtifactsDir(sessionFile, undefined, 'project')).toBe(sessionArtifacts);
  });

  it('degrades from project to temp when there is neither cwd nor session', () => {
    expect(getArtifactsDir(null, undefined, 'project')).toBe(TEMP_ARTIFACTS_DIR);
  });

  it('rejects an unsupported preference instead of silently picking one', () => {
    // The value reaches here from user config, so an unrecognised setting must be
    // reported rather than resolved to a directory the user did not ask for.
    const unsupported = 'archive' as ArtifactDirPreference;
    expect(() => getArtifactsDir(null, '/repo', unsupported)).toThrow(/Unsupported artifactDir "archive"/);
  });
});

describe('getArtifactPaths', () => {
  it('derives all five paths from the run id and agent name', () => {
    const paths = getArtifactPaths('/artifacts', 'run1', 'reviewer');
    expect(paths).toEqual({
      inputPath: path.join('/artifacts', 'run1_reviewer_input.md'),
      outputPath: path.join('/artifacts', 'run1_reviewer_output.md'),
      jsonlPath: path.join('/artifacts', 'run1_reviewer.jsonl'),
      transcriptPath: path.join('/artifacts', 'run1_reviewer_transcript.jsonl'),
      metadataPath: path.join('/artifacts', 'run1_reviewer_meta.json'),
    });
  });

  it('appends the index only when one is given, including index zero', () => {
    // Index 0 is falsy, so a truthiness check here would silently collapse the
    // first parallel instance onto the un-indexed paths.
    expect(getArtifactPaths('/artifacts', 'run1', 'a', 0).inputPath).toBe(path.join('/artifacts', 'run1_a_0_input.md'));
    expect(getArtifactPaths('/artifacts', 'run1', 'a', 2).inputPath).toBe(path.join('/artifacts', 'run1_a_2_input.md'));
    expect(getArtifactPaths('/artifacts', 'run1', 'a').inputPath).toBe(path.join('/artifacts', 'run1_a_input.md'));
  });

  it('cannot be made to write outside the artifacts directory', () => {
    // The agent name comes from user-authored frontmatter. Without sanitisation
    // these names would resolve to a path above the artifacts directory.
    for (const agent of ['../../etc/passwd', '/etc/passwd', '..', 'a/b', 'a\\b']) {
      const paths = getArtifactPaths('/artifacts', 'run1', agent);
      for (const filePath of Object.values(paths)) {
        expect(path.dirname(filePath)).toBe('/artifacts');
        expect(path.relative('/artifacts', filePath).startsWith('..')).toBe(false);
      }
    }
  });

  it('replaces every unsafe character rather than only the first', () => {
    expect(getArtifactPaths('/artifacts', 'r', 'a/b/c').jsonlPath).toBe(path.join('/artifacts', 'r_a_b_c.jsonl'));
  });

  it('keeps word characters, dots and dashes intact', () => {
    expect(getArtifactPaths('/artifacts', 'r', 'my-agent.v2_1').jsonlPath).toBe(
      path.join('/artifacts', 'r_my-agent.v2_1.jsonl'),
    );
  });

  it('still produces a usable base for an empty agent name', () => {
    expect(getArtifactPaths('/artifacts', 'run1', '').jsonlPath).toBe(path.join('/artifacts', 'run1_.jsonl'));
  });
});

describe('artifact writes', () => {
  it('creates a nested artifacts directory and is idempotent', () => {
    const dir = path.join(makeTempDir(), 'a', 'b');
    ensureArtifactsDir(dir);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(() => ensureArtifactsDir(dir)).not.toThrow();
  });

  it('writes artifact content as utf-8', () => {
    const filePath = path.join(makeTempDir(), 'out.md');
    writeArtifact(filePath, 'hello world');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello world');
  });

  it('writes metadata as parseable json', () => {
    const filePath = path.join(makeTempDir(), 'meta.json');
    writeMetadata(filePath, { runId: 'r1', ok: true });
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({ runId: 'r1', ok: true });
  });

  it('appends jsonl lines each terminated by a newline', () => {
    const filePath = path.join(makeTempDir(), 'events.jsonl');
    appendJsonl(filePath, '{"a":1}');
    appendJsonl(filePath, '{"b":2}');
    // A missing terminator would merge two records into one unparseable line.
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"a":1}\n{"b":2}\n');
  });
});

describe('formatOutputArtifactContent', () => {
  it('returns real output untouched even when an error was also recorded', () => {
    expect(formatOutputArtifactContent({ output: 'result', error: 'boom' })).toBe('result');
  });

  it('returns empty output as-is when there is no error to explain it', () => {
    expect(formatOutputArtifactContent({ output: '' })).toBe('');
    expect(formatOutputArtifactContent({ output: '   ' })).toBe('   ');
  });

  it('replaces whitespace-only output with the error', () => {
    // An empty artifact tells the reader nothing about why the run produced nothing.
    const content = formatOutputArtifactContent({ output: '  \n ', error: 'spawn failed' });
    expect(content).toContain('Subagent run failed before producing output.');
    expect(content).toContain('spawn failed');
  });

  it('links only the evidence paths it was given', () => {
    const withBoth = formatOutputArtifactContent({
      output: '',
      error: 'boom',
      transcriptPath: '/a/t.jsonl',
      metadataPath: '/a/m.json',
    });
    expect(withBoth).toContain('Transcript: /a/t.jsonl');
    expect(withBoth).toContain('Metadata: /a/m.json');

    const withNeither = formatOutputArtifactContent({ output: '', error: 'boom' });
    expect(withNeither).not.toContain('Transcript:');
    expect(withNeither).not.toContain('Metadata:');

    const metadataOnly = formatOutputArtifactContent({ output: '', error: 'boom', metadataPath: '/a/m.json' });
    expect(metadataOnly).not.toContain('Transcript:');
    expect(metadataOnly).toContain('Metadata: /a/m.json');
  });
});

describe('cleanupOldArtifacts', () => {
  it('does nothing for a directory that does not exist', () => {
    const missing = path.join(makeTempDir(), 'nope');
    expect(() => cleanupOldArtifacts(missing, 1)).not.toThrow();
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('removes only entries older than the retention window', () => {
    const dir = makeTempDir();
    writeAgedFile(path.join(dir, 'old.md'), 3 * DAY_MS);
    writeAgedFile(path.join(dir, 'fresh.md'), 0);

    cleanupOldArtifacts(dir, 1);

    expect(fs.existsSync(path.join(dir, 'old.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'fresh.md'))).toBe(true);
  });

  it('records a marker so a second sweep inside the interval is skipped', () => {
    const dir = makeTempDir();
    cleanupOldArtifacts(dir, 1);
    expect(fs.existsSync(path.join(dir, '.last-cleanup'))).toBe(true);

    // Several extension hosts start against the same directory; without the marker
    // each one would re-scan the whole tree on every startup.
    writeAgedFile(path.join(dir, 'old.md'), 3 * DAY_MS);
    cleanupOldArtifacts(dir, 1);
    expect(fs.existsSync(path.join(dir, 'old.md'))).toBe(true);
  });

  it('sweeps again once the marker itself is older than the interval', () => {
    const dir = makeTempDir();
    const marker = path.join(dir, '.last-cleanup');
    writeAgedFile(marker, 2 * DAY_MS);
    writeAgedFile(path.join(dir, 'old.md'), 3 * DAY_MS);

    cleanupOldArtifacts(dir, 1);

    expect(fs.existsSync(path.join(dir, 'old.md'))).toBe(false);
  });

  it('never deletes its own marker, which would disable the rate limit', () => {
    const dir = makeTempDir();
    const marker = path.join(dir, '.last-cleanup');
    writeAgedFile(marker, 30 * DAY_MS);

    cleanupOldArtifacts(dir, 1);

    expect(fs.existsSync(marker)).toBe(true);
  });

  it('skips an entry it cannot stat and still sweeps the rest', () => {
    const dir = makeTempDir();
    // A dangling symlink makes statSync throw. Aborting here would leave every
    // later artifact in the directory unswept forever.
    fs.symlinkSync(path.join(dir, 'gone'), path.join(dir, 'dangling'));
    writeAgedFile(path.join(dir, 'old.md'), 3 * DAY_MS);

    cleanupOldArtifacts(dir, 1);

    expect(fs.existsSync(path.join(dir, 'old.md'))).toBe(false);
    expect(fs.lstatSync(path.join(dir, 'dangling')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(dir, '.last-cleanup'))).toBe(true);
  });

  it('treats a zero-day retention as expiring everything already written', () => {
    const dir = makeTempDir();
    writeAgedFile(path.join(dir, 'a.md'), 60_000);

    cleanupOldArtifacts(dir, 0);

    expect(fs.existsSync(path.join(dir, 'a.md'))).toBe(false);
  });
});
