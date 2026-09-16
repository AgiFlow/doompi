import { describe, expect, it } from 'vitest';

import {
  COLLAPSED_RESULT_LINES,
  intercomCallSummary,
  intercomOutcome,
  resultLines,
  shapeResult,
  subagentCallDetail,
  subagentResultView,
} from '../../src/extensions/workspaces/sessions/(frontend)/tool/_lib/toolText';

describe('the subagent card text', () => {
  it('words the call detail per action the way the TUI does', () => {
    expect(subagentCallDetail({ action: 'agents' })).toBe('');
    expect(subagentCallDetail({ action: 'agents', name: 'reviewer' })).toBe('reviewer');
    expect(subagentCallDetail({ action: 'run', requests: [{ agent: 'a', task: 't' }] })).toBe('1 agent · a');
    expect(
      subagentCallDetail({
        action: 'run',
        requests: [
          { agent: 'a', task: 't' },
          { agent: 'b', task: 't' },
        ],
      }),
    ).toBe('2 agents · a, b');
    expect(subagentCallDetail({ action: 'run', requests: 'junk' })).toBe('0 agents');
    expect(subagentCallDetail({ action: 'status' })).toBe('fleet');
    expect(subagentCallDetail({ action: 'status', id: 'run-1' })).toBe('run-1');
    expect(subagentCallDetail({ action: 'steer', id: 'run-2' })).toBe('run-2');
    expect(subagentCallDetail({ action: 'stop', id: 'run-3' })).toBe('run-3');
    expect(subagentCallDetail({ action: 'restore', id: 'run-4' })).toBe('run-4');
    expect(subagentCallDetail({ action: 'suspended' })).toBe('runs');
    expect(subagentCallDetail({ action: 'unknown' })).toBe('');
  });

  it('drops trailing blank lines and treats empty output as no lines', () => {
    expect(resultLines('')).toEqual([]);
    expect(resultLines('a\nb\n\n  \n')).toEqual(['a', 'b']);
  });

  it('shows a tail while running, a collapsed head after, and the closing glyph', () => {
    const many = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
    const running = shapeResult(many, { expanded: false, isPartial: true, isError: false });
    expect(running.glyph).toBe('running');
    expect(running.lines).toHaveLength(COLLAPSED_RESULT_LINES);
    expect(running.lines[0]).toBe('line 9');

    const collapsed = shapeResult(many, { expanded: false, isPartial: false, isError: false });
    expect(collapsed).toMatchObject({ glyph: 'more', hidden: 8 });
    expect(collapsed.lines[0]).toBe('line 1');

    const expanded = shapeResult(many, { expanded: true, isPartial: false, isError: false });
    expect(expanded).toMatchObject({ glyph: 'none', hidden: 0 });
    expect(expanded.lines).toHaveLength(20);

    expect(shapeResult('boom', { expanded: false, isPartial: false, isError: true })).toMatchObject({
      lines: ['boom'],
      glyph: 'failed',
    });
    expect(shapeResult('', { expanded: false, isPartial: false, isError: false })).toMatchObject({ glyph: 'done' });
  });
});

describe('the subagent card result view', () => {
  it('rejects anything that is not a finished subagent result', () => {
    expect(subagentResultView(undefined)).toBeNull();
    expect(subagentResultView('Starting 2 subagents...')).toBeNull();
    expect(subagentResultView([{ runId: 'run-1' }])).toBeNull();
    // A task result, which the card must not try to draw as subagent rows.
    expect(subagentResultView({ action: 'list', tasks: [] })).toBeNull();
    // The partial update the run action streams before the spawn settles.
    expect(subagentResultView({ action: 'run', partial: true })).toBeNull();
  });

  it('lists the discovered agents', () => {
    expect(
      subagentResultView({
        agents: [
          { name: 'reviewer', source: 'project', description: 'Reviews a diff', runtime: 'pi' },
          { name: 'tester', source: 'user', description: 'Runs suites', runtime: 'pi' },
        ],
      }),
    ).toEqual({
      kind: 'agents',
      rows: [
        { key: 'reviewer-0', label: 'reviewer', detail: 'Reviews a diff', state: 'project', tone: 'idle' },
        { key: 'tester-1', label: 'tester', detail: 'Runs suites', state: 'user', tone: 'idle' },
      ],
      summary: '2 agents',
      tone: 'idle',
    });
    expect(subagentResultView({ agents: [] })).toMatchObject({ kind: 'agents', rows: [], summary: 'no agents' });
  });

  it('reports what a run started and what it did not, from either host shape', () => {
    const outcomes = [
      { agent: 'reviewer', task: 'review', childIndex: 0, runId: 'run-1' },
      { agent: 'scout', task: 'map', childIndex: 1, error: 'no executable agent named scout' },
      { agent: 'writer', task: 'write', childIndex: 2 },
    ];
    const headless = subagentResultView({ outcomes });
    expect(headless).toMatchObject({ kind: 'run', summary: '1 started · 2 failed', tone: 'error' });
    expect(headless?.rows).toEqual([
      { key: 'run-1', label: 'reviewer', detail: 'run-1', state: 'started', tone: 'ok' },
      {
        key: 'scout-1',
        label: 'scout',
        detail: 'no executable agent named scout',
        state: 'failed',
        tone: 'error',
      },
      { key: 'writer-2', label: 'writer', detail: 'unknown error', state: 'failed', tone: 'error' },
    ]);
    // The Pi path nests the same plan under `spawn`.
    expect(subagentResultView({ spawn: { outcomes: [outcomes[0]] }, started: 1, failed: 0 })).toMatchObject({
      kind: 'run',
      summary: '1 started',
      tone: 'ok',
    });
  });

  // The label stays the run id because that is what a reader copies back into
  // a status call; the identity leads the detail so the row still says who it is.
  it('leads the fleet detail with the identity and marks an inline run', () => {
    const view = subagentResultView({
      runs: [
        { runId: 'run-1', identity: 'alan-reviewer-1', agent: 'doompi-reviewer', status: 'running' },
        { runId: 'run-2', identity: 'bea-developer-2', inline: true, agent: 'doompi-developer', status: 'running' },
        { runId: 'run-3', agent: 'legacy-run-without-identity', status: 'running' },
      ],
    });

    expect(view?.rows.map((row) => [row.label, row.detail])).toEqual([
      ['run-1', 'alan-reviewer-1 · doompi-reviewer'],
      ['run-2', 'bea-developer-2 (inline) · doompi-developer'],
      ['run-3', 'legacy-run-without-identity'],
    ]);
  });

  it('tones the fleet rows by run state, under either key', () => {
    const view = subagentResultView({
      runs: [
        { runId: 'run-1', agent: 'reviewer', status: 'running', currentTool: 'read' },
        { runId: 'run-2', agent: 'tester', status: 'failed', error: 'typecheck did not pass' },
        { runId: 'run-3', agent: 'writer', status: 'completed' },
        { runId: 'run-4', agent: 'scout', status: 'queued' },
        { runId: 'run-5', agent: 'scout' },
      ],
    });
    expect(view).toMatchObject({ kind: 'fleet', summary: '5 runs', tone: 'idle' });
    expect(view?.rows.map((row) => [row.label, row.state, row.tone, row.detail])).toEqual([
      ['run-1', 'running', 'running', 'reviewer · read'],
      ['run-2', 'failed', 'error', 'tester · typecheck did not pass'],
      ['run-3', 'completed', 'ok', 'writer'],
      ['run-4', 'queued', 'idle', 'scout'],
      ['run-5', 'starting', 'running', 'scout'],
    ]);
    expect(subagentResultView({ fleet: [], suspended: undefined })).toMatchObject({
      kind: 'fleet',
      summary: 'no runs',
    });
  });

  it('names one run and admits when it has no status yet', () => {
    expect(
      subagentResultView({
        runId: 'run-1',
        status: { runId: 'run-1', agent: 'reviewer', state: 'complete', summary: 'two defects filed' },
      }),
    ).toEqual({
      kind: 'status',
      rows: [
        {
          key: 'run-1',
          label: 'run-1',
          detail: 'reviewer · two defects filed',
          state: 'complete',
          tone: 'ok',
        },
      ],
      summary: '',
      tone: 'ok',
    });
    expect(subagentResultView({ runId: 'run-1', status: undefined })).toMatchObject({
      kind: 'status',
      rows: [],
      summary: 'run-1 has no status yet',
    });
  });

  it('marks a suspended run by whether it can be restored, one or many', () => {
    const runs = [
      { runId: 'run-1', agent: 'reviewer', runtime: 'pi', task: 'review the diff\nand report', resumable: true },
      { runId: 'run-2', agent: 'tester', runtime: 'codex', task: 'run suites', resumable: false },
      { runId: 'run-3', agent: 'writer', runtime: 'pi', task: 'write it up' },
    ];
    const view = subagentResultView({ suspended: runs });
    expect(view).toMatchObject({ kind: 'suspended', summary: '3 suspended runs' });
    expect(view?.rows.map((row) => [row.label, row.detail, row.state, row.tone])).toEqual([
      ['run-1', 'reviewer · review the diff', 'resumable', 'idle'],
      ['run-2', 'tester · run suites', 'not resumable', 'error'],
      ['run-3', 'writer · write it up', 'suspended', 'idle'],
    ]);
    expect(subagentResultView({ suspended: [] })).toMatchObject({ summary: 'no suspended runs' });
    // The Pi status path reports a single suspended record rather than a list.
    expect(subagentResultView({ suspended: runs[0] })?.rows).toHaveLength(1);
  });

  it('confirms the control actions in one line', () => {
    expect(subagentResultView({ runId: 'run-1', control: { requestId: 'stop-1' } })).toEqual({
      kind: 'control',
      rows: [],
      summary: 'stop requested for run-1',
      tone: 'ok',
    });
    expect(
      subagentResultView({ runId: 'run-1', steer: { requestId: 's-1', state: 'delivered', message: 'accepted' } }),
    ).toMatchObject({ summary: 'steer delivered: accepted', tone: 'ok' });
    expect(subagentResultView({ runId: 'run-1', steer: { state: 'failed' } })).toMatchObject({
      summary: 'steer failed',
      tone: 'error',
    });
    expect(subagentResultView({ restore: { runId: 'run-9', restoredFrom: 'run-1' } })).toMatchObject({
      summary: 'restored run-1 as run-9',
      tone: 'ok',
    });
  });
});

describe('the intercom card text', () => {
  it('names the target and previews the message per action', () => {
    expect(intercomCallSummary({ action: 'members' })).toEqual({ action: 'members', target: '', message: '' });
    expect(intercomCallSummary({ action: 'pending' })).toEqual({ action: 'pending', target: '', message: '' });
    expect(intercomCallSummary({ action: 'send', to: 'main', message: 'done\nwith  it' })).toEqual({
      action: 'send',
      target: 'main',
      message: 'done with it',
    });
    expect(intercomCallSummary({ action: 'ask', to: 'w1', message: 'x'.repeat(100) }).message).toHaveLength(72);
    expect(intercomCallSummary({ action: 'reply', requestId: 'req-1', message: 'ok' })).toEqual({
      action: 'reply',
      target: 'req-1',
      message: 'ok',
    });
    expect(intercomCallSummary({})).toEqual({ action: '', target: '', message: '' });
  });

  it('reads the outcome from the details the tool attaches', () => {
    expect(intercomOutcome(undefined)).toEqual({ outcome: 'none', who: '' });
    expect(intercomOutcome({ delivered: true, to: 'main' })).toEqual({ outcome: 'delivered', who: 'main' });
    expect(intercomOutcome({ state: 'queued', delivered: false, to: 'w1' })).toEqual({ outcome: 'queued', who: 'w1' });
    expect(intercomOutcome({ requestId: 'r', from: 'w1', reply: 'yes' })).toEqual({ outcome: 'answered', who: 'w1' });
    expect(intercomOutcome({ requestId: 'r', to: 'main' })).toEqual({ outcome: 'replied', who: 'main' });
    expect(intercomOutcome({ members: [] })).toEqual({ outcome: 'none', who: '' });
  });
});
