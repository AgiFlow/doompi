import { describe, expect, it } from 'vitest';

describe('subagents plugin channel', () => {
  it('keeps each session fleet separately and drops one with its session', async () => {
    const { subagentRunsChannel, resetSubagents, subagentsStore } = await import('../../web/subagentsStore.ts');
    resetSubagents();
    const run = { runId: 'r1', agent: 'reviewer', state: 'running' };
    subagentRunsChannel.apply('s1', subagentRunsChannel.parse({ runs: [run] })!);
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
});
