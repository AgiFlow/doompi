import { describe, expect, it } from 'vitest';
import { defineSessionChannel, defineWebPlugin } from '../../src/exports/web';
import type {
  SessionChannelContribution,
  UserMessageActionContribution,
  UserMessageActionRunContext,
  WebPluginRuntime,
} from '../../src/exports/web';

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

  it('exposes the user-message action context through an optional plugin contribution', () => {
    const received: UserMessageActionRunContext[] = [];
    const action: UserMessageActionContribution = {
      id: 'capture',
      label: 'Capture',
      run: (context) => received.push(context),
    };
    const plugin = defineWebPlugin({ id: 'demo', userMessageActions: [action] });
    const context = { sessionId: 's1', messageId: 'm1', text: 'hello' };

    plugin.userMessageActions?.[0]?.run(context);

    expect(received).toEqual([context]);
  });

  it('requires a page hub connection subscription on plugin runtimes', () => {
    const listeners = new Set<() => void>();
    const runtime: WebPluginRuntime = {
      sendSessionFrame: () => undefined,
      sendHubFrame: () => undefined,
      invokeServerMethod: async () => undefined,
      onHubConnected(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    let connections = 0;
    const unsubscribe = runtime.onHubConnected(() => (connections += 1));

    for (const listener of listeners) listener();
    unsubscribe();
    for (const listener of listeners) listener();

    expect(connections).toBe(1);
  });
});
