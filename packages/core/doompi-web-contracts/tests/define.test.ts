import { describe, expect, it } from 'vitest';
import { defineSessionChannel, defineWebPlugin } from '../src/services/define.ts';
import type { SessionChannelContribution } from '../src/types/webPlugin.ts';

interface DemoPayload {
  items: string[];
}

describe('contract identity helpers', () => {
  it('returns the definition unchanged and erases the channel payload type', () => {
    const applied: Array<{ sessionId: string; payload: DemoPayload }> = [];
    const channel = defineSessionChannel<DemoPayload>({
      channel: 'demo_items',
      parse(input) {
        if (typeof input !== 'object' || input === null) return null;
        const items = (input as { items?: unknown }).items;
        return Array.isArray(items) && items.every((item) => typeof item === 'string') ? { items } : null;
      },
      apply(sessionId, payload) {
        applied.push({ sessionId, payload });
      },
      drop() {},
    });

    // The erased channel still runs the typed gate: bad input rejected, good applied.
    const erased: SessionChannelContribution = channel;
    expect(erased.parse('junk')).toBeNull();
    expect(erased.parse({ items: [1] })).toBeNull();
    const parsed = erased.parse({ items: ['a'] });
    expect(parsed).toEqual({ items: ['a'] });
    erased.apply('s1', parsed);
    expect(applied).toEqual([{ sessionId: 's1', payload: { items: ['a'] } }]);

    const plugin = defineWebPlugin({ id: 'demo', channels: [channel] });
    expect(plugin.id).toBe('demo');
    expect(plugin.channels).toHaveLength(1);
  });
});
