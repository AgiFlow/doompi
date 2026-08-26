import { describe, expect, it } from 'vitest';
import { defineSessionStore } from '../src/services/sessionStore.ts';

interface DemoSession {
  items: string[];
  pinned: string | undefined;
}

const EMPTY: DemoSession = { items: [], pinned: undefined };

describe('defineSessionStore', () => {
  it('answers one shared empty record for null and unknown sessions', () => {
    const demo = defineSessionStore<DemoSession>(EMPTY);
    expect(demo.select(demo.store.state, null)).toBe(EMPTY);
    expect(demo.select(demo.store.state, 'ghost')).toBe(EMPTY);
    expect(demo.select(demo.store.state, null)).toBe(demo.select(demo.store.state, 'ghost'));
  });

  it('updates one session without touching the others and drops it whole', () => {
    const demo = defineSessionStore<DemoSession>(EMPTY);
    demo.update('s1', (current) => ({ ...current, items: ['a'] }));
    demo.update('s2', (current) => ({ ...current, pinned: 'b' }));
    expect(demo.select(demo.store.state, 's1')).toEqual({ items: ['a'], pinned: undefined });
    expect(demo.select(demo.store.state, 's2')).toEqual({ items: [], pinned: 'b' });

    demo.drop('s1');
    expect(demo.store.state.s1).toBeUndefined();
    expect(demo.select(demo.store.state, 's1')).toBe(EMPTY);
    expect(demo.select(demo.store.state, 's2').pinned).toBe('b');

    demo.reset();
    expect(demo.store.state).toEqual({});
  });

  it('publishes nothing when an updater returns the current record or a drop finds nothing', () => {
    const demo = defineSessionStore<DemoSession>(EMPTY);
    let published = 0;
    const subscription = demo.store.subscribe(() => {
      published += 1;
    });
    demo.update('s1', (current) => current);
    demo.drop('s1');
    expect(published).toBe(0);
    demo.update('s1', (current) => ({ ...current, items: ['a'] }));
    expect(published).toBe(1);
    subscription.unsubscribe();
  });

  it('wires a channel through parse, reduce, and drop', () => {
    const demo = defineSessionStore<DemoSession>(EMPTY);
    const channel = demo.channel<{ items: string[] }>({
      channel: 'demo_items',
      parse(input) {
        const items = (input as { items?: unknown } | null)?.items;
        return Array.isArray(items) && items.every((item) => typeof item === 'string') ? { items } : null;
      },
      // Ephemeral state reconciles against the payload: a pin survives only while its item is reported.
      reduce(current, { items }) {
        return {
          items,
          pinned: current.pinned !== undefined && items.includes(current.pinned) ? current.pinned : undefined,
        };
      },
    });
    expect(channel.channel).toBe('demo_items');
    expect(channel.parse('junk')).toBeNull();
    expect(channel.parse({ items: [1] })).toBeNull();

    demo.update('s1', (current) => ({ ...current, pinned: 'a' }));
    channel.apply('s1', channel.parse({ items: ['a', 'b'] }));
    expect(demo.select(demo.store.state, 's1')).toEqual({ items: ['a', 'b'], pinned: 'a' });
    channel.apply('s1', channel.parse({ items: ['b'] }));
    expect(demo.select(demo.store.state, 's1')).toEqual({ items: ['b'], pinned: undefined });

    channel.drop('s1');
    expect(demo.store.state.s1).toBeUndefined();
  });
});
