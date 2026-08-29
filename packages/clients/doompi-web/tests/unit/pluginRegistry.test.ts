import { defineSessionChannel, defineSlot, defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { leaderGroup } from '../../src/web/lib/leaderTree.ts';
import {
  activityGroupSlot,
  dispatchChannelFrame,
  dropPluginSessionData,
  HOST_SLOTS,
  installWebPlugins,
  paletteCommands,
  pluginActivityGroups,
  pluginLeaderBindings,
  pluginMinorModes,
  pluginRepositorySettingsPanels,
  pluginSelectionAxes,
  pluginToolRenderer,
  resetWebPlugins,
  slotFills,
  startWebPlugins,
  webPluginDiagnostics,
  webTabs,
} from '../../src/web/lib/pluginRegistry.ts';
import { settingsSections } from '../../src/web/lib/settingsSections.ts';
interface ItemsPayload {
  items: string[];
}

function Panel(): null {
  return null;
}

function Other(): null {
  return null;
}

function itemsChannel(log: string[], channel = 'demo_items', tag = channel) {
  return defineSessionChannel<ItemsPayload>({
    channel,
    parse(input) {
      if (typeof input !== 'object' || input === null) return null;
      const items = (input as { items?: unknown }).items;
      return Array.isArray(items) ? { items: items.filter((item) => typeof item === 'string') as string[] } : null;
    },
    apply(sessionId, payload) {
      log.push(`apply:${tag}:${sessionId}:${payload.items.join(',')}`);
    },
    drop(sessionId) {
      log.push(`drop:${tag}:${sessionId}`);
    },
  });
}

const kinds = () => webPluginDiagnostics().map((entry) => [entry.pluginId, entry.kind]);

afterEach(() => resetWebPlugins());

describe('the web plugin registry', () => {
  it('serves a tool renderer by tool name and keeps the first claim, recording the second', () => {
    const renderer = { tools: ['bash', 'read'], message: Panel };
    installWebPlugins([defineWebPlugin({ id: 'tools', toolRenderers: [renderer] })]);
    expect(pluginToolRenderer('bash')).toBe(renderer);
    expect(pluginToolRenderer('read')).toBe(renderer);
    expect(pluginToolRenderer('edit')).toBeUndefined();

    resetWebPlugins();
    const family = {
      tools: [],
      matches: (name: string, statuses: Readonly<Record<string, string>>) =>
        (statuses['doom-mcp'] ?? '').split(',').some((server) => name.startsWith(`${server}_`)),
      message: Panel,
    };
    installWebPlugins([
      defineWebPlugin({ id: 'exact', toolRenderers: [{ tools: ['github_issues'], message: Panel }] }),
      defineWebPlugin({ id: 'family', toolRenderers: [family] }),
    ]);
    // The exact claim wins over the matcher; the matcher covers the rest of the family.
    expect(pluginToolRenderer('github_issues', { 'doom-mcp': 'github' })?.message).toBe(Panel);
    expect(pluginToolRenderer('github_search', { 'doom-mcp': 'github' })).toBe(family);
    expect(pluginToolRenderer('github_search', {})).toBeUndefined();
    expect(pluginToolRenderer('github_search')).toBeUndefined();

    resetWebPlugins();
    const first = { tools: ['bash'], message: Panel };
    const second = { tools: ['bash', 'edit'], message: Other };
    installWebPlugins([
      defineWebPlugin({ id: 'one', toolRenderers: [first] }),
      defineWebPlugin({ id: 'two', toolRenderers: [second] }),
    ]);
    // A second claim on the same tool is a diagnostic, not a failure: the
    // first keeps the tool and the second still gets the names nobody holds.
    expect(pluginToolRenderer('bash')).toBe(first);
    expect(pluginToolRenderer('edit')).toBe(second);
    expect(kinds()).toEqual([['two', 'duplicate-tool']]);
    expect(webPluginDiagnostics()[0]?.message).toContain("tool 'bash' is already provided by 'one'");
  });

  it('installs contributions once and serves them per host slot', () => {
    installWebPlugins([
      defineWebPlugin({
        id: 'demo',
        tabs: [{ id: 'demo', label: 'demo', panel: Panel }],
        overlays: [{ id: 'demo-overlay', component: Panel }],
        railSections: [{ id: 'demo-rail', component: Panel }],
        selectionBarItems: [{ id: 'demo-selection', component: Panel }],
        composerActions: [{ id: 'demo-composer', component: Panel }],
        activitySections: [{ id: 'demo-activity', component: Panel }],
        paletteCommands: [{ id: 'demo-command', title: 'demo command', run: () => undefined }],
      }),
    ]);
    expect(webTabs().map((tab) => tab.id)).toEqual(['demo']);
    expect(slotFills(HOST_SLOTS.overlay).map((fill) => fill.id)).toEqual(['demo-overlay']);
    expect(slotFills(HOST_SLOTS.rail).map((fill) => fill.id)).toEqual(['demo-rail']);
    expect(slotFills(HOST_SLOTS.selectionBar).map((fill) => fill.id)).toEqual(['demo-selection']);
    expect(slotFills(HOST_SLOTS.composerActions).map((fill) => fill.id)).toEqual(['demo-composer']);
    // No group is named demo-activity, so the section lands in the activity tail.
    expect(slotFills(HOST_SLOTS.activity).map((fill) => [fill.pluginId, fill.id, fill.order])).toEqual([
      ['demo', 'demo-activity', 1000],
    ]);
    expect(slotFills('nobody.declared')).toEqual([]);
    expect(paletteCommands().map((command) => command.id)).toEqual(['demo-command']);
    expect(webPluginDiagnostics()).toEqual([]);

    expect(() => installWebPlugins([])).toThrow(/already installed/);
  });

  it('orders repository management panels without sharing repository ownership with plugins', () => {
    installWebPlugins([
      defineWebPlugin({
        id: 'later',
        repositorySettingsPanel: { label: 'later', detail: 'later panel', order: 20, component: Other },
      }),
      defineWebPlugin({
        id: 'first',
        repositorySettingsPanel: { label: 'first', detail: 'first panel', order: 10, component: Panel },
      }),
    ]);

    expect(pluginRepositorySettingsPanels()).toEqual([
      { pluginId: 'first', label: 'first', detail: 'first panel', order: 10, component: Panel },
      { pluginId: 'later', label: 'later', detail: 'later panel', order: 20, component: Other },
    ]);
  });

  it('separates general sections from repository defaults and package panels', () => {
    installWebPlugins([
      defineWebPlugin({
        id: 'mcp',
        repositorySettingsPanel: { label: 'MCP servers', detail: 'servers and authorization', component: Panel },
      }),
      defineWebPlugin({
        id: 'planning',
        settingsSections: [{ id: 'planning', label: 'planning', detail: 'plan models', fields: [] }],
      }),
    ]);

    expect(settingsSections('general').map((section) => section.id)).toEqual([
      'providers',
      'appearance',
      'notifications',
      'remote',
      'plugins',
      'planning',
    ]);
    expect(settingsSections('repository').map((section) => section.id)).toEqual(['repositories', 'repository-mcp']);
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
    expect(webPluginDiagnostics()).toEqual([]);

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

  it('lets a later plugin take over a leader leaf and keeps the first group label, recording both', () => {
    installWebPlugins([
      defineWebPlugin({
        id: 'first',
        leaderBindings: [
          {
            id: 'first.enter',
            path: [
              { key: 'g', label: 'goal' },
              { key: 'e', label: 'enter' },
            ],
            command: 'one',
          },
        ],
      }),
      defineWebPlugin({
        id: 'second',
        leaderBindings: [
          {
            id: 'second.toggle',
            path: [
              { key: 'g', label: 'goals' },
              { key: 'e', label: 'toggle' },
            ],
            command: 'two',
          },
        ],
      }),
    ]);
    // The tree the palette builds honors the same rule the TUI documents.
    const menu = leaderGroup(pluginLeaderBindings(), ['g']);
    expect(menu?.label).toBe('goal');
    expect(menu?.options[0]?.binding?.id).toBe('second.toggle');
    // Reported in the order the tree walk meets them: the group segment before its leaf.
    expect(kinds()).toEqual([
      ['second', 'leader-group-label'],
      ['first', 'leader-leaf-override'],
    ]);
  });

  it('throws when one plugin declares the same tab or tool twice', () => {
    expect(() =>
      installWebPlugins([
        defineWebPlugin({
          id: 'twice',
          tabs: [
            { id: 't', label: 'one', panel: Panel },
            { id: 't', label: 'two', panel: Other },
          ],
        }),
      ]),
    ).toThrow(/'twice' declares tab 't' twice/);
    resetWebPlugins();
    expect(() =>
      installWebPlugins([
        defineWebPlugin({ id: 'twice', toolRenderers: [{ tools: ['bash', 'bash'], message: Panel }] }),
      ]),
    ).toThrow(/'twice' declares tool 'bash' twice/);
  });

  it('throws when one plugin binds the same leader leaf twice', () => {
    expect(() =>
      installWebPlugins([
        defineWebPlugin({
          id: 'twice',
          leaderBindings: [
            { id: 'a', path: [{ key: 'g', label: 'goal' }], command: 'one' },
            { id: 'b', path: [{ key: 'g', label: 'goal' }], command: 'two' },
          ],
        }),
      ]),
    ).toThrow(/'twice' binds Leader Space 'g' twice/);
  });

  it('keeps the first of duplicate plugin, tab, and channel ids and records the rest', () => {
    const log: string[] = [];
    installWebPlugins([
      defineWebPlugin({ id: 'a', tabs: [{ id: 't', label: 'first', panel: Panel }], channels: [itemsChannel(log)] }),
      defineWebPlugin({
        id: 'b',
        tabs: [{ id: 't', label: 'second', panel: Panel }],
        channels: [itemsChannel(log, 'demo_items', 'b')],
      }),
      defineWebPlugin({ id: 'a', tabs: [{ id: 'u', label: 'ghost', panel: Panel }] }),
    ]);
    expect(webTabs().map((tab) => [tab.id, tab.label])).toEqual([['t', 'first']]);
    expect(dispatchChannelFrame({ type: 'demo_items', sessionId: 's1', payload: { items: ['x'] } })).toBe(true);
    expect(log).toEqual(['apply:demo_items:s1:x']);
    expect(kinds()).toEqual([
      ['b', 'duplicate-tab'],
      ['b', 'duplicate-channel'],
      ['a', 'duplicate-plugin'],
    ]);
  });

  it('keeps the first of duplicate group, mode, axis, and palette command names and records the rest', () => {
    installWebPlugins([
      defineWebPlugin({
        id: 'a',
        activityGroups: [{ name: 'agents', keys: 'a r', statusKey: 'x', order: 10 }],
        minorModes: [{ name: 'plan', keys: 'p e', order: 10 }],
        selectionAxes: [{ name: 'profile', command: 'profile', statusKey: 'p', emptyLabel: 'none', order: 10 }],
        paletteCommands: [{ id: 'go', title: 'go', run: () => undefined }],
      }),
      defineWebPlugin({
        id: 'b',
        activityGroups: [{ name: 'agents', keys: 'b b', statusKey: 'y', order: 1 }],
        minorModes: [{ name: 'plan', keys: 'q q', order: 1 }],
        selectionAxes: [{ name: 'profile', command: 'other', statusKey: 'q', emptyLabel: 'zero', order: 1 }],
        paletteCommands: [{ id: 'go', title: 'other go', run: () => undefined }],
      }),
    ]);
    expect(pluginActivityGroups().map((group) => group.keys)).toEqual(['a r']);
    expect(pluginMinorModes().map((mode) => mode.keys)).toEqual(['p e']);
    expect(pluginSelectionAxes().map((axis) => axis.command)).toEqual(['profile']);
    expect(paletteCommands().map((command) => command.title)).toEqual(['go']);
    expect(kinds()).toEqual([
      ['b', 'duplicate-palette-command'],
      ['b', 'duplicate-selection-axis'],
      ['b', 'duplicate-minor-mode'],
      ['b', 'duplicate-activity-group'],
    ]);
  });

  it('places fills into a slot another plugin declared whichever installs first, ordered by order, pluginId, id', () => {
    const owner = defineWebPlugin({ id: 'owner', slots: [defineSlot({ slot: 'owner.items' })] });
    const filler = defineWebPlugin({
      id: 'filler',
      fills: [
        { slot: 'owner.items', id: 'late', order: 20, component: Panel },
        { slot: 'owner.items', id: 'early', order: 5, component: Panel },
      ],
    });
    const another = defineWebPlugin({
      id: 'another',
      fills: [{ slot: 'owner.items', id: 'zed', order: 20, component: Other }],
    });
    const expected = [
      ['filler', 'early', 5],
      ['another', 'zed', 20],
      ['filler', 'late', 20],
    ];

    installWebPlugins([filler, another, owner]);
    expect(slotFills('owner.items').map((fill) => [fill.pluginId, fill.id, fill.order])).toEqual(expected);
    expect(webPluginDiagnostics()).toEqual([]);

    resetWebPlugins();
    installWebPlugins([owner, another, filler]);
    expect(slotFills('owner.items').map((fill) => [fill.pluginId, fill.id, fill.order])).toEqual(expected);
    expect(webPluginDiagnostics()).toEqual([]);
  });

  it("gates data fills through the owner's parse and records a rejected fill", () => {
    const badges = defineSlot<{ label: string }>({
      slot: 'owner.badges',
      parse(input) {
        const label = (input as { label?: unknown } | null)?.label;
        return typeof label === 'string' ? { label: label.toUpperCase() } : null;
      },
    });
    installWebPlugins([
      defineWebPlugin({ id: 'owner', slots: [badges] }),
      defineWebPlugin({
        id: 'filler',
        fills: [
          { slot: 'owner.badges', id: 'ok', data: { label: 'hi' } },
          { slot: 'owner.badges', id: 'bad', data: { label: 3 } },
        ],
      }),
    ]);
    // The parsed value, not the raw one, is what the owner reads back.
    expect(slotFills('owner.badges').map((fill) => [fill.id, fill.data])).toEqual([['ok', { label: 'HI' }]]);
    expect(kinds()).toEqual([['filler', 'rejected-fill']]);
  });

  it('records a fill into a slot nobody declared as an orphan and places nothing', () => {
    installWebPlugins([
      defineWebPlugin({ id: 'filler', fills: [{ slot: 'absent.items', id: 'one', component: Panel }] }),
    ]);
    expect(slotFills('absent.items')).toEqual([]);
    expect(kinds()).toEqual([['filler', 'orphan-fill']]);
    expect(webPluginDiagnostics()[0]?.message).toContain("slot 'absent.items', which no installed plugin declares");
  });

  it('throws on a reserved plugin id, a slot outside the plugin namespace, and malformed fills', () => {
    expect(() => installWebPlugins([defineWebPlugin({ id: 'activity' })])).toThrow(/reserved for a host slot/);
    resetWebPlugins();
    expect(() =>
      installWebPlugins([defineWebPlugin({ id: 'owner', slots: [defineSlot({ slot: 'other.items' })] })]),
    ).toThrow(/must be named 'owner\.<name>'/);
    resetWebPlugins();
    expect(() =>
      installWebPlugins([defineWebPlugin({ id: 'owner', slots: [defineSlot({ slot: 'owner.' })] })]),
    ).toThrow(/must be named 'owner\.<name>'/);
    resetWebPlugins();
    expect(() =>
      installWebPlugins([
        defineWebPlugin({ id: 'owner', slots: [defineSlot({ slot: 'owner.a' }), defineSlot({ slot: 'owner.a' })] }),
      ]),
    ).toThrow(/declares slot 'owner\.a' twice/);
    resetWebPlugins();
    expect(() =>
      installWebPlugins([
        defineWebPlugin({
          id: 'filler',
          fills: [
            { slot: 'x.y', id: 'one', component: Panel },
            { slot: 'x.y', id: 'one', component: Other },
          ],
        }),
      ]),
    ).toThrow(/fills 'x\.y' with id 'one' twice/);
    resetWebPlugins();
    expect(() => installWebPlugins([defineWebPlugin({ id: 'filler', fills: [{ slot: 'x.y', id: 'one' }] })])).toThrow(
      /neither a component nor data/,
    );
    resetWebPlugins();
    expect(() =>
      installWebPlugins([defineWebPlugin({ id: 'filler', fills: [{ slot: 'x.y', id: '', component: Panel }] })]),
    ).toThrow(/empty id/);
  });

  it("routes an activity section into its group's keyed slot, from any plugin, and the rest into the activity tail", () => {
    installWebPlugins([
      // The section installs before the plugin that declares its group.
      defineWebPlugin({
        id: 'runner',
        activitySections: [
          { id: 'agents', component: Other },
          { id: 'loose', component: Other },
        ],
      }),
      defineWebPlugin({
        id: 'team',
        activityGroups: [{ name: 'agents', keys: 'a r', statusKey: 'doom-team-agents' }],
        activitySections: [{ id: 'agents', component: Panel }],
      }),
    ]);
    expect(slotFills(activityGroupSlot('agents')).map((fill) => [fill.pluginId, fill.component])).toEqual([
      ['runner', Other],
      ['team', Panel],
    ]);
    expect(slotFills(HOST_SLOTS.activity).map((fill) => [fill.pluginId, fill.id])).toEqual([['runner', 'loose']]);
    expect(webPluginDiagnostics()).toEqual([]);
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
    const stop = startWebPlugins({
      sendSessionFrame: () => undefined,
      sendHubFrame: () => undefined,
      onHubConnected: () => () => undefined,
    });
    stop();
    expect(log).toEqual(['start:a', 'start:b', 'stop:b', 'stop:a']);
  });
});
