import { describe, expect, it, vi } from 'vitest';
import { requestRunnerStop, runnerRunsChannel, runners } from '../web/runnersStore.ts';

const run = (id: string, state: 'running' | 'completed') => ({ id, name: id, command: 'sleep 60', state });
const session = (sessionId: string | null) => runners.select(runners.store.state, sessionId);

describe('the runners web store channel', () => {
  it('keeps each session runner set separately and drops one with its session', () => {
    runners.reset();
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs: [run('a', 'running')] })!);
    runnerRunsChannel.apply('s2', runnerRunsChannel.parse({ runs: [] })!);
    expect(session('s1').runs).toHaveLength(1);
    expect(session('s2').runs).toEqual([]);
    expect(session(null).runs).toEqual([]);

    runnerRunsChannel.drop('s1');
    expect(runners.store.state.s1).toBeUndefined();
    // Malformed payloads are rejected at the parse gate.
    expect(runnerRunsChannel.parse('junk')).toBeNull();
    expect(runnerRunsChannel.parse({ runs: 'no' })).toBeNull();
    runners.reset();
  });

  it('sends the stop verb to the session and forgets the request once the runner exits', () => {
    runners.reset();
    const send = vi.fn();
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs: [run('a', 'running')] })!);

    requestRunnerStop(send, 's1', 'a');
    expect(send).toHaveBeenCalledWith('s1', { type: 'prompt', message: '/runners stop a' });
    expect(session('s1').stopRequested).toEqual(['a']);
    // Still pending while the hub keeps reporting it running.
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs: [run('a', 'running')] })!);
    expect(session('s1').stopRequested).toEqual(['a']);
    // Spent once the record reports an exit.
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs: [run('a', 'completed')] })!);
    expect(session('s1').stopRequested).toEqual([]);
    runners.reset();
  });
});
