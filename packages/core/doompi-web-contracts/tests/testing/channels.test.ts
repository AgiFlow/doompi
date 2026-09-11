import { describe, expect, it } from 'vitest';
import { defineSessionStore } from '../../src/services/sessionStore.ts';
import { driveChannel } from '../../src/services/testing/channels.ts';

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
