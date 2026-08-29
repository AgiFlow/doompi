import { describe, expect, it } from 'vitest';
import { teamRunsDirFor } from '../../src/adapters/webSubagentWatcher.ts';
import {
  activeRunIdsFromRegistry,
  journalPathOf,
  parseSubagentRun,
  presentRuns,
  reconcileRunLifecycles,
  RUN_ID_PATTERN,
} from '../../src/services/webSubagentRuns.ts';
import type { SubagentRun } from '../../src/types/webSubagents.ts';

describe('subagentRuns', () => {
  it('derives the doom-team runs directory, pinned to an observed real-world vector', () => {
    // sha256('92d2be6a-ffb1-49e8-9a6d-cb378dcfdf93').slice(0, 16) is the scope
    // key a real doom-team run used on disk; this keeps the mirrored
    // derivation honest against layers/team/doompi-team paths.ts.
    expect(teamRunsDirFor({ sessionId: '92d2be6a-ffb1-49e8-9a6d-cb378dcfdf93', tmpdir: '/tmp', uid: 501 })).toBe(
      '/tmp/doom-team-uid-501/sessions/ca13a07262331ed8/runs',
    );
    expect(teamRunsDirFor({ sessionId: 'x', tmpdir: '/tmp', uid: undefined })).toBeUndefined();
  });

  it('parses a completed status file the way doom-team writes it', () => {
    const run = parseSubagentRun(
      JSON.stringify({
        version: 1,
        runId: 'run-1',
        agent: 'package-dev',
        task: 'Count the markdown files.',
        cwd: '/workspace/agirepo',
        model: 'openai-codex/gpt-5.6-luna',
        state: 'completed',
        startedAt: 1000,
        lastUpdate: 2000,
        endedAt: 2000,
        currentTool: 'working: reporting',
        tokens: 85_380,
        toolCount: 4,
        summary: 'Total: 1,652.',
      }),
    );
    expect(run).toMatchObject({
      runId: 'run-1',
      agent: 'package-dev',
      state: 'done',
      rawState: 'completed',
      model: 'openai-codex/gpt-5.6-luna',
      endedAt: 2000,
      tokens: 85_380,
      toolCount: 4,
      summary: 'Total: 1,652.',
      tail: [],
    });
  });

  it('maps every doom-team state and keeps text-shaped recent output', () => {
    const base = { runId: 'r', agent: 'a', startedAt: 1, task: 't', cwd: '/w' };
    expect(parseSubagentRun(JSON.stringify({ ...base, state: 'queued' }))?.state).toBe('queued');
    expect(parseSubagentRun(JSON.stringify({ ...base, state: 'running' }))?.state).toBe('running');
    expect(parseSubagentRun(JSON.stringify({ ...base, state: 'complete' }))?.state).toBe('done');
    expect(parseSubagentRun(JSON.stringify({ ...base, state: 'paused' }))?.state).toBe('stopped');
    expect(parseSubagentRun(JSON.stringify({ ...base, state: 'cancelled' }))?.state).toBe('stopped');
    expect(parseSubagentRun(JSON.stringify({ ...base, state: 'sideways' }))).toBeUndefined();

    const withOutput = parseSubagentRun(
      JSON.stringify({
        ...base,
        state: 'running',
        recentOutput: ['plain line', { text: 'text field' }, { line: 'line field' }, 42, { other: true }],
      }),
    );
    expect(withOutput?.tail).toEqual(['plain line', 'text field', 'line field']);
  });

  it('rejects malformed or internal runs', () => {
    expect(parseSubagentRun('not json')).toBeUndefined();
    expect(parseSubagentRun(JSON.stringify({ runId: 'r', state: 'running' }))).toBeUndefined();
    expect(
      parseSubagentRun(JSON.stringify({ runId: 'r', agent: 'a', state: 'running', startedAt: 1, internal: true })),
    ).toBeUndefined();
  });

  it('presents active runs first and retires old finished ones', () => {
    const run = (overrides: Partial<SubagentRun>): SubagentRun => ({
      runId: 'r',
      agent: 'a',
      state: 'running',
      rawState: 'running',
      task: '',
      cwd: '/w',
      startedAt: 0,
      lastUpdate: 0,
      tail: [],
      ...overrides,
    });
    const now = 1_000_000_000;
    const presented = presentRuns(
      [
        run({ runId: 'old-done', state: 'done', endedAt: now - 11 * 60 * 1000 }),
        run({ runId: 'fresh-done', state: 'done', endedAt: now - 60 * 1000 }),
        run({ runId: 'young-run', state: 'running', startedAt: now - 1000 }),
        run({ runId: 'older-run', state: 'running', startedAt: now - 5000 }),
      ],
      now,
    );
    expect(presented.map((entry) => entry.runId)).toEqual(['young-run', 'older-run', 'fresh-done']);
  });

  it('reconciles stale and orphaned snapshots from the live process registry without an age cutoff', () => {
    const base: SubagentRun = {
      runId: 'stale',
      agent: 'a',
      state: 'running',
      rawState: 'running',
      task: '',
      cwd: '/w',
      startedAt: 1,
      lastUpdate: 2,
      tail: [],
    };
    const registry = JSON.stringify({
      version: 1,
      runs: [
        { runId: 'live-long-run', pid: 101 },
        { runId: 'orphan', pid: 202 },
        { runId: 'restored', pid: 303 },
      ],
    });
    const active = activeRunIdsFromRegistry(registry, (pid) => pid !== 202);
    const reconciled = reconcileRunLifecycles(
      [
        base,
        { ...base, runId: 'live-long-run', startedAt: -1_000_000_000 },
        { ...base, runId: 'orphan' },
        { ...base, runId: 'restored' },
        { ...base, runId: 'finished', state: 'done' },
      ],
      active,
    );

    expect(reconciled.map(({ runId, state }) => [runId, state])).toEqual([
      ['stale', 'stopped'],
      ['live-long-run', 'running'],
      ['orphan', 'stopped'],
      ['restored', 'running'],
      ['finished', 'done'],
    ]);
    expect(reconciled[0]?.endedAt).toBe(2);
  });

  it('fails open when the lifecycle registry is malformed or unavailable', () => {
    const running: SubagentRun = {
      runId: 'live',
      agent: 'a',
      state: 'running',
      rawState: 'running',
      task: '',
      cwd: '/w',
      startedAt: 1,
      lastUpdate: 2,
      tail: [],
    };
    expect(activeRunIdsFromRegistry('{', () => false)).toBeUndefined();
    expect(
      activeRunIdsFromRegistry(JSON.stringify({ version: 1, runs: [{ runId: 'live' }] }), () => false),
    ).toBeUndefined();
    expect(reconcileRunLifecycles([running], undefined)).toEqual([running]);
  });

  it('names the run journal only when the status carries an absolute .jsonl path', () => {
    expect(journalPathOf({ sessionFile: '/home/me/agent/sessions/a/b.jsonl' })).toBe(
      '/home/me/agent/sessions/a/b.jsonl',
    );
    expect(journalPathOf({ sessionFile: 'relative/b.jsonl' })).toBeUndefined();
    expect(journalPathOf({ sessionFile: '/home/me/notes.md' })).toBeUndefined();
    expect(journalPathOf({ sessionFile: 42 })).toBeUndefined();
    expect(journalPathOf({})).toBeUndefined();
    // A run id is looked up as a path segment, so only plain names pass.
    expect(RUN_ID_PATTERN.test('run-1.b_c')).toBe(true);
    expect(RUN_ID_PATTERN.test('../run')).toBe(false);
  });
});
