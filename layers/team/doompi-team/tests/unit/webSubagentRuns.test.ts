import { describe, expect, it } from 'vitest';
import { teamRunsDirFor } from '../../src/adapters/webSubagentWatcher.ts';
import { journalPathOf, parseSubagentRun, presentRuns, RUN_ID_PATTERN } from '../../src/services/webSubagentRuns.ts';
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
