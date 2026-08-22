import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from '@earendil-works/pi-coding-agent';
import { type TUI, visibleWidth } from '@earendil-works/pi-tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DoomFooter, type DoomFooterStatusView } from '../../src/exports/components/doomFooter.ts';
import { DoomHeader } from '../../src/exports/components/doomHeader.ts';
import { LeaderHints, MAX_WIDGET_LINES as LEADER_WIDGET_MAX_LINES } from '../../src/exports/components/leaderHints.ts';
import type { DoomFooterStatus } from '../../src/exports/footer.ts';
import { fitStyledLine } from '../../src/exports/rendering.ts';

/**
 * The widget's self-imposed height budget: Pi's setWidget takes no line cap, so
 * this is what the package chooses to occupy above the editor. Imported rather
 * than restated, because a copy of the number here drifted from the component's
 * own and stopped catching anything.
 */

import { DoomUiState } from '../../src/exports/uiState.ts';

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

/** Tags each colour so assertions can tell frame glyphs from muted fill. */
const taggingTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bg: (color: string, text: string) => `<bg:${color}>${text}</bg:${color}>`,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

function expectWidth(lines: string[], width: number): void {
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

function footerStatusRegistry(
  statuses: readonly DoomFooterStatus[] = [],
  unsubscribe: () => void = () => undefined,
): DoomFooterStatusView {
  return {
    getStatuses: () => statuses.map((status) => ({ ...status })),
    subscribe: () => unsubscribe,
  };
}

describe('Doom UI rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the startup header at wide and narrow widths', () => {
    const header = new DoomHeader(theme, '/repo/agirepo', () => ({
      root: '/repo/agirepo',
      majorMode: 'copilot',
      profile: 'product-agiflow',
      domains: ['development'],
      layers: ['guardrails', 'vibe-lint'],
    }));

    const wide = header.render(120);
    const narrow = header.render(60);

    expect(wide.join('\n')).toContain('DOOM');
    expect(wide.join('\n')).toContain('guardrails');
    expect(wide.join('\n')).toContain('NO TRANSCRIPT YET');
    expect(wide.join('\n')).toContain('CTRL+SPACE');
    expect(wide.join('\n')).toContain('SPC  when empty');
    expect(narrow.join('\n')).toContain('CTRL+SPACE');
    expectWidth(wide, 120);
    expectWidth(narrow, 60);
  });

  it('hides the launch header once transcript entries exist', () => {
    const runtime = {
      isIdle: () => false,
      model: { id: 'claude-sonnet-4.5' },
      sessionManager: {
        getEntries: () => [{ type: 'message' }],
        getSessionId: () => '3f42c7abcdef',
      },
      thinkingLevel: 'high',
    } as unknown as ExtensionContext;
    const header = new DoomHeader(
      theme,
      '/repo/agirepo',
      () => ({
        root: '/repo/agirepo',
        majorMode: 'copilot',
        profile: 'product-agiflow',
        domains: ['development'],
        layers: ['plan-mode', 'goal'],
      }),
      runtime,
    );

    expect(header.render(120)).toEqual([]);
    expect(header.render(80)).toEqual([]);
  });

  it('renders a responsive modeline and disposes its subscriptions', () => {
    const unsubscribeBranch = vi.fn();
    const unsubscribeState = vi.fn();
    const state = new DoomUiState();
    const originalSubscribe = state.subscribe.bind(state);
    vi.spyOn(state, 'subscribe').mockImplementation((listener) => {
      const unsubscribe = originalSubscribe(listener);
      return () => {
        unsubscribe();
        unsubscribeState();
      };
    });
    const footerData = {
      getGitBranch: () => 'main',
      getExtensionStatuses: () => new Map([['plan', 'plan: active']]),
      getAvailableProviderCount: () => 2,
      onBranchChange: () => unsubscribeBranch,
    } as unknown as ReadonlyFooterDataProvider;
    const context = {
      cwd: '/repo/agirepo',
      model: { id: 'claude-sonnet-4.5' },
      thinkingLevel: 'high',
      getContextUsage: () => ({ tokens: 41000, contextWindow: 100000, percent: 41 }),
    } as unknown as ExtensionContext;
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const unsubscribeFooterStatuses = vi.fn();
    const footer = new DoomFooter(
      tui,
      theme,
      context,
      footerData,
      footerStatusRegistry([], unsubscribeFooterStatuses),
      state,
    );

    expectWidth(footer.render(120), 120);
    expectWidth(footer.render(60), 60);
    const tiny = footer.render(14);
    expectWidth(tiny, 14);
    expect(tiny.join('')).toContain(' I ');
    state.setLeader({ active: true, prefix: ['SPC', 's'], label: 'sessions', options: [] });
    expect(footer.render(120).join('')).toContain('SPC s');

    footer.dispose();
    expect(unsubscribeBranch).toHaveBeenCalledOnce();
    expect(unsubscribeFooterStatuses).toHaveBeenCalledOnce();
    expect(unsubscribeState).toHaveBeenCalledOnce();
  });

  it('renders only registered footer contributions with responsive text', () => {
    const footerData = {
      getGitBranch: () => 'main',
      getExtensionStatuses: () =>
        new Map([
          ['profile', '[copilot]:default'],
          ['mcp', 'MCP: 7 servers enabled'],
        ]),
      getAvailableProviderCount: () => 1,
      onBranchChange: () => () => {},
    } as unknown as ReadonlyFooterDataProvider;
    const context = {
      cwd: '/repo/agirepo',
      model: { id: 'claude-sonnet-4.5' },
      thinkingLevel: 'high',
      getContextUsage: () => ({ tokens: 41000, contextWindow: 100000, percent: 41 }),
    } as unknown as ExtensionContext;
    const footer = new DoomFooter(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      context,
      footerData,
      footerStatusRegistry([
        {
          source: '@agimon-ai/doompi-runner',
          id: 'runner-count',
          fullText: ' Runner\n2 ',
          compactText: 'R2',
          order: 10,
        },
        {
          source: '@agimon-ai/doompi-team',
          id: 'agent-count',
          fullText: 'Agents 3',
          compactText: 'A3',
          order: 20,
        },
      ]),
      new DoomUiState(),
    );

    const wide = footer.render(160).join('');
    const narrow = footer.render(80).join('');
    expect(wide).toContain('Runner 2 · Agents 3');
    expect(narrow).toContain('R2 · A3');
    expect(wide).not.toContain('[copilot]:default');
    expect(wide).not.toContain('MCP');
    expect(wide).not.toContain('\n');
    expectWidth(footer.render(80), 80);
    const modeline = footer as unknown as { modelineSummary(width: number, compact: boolean): string };
    expect(modeline.modelineSummary(0, false)).toBe('');
  });

  it('renders ordered before-model contributions atomically beside the model', () => {
    const footer = new DoomFooter(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      {
        cwd: '/repo/agirepo',
        model: { id: 'claude-sonnet-4.5' },
        thinkingLevel: 'high',
        getContextUsage: () => ({ tokens: 41000, contextWindow: 100000, percent: 41 }),
      } as unknown as ExtensionContext,
      {
        getGitBranch: () => 'main',
        onBranchChange: () => () => {},
      } as unknown as ReadonlyFooterDataProvider,
      footerStatusRegistry([
        { source: 'runner', id: 'runner', fullText: 'Runner 1', compactText: 'R1', order: 5 },
        {
          source: 'first-runtime',
          id: 'first-runtime',
          fullText: 'A',
          compactText: 'A',
          order: 10,
          placement: 'beforeModel',
        },
        {
          source: 'voice',
          id: 'voice',
          fullText: '●',
          compactText: '●',
          fullSegments: [{ text: '●', color: 'warning' }],
          compactSegments: [{ text: '●', color: 'warning' }],
          order: 20,
          placement: 'beforeModel',
        },
      ]),
      new DoomUiState(),
    );

    const wide = footer.render(160).join('');
    expect(wide).toContain('Runner 1');
    expect(wide).toContain('A · ● · sonnet-4.5');

    const exactFit = footer.render(37);
    expectWidth(exactFit, 37);
    expect(exactFit.join('')).toContain('A · ● · sonnet-4.5');

    const tooNarrow = footer.render(36);
    expectWidth(tooNarrow, 36);
    expect(tooNarrow.join('')).toContain('sonnet-4.5');
    expect(tooNarrow.join('')).not.toContain('A ·');
    expect(tooNarrow.join('')).not.toContain('');
  });

  it('colors warning, critical, and unavailable footer context states', () => {
    let percent: number | null = 90;
    const context = {
      cwd: '/repo/agirepo',
      model: undefined,
      thinkingLevel: 'custom',
      getContextUsage: () => ({ tokens: 0, contextWindow: 100, percent }),
    } as unknown as ExtensionContext;
    const footerData = {
      getGitBranch: () => null,
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 1,
      onBranchChange: () => () => {},
    } as unknown as ReadonlyFooterDataProvider;
    const footer = new DoomFooter(
      { requestRender: vi.fn() } as unknown as TUI,
      taggingTheme,
      context,
      footerData,
      footerStatusRegistry(),
      new DoomUiState(),
    );

    const modeline = footer as unknown as { modelineSummary(width: number, compact: boolean): string };
    expect(modeline.modelineSummary(40, false)).toBe('');
    expect(footer.render(140).join('')).toContain('<error>ctx 90%</error>');
    percent = 70;
    expect(footer.render(140).join('')).toContain('<warning>ctx 70%</warning>');
    percent = null;
    expect(footer.render(140).join('')).toContain('<muted>ctx ?</muted>');
  });

  it('renders semantic colors from structured footer segments and dims legacy text', () => {
    const footer = new DoomFooter(
      { requestRender: vi.fn() } as unknown as TUI,
      taggingTheme,
      {
        cwd: '/repo/agirepo',
        getContextUsage: () => ({ tokens: 0, contextWindow: 100, percent: 0 }),
      } as unknown as ExtensionContext,
      {
        getGitBranch: () => null,
        onBranchChange: () => () => {},
      } as unknown as ReadonlyFooterDataProvider,
      footerStatusRegistry([
        { source: 'legacy', id: 'legacy', fullText: 'Runner 1', compactText: 'R1', order: 10 },
        {
          source: 'agents',
          id: 'agents',
          fullText: 'Agents ·',
          compactText: 'A ·',
          fullSegments: [{ text: 'Agents ' }, { text: '·', color: 'accent' }],
          compactSegments: [{ text: 'A ' }, { text: '·', color: 'accent' }],
          order: 20,
        },
      ]),
      new DoomUiState(),
    );

    const modeline = footer as unknown as { modelineSummary(width: number, compact: boolean): string };

    expect(modeline.modelineSummary(80, false)).toBe(
      '<dim>Runner 1</dim><dim> · </dim><dim>Agents </dim><accent>·</accent>',
    );
  });

  it('keeps every leader option visible when diagnostics compete for widget lines', () => {
    const context = {
      getContextUsage: () => ({ tokens: 0, contextWindow: 272000, percent: 0 }),
      sessionManager: { getBranch: () => [] },
    } as unknown as ExtensionContext;
    const footerData = {
      getAvailableProviderCount: () => 1,
      getExtensionStatuses: () =>
        new Map([
          ['cache', 'OpenAI cache 970/991 · 172.0M/176.9M tok (97%)'],
          ['profile', '[copilot]:default'],
          ['mcp', 'MCP: 7 servers enabled (2 disabled)'],
        ]),
    } as unknown as ReadonlyFooterDataProvider;
    const options = [
      { key: 'm', label: 'models' },
      { key: 'o', label: 'toggles' },
      { key: 's', label: 'sessions' },
      { key: 'y', label: 'copy' },
      { key: 'e', label: 'editor' },
      { key: 'p', label: 'plan' },
      { key: 't', label: 'tasks' },
      { key: 'h', label: 'help' },
      { key: 'c', label: 'commands' },
      { key: 'q', label: 'quit' },
    ];
    const hints = new LeaderHints(
      theme,
      { active: true, prefix: ['SPC'], label: 'leader', options },
      context,
      footerData,
    );

    for (const width of [120, 80, 60]) {
      const lines = hints.render(width);
      const rendered = lines.join('\n');
      for (const option of options) expect(rendered).toContain(option.label);
      expect(lines.length).toBeLessThanOrEqual(LEADER_WIDGET_MAX_LINES);
      expectWidth(lines, width);
    }
  });

  it('keeps leader hints and wrapped diagnostics within Pi widget and terminal limits', () => {
    const context = {
      getContextUsage: () => ({ tokens: 171000, contextWindow: 272000, percent: 63.1 }),
      sessionManager: {
        getBranch: () => [
          {
            type: 'message',
            message: {
              role: 'assistant',
              usage: {
                input: 1700000,
                output: 148000,
                cacheRead: 80000000,
                cacheWrite: 0,
                cost: { total: 74.912 },
              },
            },
          },
        ],
      },
    } as unknown as ExtensionContext;
    const footerData = {
      getAvailableProviderCount: () => 3,
      getExtensionStatuses: () =>
        new Map([
          ['profile', '[copilot]:default'],
          ['mcp', 'MCP 7 enabled / 2 disabled'],
          ['cache', 'OpenAI cache 850 / 8k · 172.8M / 177.4M tok (97%)'],
        ]),
    } as unknown as ReadonlyFooterDataProvider;
    const hints = new LeaderHints(
      theme,
      {
        active: true,
        prefix: ['SPC'],
        label: 'leader',
        options: [
          { key: 'n', label: 'new', detail: 'fresh session' },
          { key: 'r', label: 'resume', detail: 'open history' },
          { key: 't', label: 'tree', detail: 'branch view' },
          { key: 'f', label: 'fork', detail: 'from selection' },
        ],
      },
      context,
      footerData,
    );

    const wide = hints.render(120);
    const narrow = hints.render(80);

    expect(wide.length).toBeLessThanOrEqual(LEADER_WIDGET_MAX_LINES);
    expect(narrow.length).toBeLessThanOrEqual(LEADER_WIDGET_MAX_LINES);
    expect(wide.join('\n')).toContain('SESSION');
    expect(wide.join('\n')).toContain('EXTENSIONS');
    expect(wide.join('\n')).toContain('[copilot]:default');
    expect(wide.join('\n')).toContain('MCP 7 enabled / 2 disabled');
    expect(wide.join('\n')).toContain('↳');
    expectWidth(wide, 120);
    expectWidth(narrow, 80);
  });

  it('keeps outer backgrounds active through truncated row padding', () => {
    const fitted = fitStyledLine('\u001b[44mabcdef\u001b[49m', 4);

    expect(fitted).not.toContain('\u001b[0m');
    expect(visibleWidth(fitted)).toBe(4);
  });

  it('paints a shaded block with no frame', () => {
    const context = {
      getContextUsage: () => ({ tokens: 1000, contextWindow: 272000, percent: 0.4 }),
      sessionManager: { getBranch: () => [] },
    } as unknown as ExtensionContext;
    const hints = new LeaderHints(
      taggingTheme,
      { active: true, prefix: ['SPC'], label: 'leader', options: [{ key: 'm', label: 'models' }] },
      context,
    );

    const lines = hints.render(80);
    const rendered = lines.join('\n');

    // Every row carries the shade, so the block reads as one surface.
    expect(lines.every((line) => line.includes('<bg:toolPendingBg>'))).toBe(true);
    for (const frameGlyph of ['╭', '╮', '╰', '╯', '│', '├', '┤']) {
      expect(rendered).not.toContain(frameGlyph);
    }
  });
});
