import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSuspendedRun,
  formatSuspendedRuns,
  formatSuspendedRunsAsync,
  isSuspendedRunResumable,
  isSuspendedRunResumableAsync,
  listSuspendedRuns,
  listSuspendedRunsAsync,
  suspendRun,
  suspendRunAsync,
  type SuspendedRun,
} from '../../src/adapters/suspendedRuns.ts';
import { createSessionScope, scopeSuspendedDir, sessionScopeDir } from '../../src/adapters/filesystem/paths.ts';

const scopes: ReturnType<typeof createSessionScope>[] = [];
afterEach(() => {
  for (const scope of scopes.splice(0)) fs.rmSync(sessionScopeDir(scope), { recursive: true, force: true });
});

function fixture() {
  const scope = createSessionScope(`suspended-${randomUUID()}`);
  scopes.push(scope);
  return scope;
}

function run(id: string, sessionFile?: string): Omit<SuspendedRun, 'version'> {
  return {
    runId: id,
    agent: 'writer',
    runtime: 'pi',
    task: 'draft a report\nwith details',
    cwd: '/repo',
    sessionFile,
    suspendedAt: id === 'older' ? 1 : 2,
    reason: 'reload',
  };
}

describe('suspended run records', () => {
  it('persists and sorts sync and async records, then clears a restored run', async () => {
    const scope = fixture();
    const sessionFile = path.join(scopeSuspendedDir(scope), 'transcript.jsonl');
    fs.mkdirSync(scopeSuspendedDir(scope), { recursive: true });
    fs.writeFileSync(sessionFile, 'history');
    await suspendRunAsync(scope, run('newer', sessionFile));
    suspendRun(scope, run('older'));
    expect(listSuspendedRuns(scope).map((item) => item.runId)).toEqual(['older', 'newer']);
    expect((await listSuspendedRunsAsync(scope)).map((item) => item.runId)).toEqual(['older', 'newer']);
    expect(isSuspendedRunResumable(listSuspendedRuns(scope)[1]!)).toBe(true);
    expect(await isSuspendedRunResumableAsync(listSuspendedRuns(scope)[1]!)).toBe(true);
    expect(formatSuspendedRuns(listSuspendedRuns(scope))).toContain('2 suspended subagents');
    expect(await formatSuspendedRunsAsync(listSuspendedRuns(scope))).toContain('newer (writer, pi, resumable)');
    clearSuspendedRun(scope, 'newer');
    expect(listSuspendedRuns(scope).map((item) => item.runId)).toEqual(['older']);
  });

  it('skips invalid records and refuses to resume missing or incomplete transcripts', async () => {
    const scope = fixture();
    expect(listSuspendedRuns(scope)).toEqual([]);
    expect(await listSuspendedRunsAsync(scope)).toEqual([]);
    expect(formatSuspendedRuns([])).toBe('');
    expect(await formatSuspendedRunsAsync([])).toBe('');
    fs.mkdirSync(scopeSuspendedDir(scope), { recursive: true });
    fs.writeFileSync(path.join(scopeSuspendedDir(scope), 'bad.json'), 'not json');
    fs.writeFileSync(path.join(scopeSuspendedDir(scope), 'wrong.json'), JSON.stringify({ version: 9, runId: 'wrong' }));
    fs.writeFileSync(path.join(scopeSuspendedDir(scope), 'ignored.txt'), 'text');
    suspendRun(scope, run('incomplete'));
    expect(listSuspendedRuns(scope).map((item) => item.runId)).toEqual(['incomplete']);
    expect((await listSuspendedRunsAsync(scope)).map((item) => item.runId)).toEqual(['incomplete']);
    const incomplete = listSuspendedRuns(scope)[0]!;
    expect(isSuspendedRunResumable(incomplete)).toBe(false);
    expect(await isSuspendedRunResumableAsync(incomplete)).toBe(false);
    expect(isSuspendedRunResumable({ ...incomplete, sessionFile: '/missing/transcript.jsonl' })).toBe(false);
    expect(await isSuspendedRunResumableAsync({ ...incomplete, sessionFile: '/missing/transcript.jsonl' })).toBe(false);
    expect(formatSuspendedRuns([incomplete])).toContain('1 suspended subagent');
    expect(await formatSuspendedRunsAsync([incomplete])).toContain('not resumable');
    clearSuspendedRun(scope, 'missing');
  });
});
