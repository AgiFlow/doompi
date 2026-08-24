import { defineSessionChannel, defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dispatchChannelFrame,
  dropPluginSessionData,
  installWebPlugins,
  paletteCommands,
  pluginLeaderBindings,
  pluginToolRenderer,
  resetWebPlugins,
  startWebPlugins,
  surfaceContributions,
  webTabs,
} from '../../src/web/lib/pluginRegistry.ts';

interface ItemsPayload {
  items: string[];
}

function Panel(): null {
  return null;
}

function itemsChannel(log: string[], channel = 'demo_items') {
  return defineSessionChannel<ItemsPayload>({
    channel,
    parse(input) {
      if (typeof input !== 'object' || input === null) return null;
      const items = (input as { items?: unknown }).items;
      return Array.isArray(items) ? { items: items.filter((item) => typeof item === 'string') as string[] } : null;
    },
    apply(sessionId, payload) {
      log.push(`apply:${channel}:${sessionId}:${payload.items.join(',')}`);
    },
    drop(sessionId) {
      log.push(`drop:${channel}:${sessionId}`);
    },
  });
}

afterEach(() => resetWebPlugins());

describe('the web plugin registry', () => {
  it('serves a tool renderer by tool name and refuses a second claim on the same tool', () => {
    const renderer = { tools: ['bash', 'read'], call: Panel };
    installWebPlugins([defineWebPlugin({ id: 'tools', toolRenderers: [renderer] })]);
    expect(pluginToolRenderer('bash')).toBe(renderer);
    expect(pluginToolRenderer('read')).toBe(renderer);
    expect(pluginToolRenderer('edit')).toBeUndefined();

    resetWebPlugins();
    const family = {
      tools: [],
      matches: (name: string, statuses: Readonly<Record<string, string>>) =>
        (statuses['doom-mcp'] ?? '').split(',').some((server) => name.startsWith(`${server}_`)),
      call: Panel,
    };
    installWebPlugins([
      defineWebPlugin({ id: 'exact', toolRenderers: [{ tools: ['github_issues'], result: Panel }] }),
      defineWebPlugin({ id: 'family', toolRenderers: [family] }),
    ]);
    // The exact claim wins over the matcher; the matcher covers the rest of the family.
    expect(pluginToolRenderer('github_issues', { 'doom-mcp': 'github' })?.result).toBe(Panel);
    expect(pluginToolRenderer('github_search', { 'doom-mcp': 'github' })).toBe(family);
    expect(pluginToolRenderer('github_search', {})).toBeUndefined();
    expect(pluginToolRenderer('github_search')).toBeUndefined();

    resetWebPlugins();
    expect(() =>
      installWebPlugins([
        defineWebPlugin({ id: 'one', toolRenderers: [{ tools: ['bash'], call: Panel }] }),
        defineWebPlugin({ id: 'two', toolRenderers: [{ tools: ['bash'], result: Panel }] }),
      ]),
    ).toThrow(/'two' claims tool 'bash'/);
  });

  it('installs contributions once and serves them per surface', () => {
    installWebPlugins([
      defineWebPlugin({
        id: 'demo',
        tabs: [{ id: 'demo', label: 'demo', panel: Panel }],
        overlays: [{ id: 'demo-overlay', component: Panel }],
        railSections: [{ id: 'demo-rail', component: Panel }],
        selectionBarItems: [{ id: 'demo-selection', component: Panel }],
        activitySections: [{ id: 'demo-activity', component: Panel }],
        paletteCommands: [{ id: 'demo-command', title: 'demo command', run: () => undefined }],
      }),
    ]);
    expect(webTabs().map((tab) => tab.id)).toEqual(['demo']);
    expect(surfaceContributions('overlay').map((entry) => entry.id)).toEqual(['demo-overlay']);
    expect(surfaceContributions('rail').map((entry) => entry.id)).toEqual(['demo-rail']);
    expect(surfaceContributions('selectionBar').map((entry) => entry.id)).toEqual(['demo-selection']);
    expect(surfaceContributions('activity').map((entry) => entry.id)).toEqual(['demo-activity']);
    expect(paletteCommands().map((command) => command.id)).toEqual(['demo-command']);

    expect(() => installWebPlugins([])).toThrow(/already installed/);
  });

  it('collects leader bindings in install order and refuses keys the TUI would', () => {
    const group = { key: 'w', label: 'workflows' };
    installWebPlugins([
      defineWebPlugin({
        id: 'workflows',
        leaderBindings: [
          { id: 'w.runs', path: [group, { key: 'r', label: 'runs' }], run: () => undefined },
          { id: 'w.toggle', path: [group, { key: 'e', label: 'toggle' }], command: 'minor workflow' },
        ],
      }),
      defineWebPlugin({
        id: 'goal',
        leaderBindings: [
          {
            id: 'g.toggle',
            path: [
              { key: 'g', label: 'goal' },
              { key: 'e', label: 'toggle' },
            ],
            command: 'minor goal',
          },
        ],
      }),
    ]);
    expect(pluginLeaderBindings().map((binding) => binding.id)).toEqual(['w.runs', 'w.toggle', 'g.toggle']);

    resetWebPlugins();
    expect(() =>
      installWebPlugins([
        defineWebPlugin({ id: 'bad', leaderBindings: [{ id: 'x', path: [{ key: 'W', label: 'w' }], command: 'w' }] }),
      ]),
    ).toThrow(/key 'W' must be one lowercase letter or digit/);
    resetWebPlugins();
    expect(() =>
      installWebPlugins([defineWebPlugin({ id: 'bad', leaderBindings: [{ id: 'x', path: [], command: 'w' }] })]),
    ).toThrow(/needs 1 to 4 path segments/);
    resetWebPlugins();
    expect(() =>
      installWebPlugins([
        defineWebPlugin({ id: 'bad', leaderBindings: [{ id: 'x', path: [{ key: 'a', label: ' ' }], command: 'w' }] }),
      ]),
    ).toThrow(/unlabeled segment/);
  });

  it('rejects duplicate plugin, tab, and channel ids', () => {
    const log: string[] = [];
    expect(() => installWebPlugins([defineWebPlugin({ id: 'a' }), defineWebPlugin({ id: 'a' })])).toThrow(
      /Duplicate web plugin id 'a'/,
    );
    resetWebPlugins();
    expect(() =>
      installWebPlugins([
        defineWebPlugin({ id: 'a', tabs: [{ id: 't', label: 't', panel: Panel }] }),
        defineWebPlugin({ id: 'b', tabs: [{ id: 't', label: 't', panel: Panel }] }),
      ]),
    ).toThrow(/Duplicate web plugin tab id 't'/);
    resetWebPlugins();
    expect(() =>
      installWebPlugins([
        defineWebPlugin({ id: 'a', channels: [itemsChannel(log)] }),
        defineWebPlugin({ id: 'b', channels: [itemsChannel(log)] }),
      ]),
    ).toThrow(/Duplicate web plugin channel 'demo_items'/);
  });

  it('routes frames through the owning channel and its parse gate', () => {
    const log: string[] = [];
    installWebPlugins([defineWebPlugin({ id: 'demo', channels: [itemsChannel(log)] })]);

    expect(dispatchChannelFrame({ type: 'demo_items', sessionId: 's1', payload: { items: ['a', 1, 'b'] } })).toBe(true);
    expect(log).toEqual(['apply:demo_items:s1:a,b']);

    // Malformed payloads are claimed by the channel but rejected by parse.
    expect(dispatchChannelFrame({ type: 'demo_items', sessionId: 's1', payload: 'junk' })).toBe(true);
    expect(log).toHaveLength(1);

    // Unknown channels and malformed envelopes stay unclaimed.
    expect(dispatchChannelFrame({ type: 'elsewhere', sessionId: 's1', payload: {} })).toBe(false);
    expect(dispatchChannelFrame({ type: 'demo_items', payload: {} })).toBe(false);
  });

  it('fans session teardown to every channel', () => {
    const log: string[] = [];
    installWebPlugins([
      defineWebPlugin({ id: 'a', channels: [itemsChannel(log, 'one')] }),
      defineWebPlugin({ id: 'b', channels: [itemsChannel(log, 'two')] }),
    ]);
    dropPluginSessionData('s9');
    expect(log).toEqual(['drop:one:s9', 'drop:two:s9']);
  });

  it('starts runtimes in install order and disposes in reverse', () => {
    const log: string[] = [];
    installWebPlugins([
      defineWebPlugin({
        id: 'a',
        start: () => {
          log.push('start:a');
          return () => log.push('stop:a');
        },
      }),
      defineWebPlugin({
        id: 'b',
        start: () => {
          log.push('start:b');
          return () => log.push('stop:b');
        },
      }),
    ]);
    const stop = startWebPlugins({ sendSessionFrame: () => undefined, sendHubFrame: () => undefined });
    stop();
    expect(log).toEqual(['start:a', 'start:b', 'stop:b', 'stop:a']);
  });
});
