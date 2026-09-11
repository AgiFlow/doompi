import type {
  DoomDirectEventBus,
  DoomHubChannelHost as HubChannelHost,
} from '@agimon-ai/doompi-extension-contracts/hub-channel';
import { describe, expect, it } from 'vitest';
import { createSubagentCatalogChannel } from '../../src/adapters/webSubagentCatalogChannel.ts';
import type { CatalogAgentInput } from '../../src/services/webSubagentCatalog.ts';
import type { SubagentCatalogPayload } from '../../src/types/webSubagents.ts';

interface FakeHost extends HubChannelHost {
  published: Array<{ sessionId: string; payload: SubagentCatalogPayload }>;
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
    emit: (sessionId, payload) => directEvents.publish('subagent_catalog', sessionId, payload),
    sessions: () => [{ sessionId: 's1', cwd: '/w' }],
    directEvents,
    publish: (sessionId, payload) => published.push({ sessionId, payload: payload as SubagentCatalogPayload }),
    requestSessionApi: () => Promise.resolve(Response.json({ error: 'must not be called' }, { status: 500 })),
    onNotice: () => undefined,
  };
}

const agent = (name: string, source: CatalogAgentInput['source']): CatalogAgentInput => ({
  name,
  source,
  description: `${name} does things`,
  filePath: `/x/${name}.md`,
});

const payload = (names: string[]): SubagentCatalogPayload => ({
  cwd: '/w',
  agents: names.map((name, index) => ({
    ...agent(name, index === 0 ? 'project' : 'user'),
    fallbackModels: [],
    tools: [],
    skills: [],
    extensions: [],
    defaultContext: 'fresh',
  })),
  models: ['t1'],
});

describe('the subagent catalog hub channel', () => {
  it('replays and publishes the session-owned catalog without polling', () => {
    const host = fakeHost();
    host.emit('s1', payload(['reviewer']));
    const source = createSubagentCatalogChannel().start(host);
    source.sessionAdded?.({ sessionId: 's1', cwd: '/w' });

    expect(host.published).toHaveLength(1);
    expect(source.payloadFor({ sessionId: 's1', cwd: '/w' })).toEqual(payload(['reviewer']));

    host.emit('s1', payload(['reviewer', 'scout']));
    expect(host.published).toHaveLength(2);
    expect(source.payloadFor({ sessionId: 's1', cwd: '/w' })).toEqual(payload(['reviewer', 'scout']));

    source.sessionRemoved?.('s1');
    host.emit('s1', payload(['after-removal']));
    expect(host.published).toHaveLength(2);
    expect(source.payloadFor({ sessionId: 's1', cwd: '/w' })).toBeUndefined();
    source.close();
  });

  it('ignores malformed or cross-scope events and closes its subscription', () => {
    const host = fakeHost();
    const source = createSubagentCatalogChannel().start(host);
    source.sessionAdded?.({ sessionId: 's1', cwd: '/w' });

    host.emit('s1', { cwd: '/w', agents: 'invalid', models: [] });
    host.emit('s1', { cwd: '/elsewhere', agents: [], models: [] });
    expect(host.published).toEqual([]);

    source.close();
    host.emit('s1', payload(['late']));
    expect(host.published).toEqual([]);
  });
});
