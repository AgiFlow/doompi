import { describe, expect, it } from 'vitest';

const run = (runId: string, state: string) => ({ runId, agent: 'reviewer', state });

describe('subagents plugin channel', () => {
  it('keeps each session fleet separately and drops one with its session', async () => {
    const { subagentRunsChannel, subagents } = await import('../../web/subagentsStore.ts');
    const session = (sessionId: string) => subagents.select(subagents.store.state, sessionId);
    subagents.reset();
    subagentRunsChannel.apply('s1', subagentRunsChannel.parse({ runs: [run('r1', 'running')] })!);
    subagentRunsChannel.apply('s2', subagentRunsChannel.parse({ runs: [] })!);
    expect(session('s1').runs).toHaveLength(1);
    expect(session('s2').runs).toEqual([]);

    subagentRunsChannel.apply('s1', subagentRunsChannel.parse({ runs: [] })!);
    expect(session('s1').runs).toEqual([]);

    subagentRunsChannel.drop('s1');
    expect(subagents.store.state.s1).toBeUndefined();
    // Malformed payloads are rejected at the parse gate.
    expect(subagentRunsChannel.parse('junk')).toBeNull();
    expect(subagentRunsChannel.parse({ runs: 'no' })).toBeNull();
    subagents.reset();
  });

  it('hides a cleared run until the feed forgets it, and closes its drawer', async () => {
    const { subagentRunsChannel, subagents, visibleRuns, dismissRun, openRun } =
      await import('../../web/subagentsStore.ts');
    const session = (sessionId: string | null) => subagents.select(subagents.store.state, sessionId);
    subagents.reset();
    const feed = (runs: unknown[]) => subagentRunsChannel.apply('s1', subagentRunsChannel.parse({ runs })!);
    feed([run('done-1', 'done'), run('live-1', 'running')]);
    openRun('s1', 'done-1');
    expect(session('s1').openRunId).toBe('done-1');

    dismissRun('s1', 'done-1');
    expect(visibleRuns(session('s1')).map((r) => r.runId)).toEqual(['live-1']);
    expect(session('s1').openRunId).toBeUndefined();
    // Still hidden while the hub keeps reporting it.
    feed([run('done-1', 'done'), run('live-1', 'running')]);
    expect(visibleRuns(session('s1')).map((r) => r.runId)).toEqual(['live-1']);
    // Once the retention window drops it from the feed, the dismissal is spent
    // and the reported list is handed back as is.
    feed([run('live-1', 'running')]);
    expect(session('s1').dismissed).toEqual([]);
    expect(visibleRuns(session('s1'))).toBe(session('s1').runs);
    expect(visibleRuns(session(null))).toEqual([]);
    subagents.reset();
  });

  it('asks the runtime to stop through the slash verb and remembers it until the run settles', async () => {
    const { subagentRunsChannel, subagents, requestRunStop } = await import('../../web/subagentsStore.ts');
    const session = (sessionId: string) => subagents.select(subagents.store.state, sessionId);
    subagents.reset();
    const sent: Array<{ sessionId: string; frame: Record<string, unknown> }> = [];
    const send = (sessionId: string, frame: Record<string, unknown>) => sent.push({ sessionId, frame });
    const feed = (runs: unknown[]) => subagentRunsChannel.apply('s1', subagentRunsChannel.parse({ runs })!);
    feed([run('r1', 'running')]);

    requestRunStop(send, 's1', 'r1');
    expect(sent).toEqual([{ sessionId: 's1', frame: { type: 'prompt', message: '/subagents-stop r1' } }]);
    expect(session('s1').stopRequested).toEqual(['r1']);
    // The request stands while the run is still winding down...
    feed([run('r1', 'running')]);
    expect(session('s1').stopRequested).toEqual(['r1']);
    // ...and is spent once the run reports its own final state.
    feed([run('r1', 'stopped')]);
    expect(session('s1').stopRequested).toEqual([]);
    subagents.reset();
  });

  it('sends steering guidance through the dedicated session slash command', async () => {
    const { requestRunSteer } = await import('../../web/subagentsStore.ts');
    const sent: Array<{ sessionId: string; frame: Record<string, unknown> }> = [];

    requestRunSteer((sessionId, frame) => sent.push({ sessionId, frame }), 's1', 'r1', 'check the edge case');

    expect(sent).toEqual([
      { sessionId: 's1', frame: { type: 'prompt', message: '/subagents-steer r1 check the edge case' } },
    ]);
  });

  it('remembers a launch until a new run of that agent arrives, then flags it to open once', async () => {
    const { clearAutoOpen, requestLaunch, subagentRunsChannel, subagents } =
      await import('../../web/subagentsStore.ts');
    const session = (sessionId: string) => subagents.select(subagents.store.state, sessionId);
    const fleet = (...runs: Array<[string, string]>) =>
      subagentRunsChannel.parse({ runs: runs.map(([runId, agent]) => ({ runId, agent, state: 'running' })) })!;
    subagents.reset();
    subagentRunsChannel.apply('s1', fleet(['r1', 'reviewer']));

    const sent: Array<{ sessionId: string; frame: Record<string, unknown> }> = [];
    requestLaunch((sessionId, frame) => sent.push({ sessionId, frame }), 's1', '/run reviewer do it', 'reviewer');
    expect(sent).toEqual([{ sessionId: 's1', frame: { type: 'prompt', message: '/run reviewer do it' } }]);
    expect(session('s1').pendingLaunch).toEqual({ agent: 'reviewer', knownRunIds: ['r1'] });

    // Another agent's run, and the run already known, leave the launch pending.
    subagentRunsChannel.apply('s1', fleet(['r1', 'reviewer'], ['r2', 'scout']));
    expect(session('s1')).toMatchObject({ pendingLaunch: { agent: 'reviewer' }, autoOpenRunId: undefined });

    subagentRunsChannel.apply('s1', fleet(['r1', 'reviewer'], ['r2', 'scout'], ['r3', 'reviewer']));
    expect(session('s1')).toMatchObject({ pendingLaunch: undefined, autoOpenRunId: 'r3' });
    clearAutoOpen('s1');
    expect(session('s1').autoOpenRunId).toBeUndefined();
    subagents.reset();
  });
});
