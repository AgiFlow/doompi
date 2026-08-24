import { describe, expect, it } from 'vitest';
import { createFrameRing } from '../../src/services/frameRing.ts';
import {
  isRecordFileName,
  parseSessionRecord,
  resolveRegistryDir,
  sessionRecordPath,
} from '../../src/services/registryStore.ts';
import { initialPresence, presenceAfterCommand, reducePresence } from '../../src/services/sessionPresence.ts';
import { parseSubagentRun, presentRuns, teamRunsDirFor } from '../../src/services/subagentRuns.ts';
import {
  foldWorkflowProgress,
  parseWorkflowProgress,
  parseWorkflowRunRecord,
  presentWorkflowRuns,
  resolveWorkflowHome,
  runBelongsToSession,
  workflowPosition,
} from '../../src/services/workflowRuns.ts';
import type { SubagentRun, WorkflowRunView } from '../../src/types/hub.ts';
import type { WorkflowProgressEvent, WorkflowRunRecord } from '@agimon-ai/workflow-mcp';

const T0 = '2026-08-24T10:00:00.000Z';
const T1 = '2026-08-24T10:01:00.000Z';
const T2 = '2026-08-24T10:02:00.000Z';

function validRecord(): Record<string, unknown> {
  return {
    version: 1,
    id: 'a1b2',
    name: 'untitled',
    cwd: '/workspace/project',
    socketPath: '/run/a1b2.sock',
    tokenFile: '/run/a1b2.token',
    pid: 4242,
    createdAt: T0,
  };
}

describe('registryStore', () => {
  it('resolves the registry directory with flag over env over home', () => {
    expect(resolveRegistryDir({ flagValue: '/f', envValue: '/e', homeDir: '/h' })).toBe('/f');
    expect(resolveRegistryDir({ envValue: '/e', homeDir: '/h' })).toBe('/e');
    expect(resolveRegistryDir({ homeDir: '/h' })).toBe('/h/.doompi/run');
    expect(sessionRecordPath('/h/.doompi/run', 'a1b2')).toBe('/h/.doompi/run/sessions/a1b2.json');
  });

  it('parses a well-formed record', () => {
    expect(parseSessionRecord(JSON.stringify(validRecord()))).toEqual(validRecord());
  });

  it('rejects records it cannot trust', () => {
    expect(parseSessionRecord('not json')).toBeUndefined();
    expect(parseSessionRecord('[1]')).toBeUndefined();
    expect(parseSessionRecord(JSON.stringify({ ...validRecord(), version: 2 }))).toBeUndefined();
    expect(parseSessionRecord(JSON.stringify({ ...validRecord(), id: '' }))).toBeUndefined();
    expect(parseSessionRecord(JSON.stringify({ ...validRecord(), pid: 'soon' }))).toBeUndefined();
    expect(parseSessionRecord(JSON.stringify({ ...validRecord(), socketPath: undefined }))).toBeUndefined();
  });

  it('only considers record files', () => {
    expect(isRecordFileName('a1b2.json')).toBe(true);
    expect(isRecordFileName('a1b2.json.tmp')).toBe(false);
    expect(isRecordFileName('.DS_Store')).toBe(false);
  });
});

describe('frameRing', () => {
  it('keeps the newest frames and counts the loss', () => {
    const ring = createFrameRing(2);
    ring.record({ index: 1 });
    ring.record({ index: 2 });
    ring.record({ index: 3 });
    expect(ring.snapshot()).toEqual({ frames: [{ index: 2 }, { index: 3 }], dropped: 1 });
  });

  it('snapshots a copy, not the live buffer', () => {
    const ring = createFrameRing(8);
    ring.record({ index: 1 });
    const first = ring.snapshot();
    ring.record({ index: 2 });
    expect(first.frames).toHaveLength(1);
  });
});

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
});

describe('workflowRuns', () => {
  it('resolves the registry home the way the engine does: env override, then ~/.workflow-mcp', () => {
    expect(resolveWorkflowHome({ envValue: '/custom/home', homeDir: '/h' })).toBe('/custom/home');
    expect(resolveWorkflowHome({ envValue: undefined, homeDir: '/h' })).toBe('/h/.workflow-mcp');
    expect(resolveWorkflowHome({ envValue: '', homeDir: '/h' })).toBe('/h/.workflow-mcp');
  });

  it('parses a run record the engine writes, typed against its published schema', () => {
    // Typing the fixture as the engine's own WorkflowRunRecord is the pin:
    // if @agimon-ai/workflow-mcp renames a field this mirror reads, this
    // fixture stops compiling. Values follow a real errored run observed in
    // ~/.workflow-mcp (an axx-wu-74 dev-full run).
    const record: WorkflowRunRecord = {
      displayName: 'AXX-WU-74',
      dryRun: false,
      env: { PI_SESSION_ID: '01a00eef-d11a-7a5a-afc6-a3eb14164011' },
      pid: 83102,
      runKey: 'axx-wu-74',
      stage: 'error',
      startedAt: '2026-08-17T21:13:28.133Z',
      finishedAt: '2026-08-17T22:34:28.391Z',
      outcome: 'failed',
      exitCode: 1,
      errorMessage: '\n\u001b[31m\u001b[1mworktree afterCompleted hook failed\u001b[0m',
      originalRepoPath: '/Users/dev/workspace/agirepo',
      workflowPath: '/Users/dev/workspace/agirepo/automations/workflows/dev-full.workflow.yml',
      workflowId: 'dev-full.workflow',
      workflowName: 'Development',
      workspace: 'agiflow',
      worktreeBranch: 'worktree/axx-wu-74',
    };
    const parsed = parseWorkflowRunRecord(JSON.stringify(record));
    expect(parsed?.view).toMatchObject({
      runKey: 'axx-wu-74',
      workspace: 'agiflow',
      displayName: 'AXX-WU-74',
      workflowName: 'Development',
      stage: 'error',
      outcome: 'failed',
      errorMessage: 'worktree afterCompleted hook failed',
      worktreeBranch: 'worktree/axx-wu-74',
      jobs: [],
    });
    expect(parsed?.piSessionId).toBe('01a00eef-d11a-7a5a-afc6-a3eb14164011');
    expect(parsed?.originalRepoPath).toBe('/Users/dev/workspace/agirepo');
  });

  it('rejects malformed or foreign records', () => {
    expect(parseWorkflowRunRecord('not json')).toBeUndefined();
    expect(parseWorkflowRunRecord('[]')).toBeUndefined();
    expect(parseWorkflowRunRecord(JSON.stringify({ runKey: 'x', workspace: 'w' }))).toBeUndefined();
    expect(
      parseWorkflowRunRecord(
        JSON.stringify({ runKey: 'x', workspace: 'w', workflowPath: '/p', startedAt: 'now', stage: 'archived' }),
      ),
    ).toBeUndefined();
  });

  it('folds the progress log into the job tree, pinned to observed real-world lines', () => {
    // Verbatim shape of a dev-fix.workflow.yml run's progress.ndjson, plus a
    // failing job to cover the terminal states.
    const events: WorkflowProgressEvent[] = [
      { type: 'job', status: 'running', job: 'diagnose', index: 0, total: 2, at: '2026-08-21T09:08:17.960Z' },
      {
        type: 'step',
        status: 'running',
        job: 'diagnose',
        step: 'Diagnose the defect',
        index: 0,
        total: 1,
        at: '2026-08-21T09:08:17.963Z',
      },
      {
        type: 'step',
        status: 'completed',
        job: 'diagnose',
        step: 'Diagnose the defect',
        at: '2026-08-21T09:08:17.964Z',
      },
      { type: 'job', status: 'completed', job: 'diagnose', at: '2026-08-21T09:08:17.964Z' },
      { type: 'job', status: 'running', job: 'fix', index: 1, total: 2, at: '2026-08-21T09:08:17.965Z' },
      { type: 'step', status: 'running', job: 'fix', step: 'Implement the fix', at: '2026-08-21T09:08:17.966Z' },
      {
        type: 'step',
        status: 'failed',
        job: 'fix',
        step: 'Implement the fix',
        reason: 'exit code 1',
        at: '2026-08-21T09:08:17.970Z',
      },
      { type: 'job', status: 'failed', job: 'fix', at: '2026-08-21T09:08:17.970Z' },
    ];
    const raw = events.map((event) => JSON.stringify(event)).join('\n');
    const jobs = foldWorkflowProgress(parseWorkflowProgress(raw));
    expect(jobs.map((job) => `${job.name}:${job.status}`)).toEqual(['diagnose:completed', 'fix:failed']);
    expect(jobs[0]).toMatchObject({
      phase: 'job',
      startedAt: '2026-08-21T09:08:17.960Z',
      endedAt: '2026-08-21T09:08:17.964Z',
    });
    expect(jobs[1]?.steps[0]).toMatchObject({ name: 'Implement the fix', status: 'failed', reason: 'exit code 1' });
  });

  it('skips a torn final line and classifies pre/post pseudo-jobs', () => {
    const raw = [
      JSON.stringify({ type: 'job', status: 'running', job: 'pre', at: '2026-08-21T09:00:00.000Z' }),
      JSON.stringify({ type: 'job', status: 'completed', job: 'pre', at: '2026-08-21T09:00:01.000Z' }),
      JSON.stringify({
        type: 'job',
        status: 'running',
        job: 'build',
        index: 0,
        total: 1,
        at: '2026-08-21T09:00:02.000Z',
      }),
      JSON.stringify({
        type: 'step',
        status: 'running',
        job: 'build',
        step: 'compile',
        at: '2026-08-21T09:00:03.000Z',
      }),
      '{"type":"step","status":"comp', // torn mid-append
    ].join('\n');
    const jobs = foldWorkflowProgress(parseWorkflowProgress(raw));
    expect(jobs.map((job) => job.phase)).toEqual(['pre', 'job']);
    expect(workflowPosition(jobs)).toEqual({ job: 'build', step: 'compile', index: 0, total: 1 });
  });

  it('scopes runs by owning session id or repository overlap', () => {
    const parsed = parseWorkflowRunRecord(
      JSON.stringify({
        runKey: 'r',
        workspace: 'w',
        workflowPath: '/repo/automations/wf.workflow.yml',
        startedAt: '2026-08-21T09:00:00.000Z',
        stage: 'running',
        originalRepoPath: '/repo',
        env: { PI_SESSION_ID: 'owner' },
      }),
    );
    expect(parsed).toBeDefined();
    if (!parsed) return;
    expect(runBelongsToSession(parsed, { sessionId: 'owner', cwd: '/elsewhere' })).toBe(true);
    expect(runBelongsToSession(parsed, { sessionId: 'other', cwd: '/repo' })).toBe(true);
    expect(runBelongsToSession(parsed, { sessionId: 'other', cwd: '/repo/packages/sub' })).toBe(true);
    expect(runBelongsToSession(parsed, { sessionId: 'other', cwd: '/repo-sibling' })).toBe(false);
  });

  it('presents running first, keeps errors a day, retires completed after ten minutes', () => {
    const run = (overrides: Partial<WorkflowRunView>): WorkflowRunView => ({
      runKey: 'r',
      workspace: 'w',
      displayName: 'r',
      workflowPath: '/repo/wf.yml',
      stage: 'running',
      startedAt: '2026-08-21T09:00:00.000Z',
      jobs: [],
      ...overrides,
    });
    const now = Date.parse('2026-08-21T10:00:00.000Z');
    const hourAgo = '2026-08-21T09:00:00.000Z';
    const justNow = '2026-08-21T09:55:00.000Z';
    const presented = presentWorkflowRuns(
      [
        run({ runKey: 'old-done', stage: 'completed', outcome: 'success', finishedAt: hourAgo }),
        run({ runKey: 'fresh-done', stage: 'completed', outcome: 'success', finishedAt: justNow }),
        run({ runKey: 'old-error', stage: 'error', outcome: 'failed', finishedAt: hourAgo }),
        run({ runKey: 'live', stage: 'running', startedAt: justNow }),
      ],
      now,
    );
    expect(presented.map((entry) => entry.runKey)).toEqual(['live', 'old-error', 'fresh-done']);
  });
});

describe('sessionPresence', () => {
  it('walks a run through turn and back to idle', () => {
    let presence = initialPresence(T0);
    presence = reducePresence(presence, { type: 'agent_start' }, T1);
    expect(presence).toMatchObject({ phase: 'turn', phaseSince: T1 });

    presence = reducePresence(presence, { type: 'agent_settled' }, T2);
    expect(presence).toMatchObject({ phase: 'idle', phaseSince: T2, lastSettledAt: T2, awaitingInput: false });
  });

  it('returns the same object when a frame changes nothing it reports', () => {
    const presence = initialPresence(T0);
    expect(reducePresence(presence, { type: 'message_update' }, T1)).toBe(presence);
    expect(reducePresence(presence, { type: 'agent_settled_elsewhere' }, T1)).toBe(presence);
  });

  it('unwraps replayed frames', () => {
    const presence = reducePresence(initialPresence(T0), { type: 'replay', frame: { type: 'agent_start' } }, T1);
    expect(presence.phase).toBe('turn');
  });

  it('flags a dialog as waiting for input until it is answered', () => {
    let presence = reducePresence(initialPresence(T0), { type: 'agent_start' }, T0);
    presence = reducePresence(presence, { type: 'extension_ui_request', method: 'confirm', id: 'r1' }, T1);
    expect(presence.awaitingInput).toBe(true);

    presence = presenceAfterCommand(presence, { type: 'extension_ui_response', id: 'r1', confirmed: true }, T2);
    expect(presence.awaitingInput).toBe(false);
  });

  it('ignores non-dialog ui requests', () => {
    const presence = initialPresence(T0);
    expect(reducePresence(presence, { type: 'extension_ui_request', method: 'setStatus' }, T1)).toBe(presence);
  });

  it('marks a session as prompted by the outbound command', () => {
    let presence = initialPresence(T0);
    presence = presenceAfterCommand(presence, { type: 'prompt', message: 'go' }, T1);
    expect(presence.everPrompted).toBe(true);
    // Idempotent: a second prompt changes nothing.
    expect(presenceAfterCommand(presence, { type: 'prompt', message: 'more' }, T2)).toBe(presence);
  });

  it('folds the get_state snapshot the hub requests on attach', () => {
    const presence = reducePresence(
      initialPresence(T0),
      {
        type: 'response',
        command: 'get_state',
        data: { isStreaming: true, isCompacting: false, pendingMessageCount: 2, sessionName: 'doompi-web' },
      },
      T1,
    );
    expect(presence).toMatchObject({ phase: 'turn', pendingMessageCount: 2, sessionName: 'doompi-web' });

    const compacting = reducePresence(
      initialPresence(T0),
      { type: 'response', command: 'get_state', data: { isCompacting: true } },
      T1,
    );
    expect(compacting.phase).toBe('compaction');
  });
});
