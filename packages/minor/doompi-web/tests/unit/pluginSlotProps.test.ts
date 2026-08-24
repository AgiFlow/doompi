import { defineSlot, defineWebPlugin, type WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { isValidElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installWebPlugins, resetWebPlugins } from '../../src/web/lib/pluginRegistry.ts';
import { pluginSlotProps } from '../../src/web/lib/pluginSlotProps.ts';

function Panel(): null {
  return null;
}

function Nested(): null {
  return null;
}

afterEach(() => resetWebPlugins());

describe('pluginSlotProps', () => {
  it("renders a slot's component fills with the same props and reads a data slot through its handle", () => {
    const badges = defineSlot<{ label: string }>({
      slot: 'owner.badges',
      parse(input) {
        const label = (input as { label?: unknown } | null)?.label;
        return typeof label === 'string' ? { label } : null;
      },
    });
    installWebPlugins([
      defineWebPlugin({ id: 'owner', slots: [defineSlot({ slot: 'owner.items' }), badges] }),
      defineWebPlugin({
        id: 'filler',
        fills: [
          { slot: 'owner.items', id: 'two', order: 2, component: Nested },
          { slot: 'owner.items', id: 'one', order: 1, component: Panel },
          { slot: 'owner.badges', id: 'b', data: { label: 'beta' } },
          { slot: 'owner.badges', id: 'a', order: 1, data: { label: 'alpha' } },
        ],
      }),
    ]);
    const opened: Array<string | null> = [];
    const props = pluginSlotProps('s1', (tabId) => opened.push(tabId));

    const rendered = props.renderSlot('owner.items') as ReactElement<WebPluginSlotProps>[];
    expect(rendered.map((element) => [isValidElement(element), element.type, element.key])).toEqual([
      [true, Panel, 'filler:one'],
      [true, Nested, 'filler:two'],
    ]);
    // Every fill receives the owner's own props, so a fill can render its own slots.
    expect(rendered[0]?.props.sessionId).toBe('s1');
    expect(rendered[0]?.props.renderSlot).toBe(props.renderSlot);
    rendered[0]?.props.openTab('subagents');
    expect(opened).toEqual(['subagents']);
    expect(typeof props.sendSessionFrame).toBe('function');

    expect(props.slotData(badges)).toEqual([
      { pluginId: 'filler', id: 'a', order: 1, data: { label: 'alpha' } },
      { pluginId: 'filler', id: 'b', order: 1000, data: { label: 'beta' } },
    ]);
    // Component fills are not data, data fills are not components.
    expect(props.slotData(defineSlot({ slot: 'owner.items' }))).toEqual([]);
    expect(props.renderSlot('owner.badges')).toEqual([]);
    expect(props.renderSlot('nobody.home')).toEqual([]);
  });
});
