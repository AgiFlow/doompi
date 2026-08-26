import { describe, expect, it } from 'vitest';
import { defineSessionStore } from '../../src/services/sessionStore.ts';
import { driveChannel, hubChannelHarness } from '../../src/services/testing/channels.ts';
import type { HubChannelHost, WebHubChannel } from '../../src/types/webHub.ts';

interface Runs {
  items: string[];
}

const empty: Runs = { items: [] };

function runsStore() {
  const store = defineSessionStore<Runs>(empty);
  const channel = store.channel<{ items: string[] }>({
    channel: 'demo_runs',
    parse: (input) => {
      const items = (input as { items?: unknown } | null)?.items;
      return Array.isArray(items) && items.every((item) => typeof item === 'string') ? { items } : null;
    },
    reduce: (_current, payload) => ({ items: payload.items }),
  });
  return { store, channel };
}

describe('driving a session channel', () => {
  it('folds an accepted payload into the session it names', () => {
    const { store, channel } = runsStore();

    expect(driveChannel(channel, 's1', { items: ['a'] })).toEqual({ accepted: true });

    expect(store.select(store.store.state, 's1').items).toEqual(['a']);
    expect(store.select(store.store.state, 's2').items).toEqual([]);
  });

  it('applies nothing when the plugin rejects the payload', () => {
    const { store, channel } = runsStore();

    // The parse gate is the only boundary a plugin has against the wire, and a
    // test that called apply directly would step straight over it.
    expect(driveChannel(channel, 's1', 'junk')).toEqual({ accepted: false });
    expect(driveChannel(channel, 's1', { items: [1, 2] })).toEqual({ accepted: false });

    expect(store.store.state.s1).toBeUndefined();
  });

  it('drops the record when the host says the session is gone', () => {
    const { store, channel } = runsStore();
    driveChannel(channel, 's1', { items: ['a'] });

    channel.drop('s1');

    expect(store.store.state.s1).toBeUndefined();
  });
});

/** A hub source shaped the way a plugin's is: a snapshot plus live pushes. */
function runsHubChannel(): WebHubChannel {
  return {
    frameType: 'demo_runs',
    start(host: HubChannelHost) {
      const known = new Map(host.sessions().map((scope) => [scope.sessionId, scope.cwd]));
      let closed = false;
      return {
        payloadFor: (scope) => (known.has(scope.sessionId) ? { items: [known.get(scope.sessionId)] } : undefined),
        sessionAdded: (scope) => {
          known.set(scope.sessionId, scope.cwd);
          host.publish(scope.sessionId, { items: [scope.cwd] });
        },
        sessionRemoved: (sessionId) => {
          known.delete(sessionId);
          host.onNotice(`forgot ${sessionId}`);
        },
        threadJournal: (scope, threadId) => `${scope.cwd}/${threadId}.jsonl`,
        close: () => {
          closed = true;
          host.onNotice(`closed:${String(closed)}`);
        },
      };
    },
  };
}

describe('starting a hub channel against a real host', () => {
  it('answers the subscribe-time snapshot for a session the hub already had', () => {
    const harness = hubChannelHarness(runsHubChannel(), { sessions: [{ sessionId: 's1', cwd: '/repo' }] });

    expect(harness.snapshot('s1')).toEqual({ items: ['/repo'] });
    harness.close();
  });

  it('pushes for a session that appears after it started', () => {
    const harness = hubChannelHarness(runsHubChannel(), { sessions: [] });

    harness.addSession({ sessionId: 's2', cwd: '/other' });

    // The hub calls payloadFor once per subscriber and publishes afterwards; a
    // channel that answers only one of the two looks right in half the tests.
    expect(harness.published).toEqual([{ type: 'demo_runs', sessionId: 's2', payload: { items: ['/other'] } }]);
    expect(harness.snapshot('s2')).toEqual({ items: ['/other'] });
    harness.close();
  });

  it('forgets a session the hub removed and reports what it did', () => {
    const harness = hubChannelHarness(runsHubChannel());

    harness.removeSession('s1');

    expect(harness.snapshot('s1')).toBeUndefined();
    expect(harness.notices).toEqual(['forgot s1']);
    harness.close();
    expect(harness.notices).toContain('closed:true');
  });

  it('exposes the source itself for a channel with a thread journal', () => {
    const harness = hubChannelHarness(runsHubChannel());

    expect(harness.source.threadJournal?.({ sessionId: 's1', cwd: '/repo' }, 'run-3')).toBe('/repo/run-3.jsonl');
    harness.close();
  });
});
