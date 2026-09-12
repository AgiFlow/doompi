import type {
  DoomDirectEventBus,
  DoomHubChannelHost,
  DoomHubSessionScope,
} from '@agimon-ai/doompi-extension-contracts/hub-channel';
import { describe, expect, it } from 'vitest';
import { createSubagentsChannel } from '../../src/controllers/webSubagentsChannel';
import type { SubagentRun } from '../../src/types/webSubagents';

interface FakeHost extends DoomHubChannelHost {
  published: Array<{ sessionId: string; payload: unknown }>;
  emit(sessionId: string, payload: unknown): void;
}

function fakeHost(): FakeHost {
  const published: FakeHost['published'] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const latest = new Map<string, unknown>();
  const key = (frameType: string, sessionId: string): string => `${frameType}:${sessionId}`;
  const directEvents: DoomDirectEventBus = {
    publish(frameType, sessionId, payload) {
      const eventKey = key(frameType, sessionId);
      latest.set(eventKey, payload);
      for (const listener of listeners.get(eventKey) ?? []) listener(payload);
    },
    subscribe(frameType, sessionId, listener, options) {
      const eventKey = key(frameType, sessionId);
      const current = listeners.get(eventKey) ?? new Set<(payload: unknown) => void>();
      current.add(listener);
      listeners.set(eventKey, current);
      if (options?.replayLatest && latest.has(eventKey)) listener(latest.get(eventKey));
      return () => {
        current.delete(listener);
        if (current.size === 0) listeners.delete(eventKey);
      };
    },
    clearSession(sessionId) {
      for (const eventKey of latest.keys()) if (eventKey.endsWith(`:${sessionId}`)) latest.delete(eventKey);
    },
    close: () => listeners.clear(),
  };
  return {
    published,
    emit: (sessionId, payload) => directEvents.publish('subagent_runs', sessionId, payload),
    sessions: () => [],
    directEvents,
    publish: (sessionId, payload) => published.push({ sessionId, payload }),
    requestSessionApi: () => Promise.resolve(Response.json({ error: 'must not be called' }, { status: 500 })),
    onNotice: () => undefined,
  };
}

interface SessionRunProjection extends SubagentRun {
  sessionFile?: string;
}

const run = (runId: string, sessionFile?: string): SessionRunProjection => ({
  runId,
  agent: 'reviewer',
  state: 'running',
  rawState: 'running',
  task: 'Review the diff.',
  cwd: '/workspace',
  startedAt: 1,
  lastUpdate: 2,
  tail: [],
  ...(sessionFile === undefined ? {} : { sessionFile }),
});

const payload = (...runs: SessionRunProjection[]) => ({ runs });
const scope = (sessionId: string): DoomHubSessionScope => ({ sessionId, cwd: '/workspace' });

describe('the subagents hub channel', () => {
  it('replays host-owned snapshots and keeps sessions isolated', () => {
    const host = fakeHost();
    host.emit('first', payload(run('run-a')));
    host.emit('second', payload(run('run-b')));
    const source = createSubagentsChannel().start(host);
    source.sessionAdded?.(scope('first'));
    source.sessionAdded?.(scope('second'));

    expect(source.payloadFor(scope('first'))).toEqual(payload(run('run-a')));
    expect(source.payloadFor(scope('second'))).toEqual(payload(run('run-b')));
    expect(host.published).toEqual([
      { sessionId: 'first', payload: payload(run('run-a')) },
      { sessionId: 'second', payload: payload(run('run-b')) },
    ]);

    host.emit('first', payload(run('run-a'), run('run-a-2')));
    expect(source.payloadFor(scope('first'))).toEqual(payload(run('run-a'), run('run-a-2')));
    expect(source.payloadFor(scope('second'))).toEqual(payload(run('run-b')));
  });

  it('uses the published transcript path and rejects malformed events', () => {
    const host = fakeHost();
    const source = createSubagentsChannel().start(host);
    source.sessionAdded?.(scope('s1'));
    host.emit('s1', { runs: 'invalid' });
    expect(host.published).toEqual([]);

    const journal = '/sessions/run-j.jsonl';
    host.emit('s1', payload(run('run-j', journal), run('run-no-journal')));
    expect(source.threadJournal?.(scope('s1'), 'run-j')).toBe(journal);
    expect(source.threadJournal?.(scope('s1'), 'run-no-journal')).toBeUndefined();
    expect(source.threadJournal?.(scope('s1'), '../run-j')).toBeUndefined();
    expect(host.published[0]?.payload).toEqual(payload(run('run-j'), run('run-no-journal')));
    expect(source.payloadFor(scope('s1'))).toEqual(payload(run('run-j'), run('run-no-journal')));

    source.close();
    host.emit('s1', payload(run('late')));
    expect(host.published).toHaveLength(1);
  });

  it('forgets a removed session', () => {
    const host = fakeHost();
    const source = createSubagentsChannel().start(host);
    source.sessionAdded?.(scope('s1'));
    host.emit('s1', payload(run('run-1')));
    source.sessionRemoved?.('s1');

    expect(source.payloadFor(scope('s1'))).toBeUndefined();
    host.emit('s1', payload(run('late')));
    expect(host.published).toHaveLength(1);
  });
});
