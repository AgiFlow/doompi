import { describe, expect, it } from 'vitest';

const run = (runId: string, state: string) => ({ runId, agent: 'reviewer', state });

describe('subagents plugin channel', () => {
  it('keeps each session fleet separately and drops one with its session', async () => {
    const { subagentRunsChannel, resetSubagents, subagentsStore } = await import('../../web/subagentsStore.ts');
    resetSubagents();
    subagentRunsChannel.apply('s1', subagentRunsChannel.parse({ runs: [run('r1', 'running')] })!);
    subagentRunsChannel.apply('s2', subagentRunsChannel.parse({ runs: [] })!);
    expect(subagentsStore.state.bySession.s1).toHaveLength(1);
    expect(subagentsStore.state.bySession.s2).toEqual([]);

    subagentRunsChannel.apply('s1', subagentRunsChannel.parse({ runs: [] })!);
    expect(subagentsStore.state.bySession.s1).toEqual([]);

    subagentRunsChannel.drop('s1');
    expect(subagentsStore.state.bySession.s1).toBeUndefined();
    // Malformed payloads are rejected at the parse gate.
    expect(subagentRunsChannel.parse('junk')).toBeNull();
    expect(subagentRunsChannel.parse({ runs: 'no' })).toBeNull();
    resetSubagents();
  });

  it('hides a cleared run until the feed forgets it, and closes its drawer', async () => {
    const { subagentRunsChannel, resetSubagents, subagentsStore, visibleRuns, dismissRun, openRun } =
      await import('../../web/subagentsStore.ts');
    resetSubagents();
    const feed = (runs: unknown[]) => subagentRunsChannel.apply('s1', subagentRunsChannel.parse({ runs })!);
    feed([run('done-1', 'done'), run('live-1', 'running')]);
    openRun('s1', 'done-1');

    dismissRun('s1', 'done-1');
    expect(visibleRuns(subagentsStore.state, 's1').map((r) => r.runId)).toEqual(['live-1']);
    expect(subagentsStore.state.openRunId.s1).toBeUndefined();
    // Still hidden while the hub keeps reporting it.
    feed([run('done-1', 'done'), run('live-1', 'running')]);
    expect(visibleRuns(subagentsStore.state, 's1').map((r) => r.runId)).toEqual(['live-1']);
    // Once the retention window drops it from the feed, the dismissal is spent.
    feed([run('live-1', 'running')]);
    expect(subagentsStore.state.dismissed.s1).toEqual([]);
    expect(visibleRuns(subagentsStore.state, null)).toEqual([]);
    resetSubagents();
  });

  it('asks the runtime to stop through the slash verb and remembers it until the run settles', async () => {
    const {
      subagentRunsChannel,
      resetSubagents,
      subagentsStore,
      bindSubagentsRuntime,
      requestRunStop,
      isStopRequested,
    } = await import('../../web/subagentsStore.ts');
    resetSubagents();
    const sent: Array<{ sessionId: string; frame: Record<string, unknown> }> = [];
    const unbind = bindSubagentsRuntime({
      sendSessionFrame: (sessionId, frame) => sent.push({ sessionId, frame }),
      sendHubFrame: () => undefined,
    });
    const feed = (runs: unknown[]) => subagentRunsChannel.apply('s1', subagentRunsChannel.parse({ runs })!);
    feed([run('r1', 'running')]);

    requestRunStop('s1', 'r1');
    expect(sent).toEqual([{ sessionId: 's1', frame: { type: 'prompt', message: '/subagents-stop r1' } }]);
    expect(isStopRequested(subagentsStore.state, 's1', 'r1')).toBe(true);
    // The request stands while the run is still winding down...
    feed([run('r1', 'running')]);
    expect(isStopRequested(subagentsStore.state, 's1', 'r1')).toBe(true);
    // ...and is spent once the run reports its own final state.
    feed([run('r1', 'stopped')]);
    expect(isStopRequested(subagentsStore.state, 's1', 'r1')).toBe(false);

    unbind();
    requestRunStop('s1', 'r1');
    expect(sent).toHaveLength(1);
    resetSubagents();
  });
});
