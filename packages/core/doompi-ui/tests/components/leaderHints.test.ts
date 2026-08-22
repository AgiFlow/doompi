import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { LeaderHints, MAX_WIDGET_LINES } from '../../src/exports/components/leaderHints.ts';
import type { LeaderSnapshot } from '../../src/exports/uiState.ts';

const theme = {
  bg: (_color: string, text: string) => text,
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

const rootSnapshot: LeaderSnapshot = {
  active: true,
  prefix: ['SPC'],
  label: 'leader',
  options: [
    { key: 'a', label: 'agents', detail: 'subagent resources and runs' },
    { key: 'e', label: 'extension' },
    { key: 'h', label: 'help' },
    { key: 'l', label: 'loops' },
    { key: 'm', label: 'models' },
    { key: 'p', label: 'plan' },
    { key: 'q', label: 'quit' },
    { key: 'r', label: 'runners' },
    { key: 's', label: 'sessions' },
    { key: 't', label: 'tasks' },
    { key: 'v', label: 'voice' },
    { key: 'w', label: 'workflows' },
  ],
};

const context = {
  sessionManager: { getBranch: () => [] },
  getContextUsage: () => ({ percent: 46.6, contextWindow: 272_000 }),
} as unknown as ExtensionContext;

const footerData = {
  getExtensionStatuses: () => new Map([['copilot', '[copilot]:utils,staging']]),
  getAvailableProviderCount: () => 1,
} as unknown as ReadonlyFooterDataProvider;

describe('LeaderHints', () => {
  it('keeps root diagnostics visible when most option groups have no detail', () => {
    const lines = new LeaderHints(theme, rootSnapshot, context, footerData, [
      {
        id: 'plan',
        source: '@agimon-ai/doompi-plan',
        label: 'PLAN',
        detail: 'normal - read only',
        order: 10,
      },
    ]).render(90);
    const rendered = lines.join('\n');

    expect(lines.length).toBeLessThanOrEqual(21);
    expect(lines.every((line) => visibleWidth(line) === 90)).toBe(true);
    for (const option of rootSnapshot.options) expect(rendered).toContain(option.label);
    expect(rendered).toContain('MODES');
    expect(rendered).toContain('SESSION');
    expect(rendered).toContain('EXTENSIONS');
    expect(rendered).toContain('[copilot]:utils,staging');
  });

  it('keeps an empty detail line beneath option groups without subtext', () => {
    const snapshot: LeaderSnapshot = {
      active: true,
      prefix: ['SPC'],
      label: 'leader',
      options: [
        { key: 'a', label: 'agents' },
        { key: 'e', label: 'extension' },
        { key: 'h', label: 'help' },
        { key: 'm', label: 'models' },
      ],
    };

    const lines = new LeaderHints(theme, snapshot).render(90);
    const optionLines = lines.slice(3, -1);

    // 90 columns is three per row, so four options take two rows of two lines.
    expect(optionLines).toHaveLength(4);
    expect(optionLines[0]).toContain('agents');
    expect(optionLines[0]).toContain('help');
    expect(optionLines[1]?.trim()).toBe('');
    expect(optionLines[2]).toContain('models');
    expect(optionLines[3]?.trim()).toBe('');
  });

  it('takes its column count from the width alone, so every board shares one grid', () => {
    const board = (prefix: string[], options: LeaderSnapshot['options']): LeaderSnapshot => ({
      active: true,
      prefix,
      label: 'board',
      options,
    });
    // A long description on the root board used to widen every cell and squeeze
    // the grid down to two columns; a short sub-board used to spread to eight.
    const root = board(['SPC'], rootSnapshot.options);
    const sub = board(
      ['SPC', 'l'],
      [
        { key: 'l', label: 'list', detail: 'loops in this session' },
        { key: 's', label: 'start', detail: 'begin a recurring loop' },
      ],
    );

    // Options fill the grid in order, so the first row holds options[0..n-1].
    const columnsOf = (snapshot: LeaderSnapshot, width: number): number => {
      const row = new LeaderHints(theme, snapshot).render(width)[3] ?? '';
      const placed = snapshot.options.findIndex((option) => !row.includes(option.label));
      return placed === -1 ? snapshot.options.length : placed;
    };

    for (const [width, columns] of [
      [50, 1],
      [70, 2],
      [110, 3],
      [140, 4],
    ] as const) {
      expect(columnsOf(root, width)).toBe(Math.min(columns, root.options.length));
      expect(columnsOf(sub, width)).toBe(Math.min(columns, sub.options.length));
    }
  });

  it('paints the exit badge apart from the keys that enter something', () => {
    // The panel is read to find out which way `e` flips, so the badge has to
    // answer that on its own rather than deferring to the mode line.
    const painted: Array<{ color: string; text: string }> = [];
    const recordingTheme = {
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      inverse: (text: string) => text,
      fg: (color: string, text: string) => {
        painted.push({ color, text });
        return text;
      },
    } as unknown as Theme;
    const snapshot: LeaderSnapshot = {
      active: true,
      prefix: ['SPC', 'p'],
      label: 'plan',
      options: [
        { key: 'd', label: 'debug', detail: 'adaptive debug planning' },
        { key: 'e', label: 'exit', detail: 'restore and exit', tone: 'exit' },
      ],
    };

    new LeaderHints(recordingTheme, snapshot).render(90);

    expect(painted).toContainEqual({ color: 'warning', text: ' e ' });
    expect(painted).toContainEqual({ color: 'accent', text: ' d ' });
  });

  it('drops descriptions rather than options when the grid outgrows the panel', () => {
    const snapshot: LeaderSnapshot = {
      active: true,
      prefix: ['SPC'],
      label: 'leader',
      options: rootSnapshot.options.map((option) => ({ ...option, detail: 'supporting text' })),
    };

    const lines = new LeaderHints(theme, snapshot, context, footerData).render(50);
    const rendered = lines.join('\n');

    for (const option of snapshot.options) expect(rendered).toContain(option.label);
    expect(rendered).not.toContain('supporting text');
    expect(lines.length).toBeLessThanOrEqual(MAX_WIDGET_LINES);
  });
});
