import { describe, expect, it, vi } from 'vitest';
import {
  bindRunnersRuntime,
  isStopRequested,
  requestRunnerStop,
  resetRunners,
  runnerRunsChannel,
  runnersStore,
  sessionRunners,
} from '../web/runnersStore.ts';

const run = (id: string, state: 'running' | 'completed') => ({ id, name: id, command: 'sleep 60', state });

describe('the runners web store channel', () => {
  it('keeps each session runner set separately and drops one with its session', () => {
    resetRunners();
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs: [run('a', 'running')] })!);
    runnerRunsChannel.apply('s2', runnerRunsChannel.parse({ runs: [] })!);
    expect(sessionRunners(runnersStore.state, 's1')).toHaveLength(1);
    expect(sessionRunners(runnersStore.state, 's2')).toEqual([]);
    expect(sessionRunners(runnersStore.state, null)).toEqual([]);

    runnerRunsChannel.drop('s1');
    expect(runnersStore.state.bySession.s1).toBeUndefined();
    // Malformed payloads are rejected at the parse gate.
    expect(runnerRunsChannel.parse('junk')).toBeNull();
    expect(runnerRunsChannel.parse({ runs: 'no' })).toBeNull();
    resetRunners();
  });

  it('sends the stop verb to the session and forgets the request once the runner exits', () => {
    resetRunners();
    const sendSessionFrame = vi.fn();
    const unbind = bindRunnersRuntime({ sendSessionFrame, sendHubFrame: vi.fn() });
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs: [run('a', 'running')] })!);

    requestRunnerStop('s1', 'a');
    expect(sendSessionFrame).toHaveBeenCalledWith('s1', { type: 'prompt', message: '/runners stop a' });
    expect(isStopRequested(runnersStore.state, 's1', 'a')).toBe(true);
    // Still pending while the hub keeps reporting it running.
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs: [run('a', 'running')] })!);
    expect(isStopRequested(runnersStore.state, 's1', 'a')).toBe(true);
    // Spent once the record reports an exit.
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs: [run('a', 'completed')] })!);
    expect(isStopRequested(runnersStore.state, 's1', 'a')).toBe(false);

    unbind();
    requestRunnerStop('s1', 'a');
    expect(sendSessionFrame).toHaveBeenCalledTimes(1);
    resetRunners();
  });
});
