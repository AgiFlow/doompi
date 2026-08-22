import { visibleWidth } from '@earendil-works/pi-tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '../../src/adapters/agents/types';
import {
  AgentCatalogComponent,
  type AgentCatalogOptions,
  agentResourceSummary,
  openAgentCatalog,
} from '../../src/adapters/pi/tui/agentCatalog';
import type {
  AgentCatalogEntry,
  AgentResourceProjection,
  ProjectedResource,
  ResourceTabProjection,
} from '../../src/adapters/pi/tui/agentResourceProjection';

const KEY_ENTER = '\r';
const KEY_ESCAPE = '\x1b';
const KEY_CTRL_C = '\x03';
const KEY_TAB = '\t';
const KEY_PAGE_DOWN = '\x1b[6~';

function agent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    description: `${name} description`,
    systemPromptMode: 'append',
    inheritProjectContext: true,
    inheritSkills: true,
    systemPrompt: `You are ${name}.`,
    source: 'plugin',
    filePath: `/agents/${name}.md`,
    ...overrides,
  };
}

function resources(names: readonly string[], detail?: string): ProjectedResource[] {
  return names.map((name) => (detail ? { name, detail } : { name }));
}

function tab(
  effective: readonly string[] = [],
  removed: readonly string[] = [],
  unresolved: readonly string[] = [],
): ResourceTabProjection {
  return {
    effective: resources(effective, 'effective provenance'),
    removed: resources(removed, 'parent policy reason'),
    unresolved: resources(unresolved, 'preview qualification'),
  };
}

interface ProjectionOverrides {
  tools?: ResourceTabProjection;
  skills?: ResourceTabProjection;
  extensions?: ResourceTabProjection;
  notice?: string;
  configuredOnly?: boolean;
  error?: string;
}

function projection(overrides: ProjectionOverrides = {}): AgentResourceProjection {
  return {
    tools: overrides.tools ?? tab(['read'], [], ['Request-specific internal tools']),
    skills: overrides.skills ?? tab(),
    extensions: overrides.extensions ?? tab(),
    notice:
      overrides.notice ??
      'Launch projection from the current parent-policy snapshot. Child loading may change qualified resources.',
    configuredOnly: overrides.configuredOnly ?? false,
    ...(overrides.error ? { error: overrides.error } : {}),
  };
}

function entry(
  name: string,
  agentOverrides: Partial<AgentConfig> = {},
  projectionOverrides: ProjectionOverrides = {},
): AgentCatalogEntry {
  return { agent: agent(name, agentOverrides), resources: projection(projectionOverrides) };
}

class FakeTui {
  rendered = 0;
  terminal = { rows: 18 };

  requestRender(): void {
    this.rendered += 1;
  }
}

function fakeTheme() {
  const identity = (_colour: string, text: string) => text;
  return {
    fg: identity,
    bg: identity,
    bold: (text: string) => text,
    inverse: (text: string) => text,
  } as never;
}

function fixture(entries: AgentCatalogEntry[], rows = 18, options: AgentCatalogOptions = {}) {
  const tui = new FakeTui();
  tui.terminal.rows = rows;
  const done = vi.fn();
  const component = new AgentCatalogComponent(tui, fakeTheme(), entries, done, options);
  const lines = (width = 100): string[] => component.render(width);
  const text = (width = 100): string => lines(width).join('\n');
  return { component, done, lines, text, tui };
}

function bodyLines(view: ReturnType<typeof fixture>, width: number): string[] {
  return view.lines(width).slice(3, -3);
}

function dividerPositions(line: string): number[] {
  const positions: number[] = [];
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '│') positions.push(visibleWidth(line.slice(0, index)));
  }
  return positions;
}

describe('agentResourceSummary', () => {
  it('distinguishes runtime-default tools from configured counts', () => {
    expect(agentResourceSummary(agent('ambient', { mcpDirectTools: ['search'], skills: ['docs'] }))).toBe(
      'tools default · configured: 1 MCP tool · 1 skill · 0 extensions',
    );
    expect(
      agentResourceSummary(agent('configured', { tools: [], extensions: ['one'], subagentOnlyExtensions: ['two'] })),
    ).toBe('configured: 0 tools · 0 MCP tools · 0 skills · 2 extensions');
  });
});

describe('AgentCatalogComponent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts with a sorted cursor list and the cursor agent already in the detail pane', () => {
    const view = fixture([entry('zeta'), entry('alpha')]);
    const text = view.text();

    expect(text).toContain('INSPECTING alpha');
    expect(text).toContain('1/2');
    expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('zeta'));
  });

  it('follows the cursor into the detail pane without an inspect step', () => {
    const view = fixture([entry('zeta'), entry('alpha')]);
    expect(view.text()).toContain('INSPECTING alpha');

    view.component.handleInput('j');
    const moved = view.text();
    expect(moved).toContain('INSPECTING zeta');
    expect(moved).toContain('2/2');
  });

  it('renders each roster row as a name line over its source and runtime', () => {
    const view = fixture([entry('agiflow-dispatcher', { source: 'plugin', runtime: 'pi' })]);
    const rows = bodyLines(view, 100).map((line) => line.slice(0, 30).trimEnd());

    const nameRow = rows.findIndex((line) => line.includes('agiflow-dispatcher'));
    expect(nameRow).toBeGreaterThanOrEqual(0);
    expect(rows[nameRow]).not.toContain('plugin');
    expect(rows[nameRow + 1]).toContain('plugin · pi');
  });

  it('pages the left cursor through a long catalog', () => {
    const entries = Array.from({ length: 20 }, (_, index) => entry(`agent-${String(index).padStart(2, '0')}`));
    const view = fixture(entries);
    view.text();

    view.component.handleInput(KEY_PAGE_DOWN);

    // Two lines per row, so a page is half the roster pane, not all of it.
    expect(view.text()).toContain('6/20');
  });

  it('cycles tools, skills, and extensions with Tab and retains compatibility shortcuts', () => {
    const view = fixture([
      entry(
        'package-dev',
        {},
        {
          tools: tab(['tool-effective']),
          skills: tab(['skill-effective']),
          extensions: tab(['extension-effective']),
        },
      ),
    ]);
    expect(view.text()).toContain('tool-effective');

    view.component.handleInput(KEY_TAB);
    expect(view.text()).toContain('skill-effective');
    view.component.handleInput(KEY_TAB);
    expect(view.text()).toContain('extension-effective');
    view.component.handleInput(KEY_TAB);
    expect(view.text()).toContain('tool-effective');

    view.component.handleInput('s');
    expect(view.text()).toContain('skill-effective');
    view.component.handleInput('e');
    expect(view.text()).toContain('extension-effective');
    view.component.handleInput('t');
    expect(view.text()).toContain('tool-effective');
  });

  it('uses lowercase j for the cursor and Shift+J/K only for detail scrolling', () => {
    const manyTools = Array.from({ length: 20 }, (_, index) => `tool-${String(index).padStart(2, '0')}`);
    const view = fixture([entry('alpha', {}, { tools: tab(manyTools) }), entry('beta')]);
    const top = view.text();

    view.component.handleInput('j');
    expect(view.text()).toContain('INSPECTING beta');
    expect(view.text()).toContain('2/2');

    view.component.handleInput('k');
    view.component.handleInput('J');
    expect(view.text()).not.toBe(top);
    view.component.handleInput('K');
    expect(view.text()).toContain('tool-00');
  });

  it('resets detail scrolling when the cursor moves to another agent', () => {
    const manyTools = Array.from({ length: 20 }, (_, index) => `tool-${String(index).padStart(2, '0')}`);
    const view = fixture([
      entry('alpha', {}, { tools: tab(manyTools) }),
      entry('beta', {}, { tools: tab(['beta-first']) }),
    ]);
    view.text();
    for (let index = 0; index < 12; index++) view.component.handleInput('J');

    view.component.handleInput('j');

    expect(view.text()).toContain('INSPECTING beta');
    expect(view.text()).toContain('beta-first');
  });

  it('clamps detail scrolling after a taller resize', () => {
    const manyTools = Array.from({ length: 20 }, (_, index) => `tool-${String(index).padStart(2, '0')}`);
    const view = fixture([entry('alpha', {}, { tools: tab(manyTools) })]);
    view.text();
    for (let index = 0; index < 35; index++) view.component.handleInput('J');
    expect(view.text()).toContain('tool-19');

    view.tui.terminal.rows = 70;
    const resized = view.lines(80);

    expect(resized).toHaveLength(70);
    expect(resized.every((line) => visibleWidth(line) <= 80)).toBe(true);
    expect(resized.join('\n')).toContain('tool-00');
    expect(resized.join('\n')).toContain('tool-19');
  });

  it('keeps one canonical footer legend stable across resource tabs and compact chrome', () => {
    const view = fixture([entry('alpha')]);
    const toolsFooter = view.lines().at(-2);

    view.component.handleInput(KEY_TAB);
    const skillsFooter = view.lines().at(-2);
    view.component.handleInput(KEY_TAB);
    const extensionsFooter = view.lines().at(-2);

    expect(skillsFooter).toBe(toolsFooter);
    expect(extensionsFooter).toBe(toolsFooter);
    expect(toolsFooter).toContain('move');
    expect(toolsFooter).toContain('run');
    expect(toolsFooter).toContain('↑↓');
    expect(toolsFooter).toContain('JK');
    expect(toolsFooter).not.toContain('↑↓/jk');
    expect(toolsFooter).not.toContain('J/K');
    expect(toolsFooter).toContain('1/1');

    view.tui.terminal.rows = 5;
    const compact = view.text();
    expect(compact).toContain('↑↓');
    expect(compact).toContain('JK');
    expect(compact).not.toContain('↑↓/jk');
    expect(compact).not.toContain('J/K');
  });

  it('renders effective, removed, unresolved, and per-agent error sections', () => {
    const view = fixture(
      [
        entry(
          'guarded',
          {},
          {
            tools: tab(['read'], ['write'], ['missing-server']),
            error: 'Could not resolve runtime extension fanout-child',
          },
        ),
      ],
      40,
    );
    const text = view.text();

    expect(text).toContain('PROJECTION ERROR');
    expect(text).toContain('fanout-child');
    expect(text).toContain('PROJECTED EFFECTIVE');
    expect(text).toContain('REMOVED BY PARENT');
    expect(text).toContain('UNRESOLVED AT PREVIEW');
    expect(text).toContain('parent policy reason');
    expect(text).toContain('preview qualification');
  });

  it('shows projection metadata, descriptions, notices, and external configured-only warnings', () => {
    const view = fixture([
      entry(
        'external',
        { runtime: 'claude', source: 'user', description: 'External specialist description' },
        {
          notice: "Configured values only. Runtime 'claude' does not use the Pi launch projection.",
          configuredOnly: true,
        },
      ),
    ]);
    const text = view.text();

    expect(text).toContain('INSPECTING external');
    expect(text).toContain('user · claude');
    expect(text).toContain('External specialist description');
    expect(text).toContain('Configured values only');
  });

  it('keeps the one-third divider and both panes at normal and narrow widths', () => {
    const view = fixture([
      entry(
        '\u001b[35m超長い-agent-name-🙂\u001b[0m',
        { description: 'A very long ANSI and Unicode description with wide glyphs 你好世界 and more text.' },
        { tools: tab(['\u001b[36m/path/到/resource🙂\u001b[0m'], ['write'], ['未知-selector']) },
      ),
    ]);

    const normal = view.lines(64);
    const narrow = view.lines(8);

    expect(normal.every((line) => visibleWidth(line) <= 64)).toBe(true);
    expect(narrow.every((line) => visibleWidth(line) <= 8)).toBe(true);
    expect(dividerPositions(bodyLines(view, 64)[0]!)).toEqual([0, 21, 63]);
    expect(dividerPositions(bodyLines(view, 8)[0]!)).toEqual([0, 3, 7]);
  });

  it('closes directly with Escape or Ctrl+C', () => {
    const inspected = fixture([entry('worker')]);
    inspected.component.handleInput(KEY_ESCAPE);
    expect(inspected.done).toHaveBeenCalledWith(undefined);

    const catalog = fixture([entry('worker')]);
    catalog.component.handleInput(KEY_CTRL_C);
    expect(catalog.done).toHaveBeenCalledWith(undefined);
  });

  it('renders an empty catalog safely and invalidates on state changes', () => {
    const empty = fixture([], 10);
    const lines = empty.lines(20);
    expect(lines).toHaveLength(10);
    expect(lines.every((line) => visibleWidth(line) <= 20)).toBe(true);
    expect(empty.text(60)).toContain('No enabled agents');

    const populated = fixture([entry('alpha'), entry('beta')]);
    populated.component.handleInput('j');
    populated.component.handleInput(KEY_TAB);
    expect(populated.tui.rendered).toBeGreaterThan(0);
  });

  it('launches the cursor agent from r and closes the overlay on the launch', () => {
    const launchAgent = vi.fn();
    const view = fixture([entry('alpha'), entry('beta')], 18, { launchAgent });

    view.component.handleInput('j');
    view.component.handleInput('r');
    const prompt = view.text();
    expect(prompt).toContain('LAUNCH TASK');
    expect(prompt).toContain('beta · fresh');
    expect(prompt).toContain('launch');

    for (const character of 'fix the flaky test') view.component.handleInput(character);
    view.component.handleInput(KEY_ENTER);

    expect(launchAgent).toHaveBeenCalledWith({ agent: 'beta', task: 'fix the flaky test', context: 'fresh' });
    // Closed, so the launcher's own reporting is not hidden behind the overlay.
    expect(view.done).toHaveBeenCalledWith(undefined);
  });

  it('sends Shift+R as a fork-context launch and edits the task with backspace', () => {
    const launchAgent = vi.fn();
    const view = fixture([entry('alpha')], 18, { launchAgent });

    view.component.handleInput('R');
    expect(view.text()).toContain('alpha · fork');
    for (const character of 'audit') view.component.handleInput(character);
    view.component.handleInput('\x7f');
    view.component.handleInput(KEY_ENTER);

    expect(launchAgent).toHaveBeenCalledWith({ agent: 'alpha', task: 'audi', context: 'fork' });
    expect(view.done).toHaveBeenCalledWith(undefined);
  });

  it('keeps the overlay open when the task prompt is cancelled or left empty', () => {
    const launchAgent = vi.fn();
    const view = fixture([entry('alpha')], 18, { launchAgent });

    view.component.handleInput('r');
    view.component.handleInput(KEY_ESCAPE);
    expect(view.done).not.toHaveBeenCalled();
    expect(view.text()).toContain('launch cancelled · no run started');

    view.component.handleInput('r');
    view.component.handleInput(KEY_ENTER);
    expect(view.text()).toContain('launch cancelled · a non-empty task is required');
    expect(launchAgent).not.toHaveBeenCalled();
  });

  it('reports the launch keys as unavailable when no launcher is attached', () => {
    const view = fixture([entry('alpha')]);

    view.component.handleInput('r');

    expect(view.text()).toContain('launch unavailable · no subagent launcher is attached');
    expect(view.text()).not.toContain('LAUNCH TASK');
  });

  it('ignores bounded cursor, detail, tab, and empty selection inputs', () => {
    const empty = fixture([]);
    empty.component.handleInput(KEY_ENTER);
    empty.component.handleInput('J');
    expect(empty.tui.rendered).toBe(0);

    const populated = fixture([entry('alpha')]);
    populated.component.handleInput('k');
    populated.component.handleInput('K');
    populated.component.handleInput('t');
    expect(populated.tui.rendered).toBe(0);
  });
});

describe('openAgentCatalog', () => {
  it('opens the projected entries with the shared fullscreen overlay options', async () => {
    const entries = [entry('alpha')];
    const custom = vi.fn(
      async (
        factory: (tui: FakeTui, theme: ReturnType<typeof fakeTheme>, keybindings: unknown, done: () => void) => unknown,
        options: unknown,
      ) => {
        expect(factory(new FakeTui(), fakeTheme(), {}, vi.fn())).toBeInstanceOf(AgentCatalogComponent);
        expect(options).toMatchObject({ overlay: true, overlayOptions: { width: '100%', maxHeight: '100%' } });
      },
    );

    await openAgentCatalog({ ui: { custom } } as never, entries);

    expect(custom).toHaveBeenCalledOnce();
  });
});
