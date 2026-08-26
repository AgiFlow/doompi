import { describe, expect, it, vi } from 'vitest';
import { isFollowingLive, logViewLines } from '../web/format.ts';
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

describe('the lines a log view shows', () => {
  it('does not count the newline a log file ends with as a line', () => {
    // LogReader hands back the file's trailing newline, so a naive split would
    // report one blank line more than the file has and the count under the
    // search bar would disagree with the server's own totalLines.
    expect(logViewLines('one\ntwo\nthree\n', [], 100)).toEqual(['one', 'two', 'three']);
  });

  it('keeps a blank line that is genuinely inside the log', () => {
    expect(logViewLines('one\n\nthree\n', [], 100)).toEqual(['one', '', 'three']);
  });

  it('shows nothing for an empty log rather than one blank line', () => {
    expect(logViewLines('', [], 100)).toEqual([]);
  });

  it('appends what the follow stream delivered, after the slice', () => {
    expect(logViewLines('one\ntwo\n', ['three'], 100)).toEqual(['one', 'two', 'three']);
  });

  it('keeps only the newest lines, so a long follow cannot grow without bound', () => {
    expect(logViewLines('one\ntwo\nthree\n', ['four'], 2)).toEqual(['three', 'four']);
  });
});

describe('whether a log view is following', () => {
  it('follows a running log the reader asked to follow', () => {
    expect(isFollowingLive(true, false, true)).toBe(true);
  });

  it('stops following once the runner exits, so a finished run never claims to tail', () => {
    expect(isFollowingLive(true, false, false)).toBe(false);
  });

  it('pauses while a query is set, because a filtered view is a snapshot', () => {
    expect(isFollowingLive(true, true, true)).toBe(false);
  });

  it('does not follow when the reader turned it off', () => {
    expect(isFollowingLive(false, false, true)).toBe(false);
  });
});
