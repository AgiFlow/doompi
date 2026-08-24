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
import type { SubagentRun } from '../../src/types/hub.ts';

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
