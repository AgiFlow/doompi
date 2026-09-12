import type { DoomDirectEventBus, DoomHubChannelHost } from '@agimon-ai/doompi-extension-contracts/hub-channel';
import { describe, expect, it } from 'vitest';
import { createRunnersChannel } from '../src/services/runnersChannel';
import type { RunnerRunView } from '../src/types/webRunners';

interface FakeHost extends DoomHubChannelHost {
  published: Array<{ sessionId: string; payload: unknown }>;
  emit(sessionId: string, payload: unknown): void;
}

function fakeHost(): FakeHost {
  const published: FakeHost['published'] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const key = (sessionId: string): string => `runner_runs:${sessionId}`;
  const directEvents: DoomDirectEventBus = {
    publish(_frameType, sessionId, payload) {
      for (const listener of listeners.get(key(sessionId)) ?? []) listener(payload);
    },
    subscribe(_frameType, sessionId, listener) {
      const current = listeners.get(key(sessionId)) ?? new Set<(payload: unknown) => void>();
      current.add(listener);
      listeners.set(key(sessionId), current);
      return () => {
        current.delete(listener);
        if (current.size === 0) listeners.delete(key(sessionId));
      };
    },
    close() {
      listeners.clear();
    },
  };
  return {
    published,
    emit(sessionId, payload) {
      directEvents.publish('runner_runs', sessionId, payload);
    },
    directEvents,
    sessions: () => [],
    publish: (sessionId, payload) => published.push({ sessionId, payload }),
    requestSessionApi: () => Promise.resolve(Response.json({ error: 'not implemented' }, { status: 501 })),
    onNotice: () => undefined,
  };
}

const run = (id: string): RunnerRunView => ({
  id,
  name: id,
  pid: 42,
  command: 'pnpm dev',
  cwd: '/repo',
  interactive: false,
  backend: 'native',
  state: 'running',
  promoted: true,
  startedAt: '2026-08-07T00:00:00.000Z',
  logPath: '/tmp/server.log',
});

describe('the runners hub channel', () => {
  it('subscribes to lifecycle-owned snapshots and answers per-session snapshots', () => {
    const host = fakeHost();
    const source = createRunnersChannel().start(host);
    const s1 = { sessionId: 's1', cwd: '/repo' };
    const s2 = { sessionId: 's2', cwd: '/repo' };

    expect(source.payloadFor(s1)).toBeUndefined();
    source.sessionAdded?.(s1);
    source.sessionAdded?.(s2);
    host.emit('s1', { runs: [run('runner-a')] });
    expect(source.payloadFor(s1)).toEqual({ runs: [run('runner-a')] });
    expect(source.payloadFor(s2)).toBeUndefined();
    expect(host.published).toEqual([{ sessionId: 's1', payload: { runs: [run('runner-a')] } }]);

    host.emit('s2', { runs: [run('runner-b')] });
    expect(source.payloadFor(s2)).toEqual({ runs: [run('runner-b')] });
    expect(host.published.at(-1)).toEqual({ sessionId: 's2', payload: { runs: [run('runner-b')] } });

    source.sessionRemoved?.('s1');
    host.emit('s1', { runs: [] });
    expect(source.payloadFor(s1)).toBeUndefined();
    expect(host.published).toHaveLength(2);
  });

  it('ignores malformed snapshots and closes every subscription', () => {
    const host = fakeHost();
    const source = createRunnersChannel().start(host);
    source.sessionAdded?.({ sessionId: 's1', cwd: '/repo' });
    source.sessionAdded?.({ sessionId: 's2', cwd: '/repo' });
    host.emit('s1', { runs: 'invalid' });
    expect(host.published).toEqual([]);
    source.close();
    host.emit('s1', { runs: [run('runner-a')] });
    host.emit('s2', { runs: [run('runner-b')] });
    expect(host.published).toEqual([]);
  });

  it('claims the frame type the plugin manifest declares', () => {
    expect(createRunnersChannel().frameType).toBe('runner_runs');
  });
});
