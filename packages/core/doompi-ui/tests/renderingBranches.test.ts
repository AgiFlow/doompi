import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth, type TUI } from '@earendil-works/pi-tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DoomFooter, type DoomFooterStatusView } from '../src/exports/components/doomFooter.ts';
import { DoomHeader } from '../src/exports/components/doomHeader.ts';
import { LeaderHints } from '../src/exports/components/leaderHints.ts';
import { alignLine, fitLine, packSegments } from '../src/exports/rendering.ts';
import { DoomUiState } from '../src/exports/uiState.ts';

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

describe('responsive rendering branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles zero widths and oversized aligned content', () => {
    expect(fitLine('content', 0)).toBe('');
    expect(alignLine('left', '', 8)).toBe('left');
    expect(visibleWidth(alignLine('left', 'oversized', 4))).toBe(4);
    expect(packSegments(['one'], 0)).toEqual([]);
    expect(packSegments(['first', 'second'], 6)).toEqual(['first', 'second']);
  });

  it('handles empty and unmanaged header states', () => {
    const header = new DoomHeader(theme, '/', () => ({
      root: undefined,
      majorMode: 'copilot',
      domains: [],
      layers: [],
      profile: undefined,
    }));

    expect(header.render(0)).toEqual([]);
    const lines = header.render(70);
    expect(lines.join('\n')).toContain('new');
    expect(lines.every((line) => visibleWidth(line) <= 70)).toBe(true);
  });

  it('hides inactive hints and omits the nested root trail at narrow widths', () => {
    const inactive = new LeaderHints(theme, { active: false, prefix: [], label: '', options: [] });
    expect(inactive.render(80)).toEqual([]);

    const root = new LeaderHints(theme, {
      active: true,
      prefix: ['SPC'],
      label: 'leader',
      options: [{ key: 'm', label: 'models' }],
    });
    expect(root.render(0)).toEqual([]);
    expect(root.render(60).join('\n')).not.toContain('root  m model');
  });

  it('renders footer fallbacks without branch, model, usage, or statuses', () => {
    const footerData = {
      getGitBranch: () => null,
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 0,
      onBranchChange: () => () => undefined,
    } as unknown as ReadonlyFooterDataProvider;
    const context = {
      cwd: '/',
      model: undefined,
      thinkingLevel: undefined,
      getContextUsage: () => undefined,
    } as unknown as ExtensionContext;
    const footer = new DoomFooter(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      context,
      footerData,
      {
        getStatuses: () => [],
        subscribe: () => () => undefined,
      } satisfies DoomFooterStatusView,
      new DoomUiState(),
    );

    expect(footer.render(0)).toEqual([]);
    const line = footer.render(72)[0] ?? '';
    expect(line).toContain('no-model');
    expect(line).toContain('off');
    expect(visibleWidth(line)).toBeLessThanOrEqual(72);
  });
});
