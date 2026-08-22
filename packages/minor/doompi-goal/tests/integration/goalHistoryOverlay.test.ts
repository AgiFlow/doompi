import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { openGoalHistoryOverlay } from '../../src/tui/goalHistoryOverlay.ts';

function contextFor(mode: 'tui' | 'rpc', custom: ExtensionContext['ui']['custom']): ExtensionContext {
  return {
    mode,
    hasUI: true,
    cwd: process.cwd(),
    ui: {
      custom,
      confirm: vi.fn().mockResolvedValue(true),
      notify: vi.fn(),
      getEditorText: vi.fn(() => 'draft'),
      setEditorText: vi.fn(),
    },
    sessionManager: { getSessionId: () => 'history-session' },
  } as unknown as ExtensionContext;
}

describe('Goal history overlay', () => {
  it('does not open outside the Doom TUI', async () => {
    const customImpl = vi.fn();
    const custom = customImpl as unknown as ExtensionContext['ui']['custom'];
    const ctx = contextFor('rpc', custom);
    await openGoalHistoryOverlay(ctx, {} as never);
    expect(customImpl).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith('Goal history is available in the Doom TUI.', 'warning');
  });

  it('renders archived statuses with semantic glyphs and colors', async () => {
    const manager = {
      listHistory: vi.fn().mockResolvedValue([
        { id: 'done', objective: 'done', status: 'complete', archivedAt: '2025-03-01T00:00:00.000Z' },
        { id: 'blocked', objective: 'blocked', status: 'blocked', archivedAt: '2025-02-01T00:00:00.000Z' },
        {
          id: 'limited',
          objective: 'limited',
          status: 'budget_limited',
          archivedAt: '2025-01-01T00:00:00.000Z',
        },
      ]),
      removeHistory: vi.fn(),
      restartFromHistory: vi.fn(),
    };
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      inverse: (text: string) => text,
    } as unknown as Theme;
    let rendered = '';
    let compactRendered = '';
    const custom = vi.fn(async (factory: Parameters<ExtensionContext['ui']['custom']>[0]) => {
      const terminal = { rows: 24, columns: 400 };
      const component = await Promise.resolve(
        factory({ requestRender: vi.fn(), terminal } as never, theme, {} as never, vi.fn()),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      rendered = component.render(400).join('\n');
      terminal.rows = 5;
      compactRendered = component.render(400).join('\n');
      return undefined;
    });

    await openGoalHistoryOverlay(contextFor('tui', custom as ExtensionContext['ui']['custom']), manager as never);

    expect(rendered).toContain('<success>✓ complete</success>');
    expect(rendered).toContain('<error>! blocked</error>');
    expect(rendered).toContain('<warning>◆ budget_limited</warning>');
    for (const legend of [rendered, compactRendered]) {
      expect(legend).toContain('↑↓');
      expect(legend).not.toContain('j/k');
    }
  });

  it('loads newest first and removes only after confirmation without touching the draft', async () => {
    const manager = {
      listHistory: vi.fn().mockResolvedValue([
        { id: 'old', objective: 'old objective', status: 'complete', archivedAt: '2025-01-01T00:00:00.000Z' },
        { id: 'new', objective: 'new objective', status: 'paused', archivedAt: '2025-02-01T00:00:00.000Z' },
      ]),
      removeHistory: vi.fn().mockResolvedValue(undefined),
      restartFromHistory: vi.fn(),
    };
    let component: { handleInput(data: string): void } | undefined;
    const customImpl = vi.fn(async (factory: Parameters<ExtensionContext['ui']['custom']>[0]) => {
      component = factory(
        { requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } } as never,
        {} as Theme,
        {} as never,
        vi.fn(),
      ) as unknown as { handleInput(data: string): void };
      await Promise.resolve();
      component?.handleInput('x');
      await Promise.resolve();
      return undefined;
    });
    const custom = customImpl as unknown as ExtensionContext['ui']['custom'];
    const ctx = contextFor('tui', custom);
    await openGoalHistoryOverlay(ctx, manager as never);
    expect(manager.removeHistory).toHaveBeenCalledWith('new', ctx);
    expect(ctx.ui.getEditorText()).toBe('draft');
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
  });
});

describe('Goal history overlay navigation branches', () => {
  it('restarts the selected newest entry and closes on escape', async () => {
    const manager = {
      listHistory: vi.fn().mockResolvedValue([
        { id: 'old', objective: 'old objective', status: 'complete', archivedAt: '2025-01-01T00:00:00.000Z' },
        { id: 'new', objective: 'new objective', status: 'paused', archivedAt: '2025-02-01T00:00:00.000Z' },
      ]),
      removeHistory: vi.fn(),
      restartFromHistory: vi.fn().mockResolvedValue(undefined),
    };
    let component: { handleInput(data: string): void } | undefined;
    const custom = vi.fn(async (factory: Parameters<ExtensionContext['ui']['custom']>[0]) => {
      component = factory(
        { requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } } as never,
        {} as Theme,
        {} as never,
        vi.fn(),
      ) as unknown as { handleInput(data: string): void };
      await new Promise((resolve) => setTimeout(resolve, 5));
      component?.handleInput('j');
      component?.handleInput('k');
      component?.handleInput('\n');
      component?.handleInput('q');
      await Promise.resolve();
      return undefined;
    });
    const ctx = contextFor('tui', custom as unknown as ExtensionContext['ui']['custom']);
    await openGoalHistoryOverlay(ctx, manager as never);
    expect(manager.restartFromHistory).toHaveBeenCalledWith('new', ctx);
    expect(manager.removeHistory).not.toHaveBeenCalled();
  });

  it('keeps an entry when removal is cancelled and handles history load errors', async () => {
    const manager = {
      listHistory: vi
        .fn()
        .mockResolvedValue([
          { id: 'only', objective: 'only objective', status: 'paused', archivedAt: '2025-01-01T00:00:00.000Z' },
        ]),
      removeHistory: vi.fn(),
      restartFromHistory: vi.fn(),
    };
    const custom = vi.fn(async (factory: Parameters<ExtensionContext['ui']['custom']>[0]) => {
      const component = factory(
        { requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } } as never,
        {} as Theme,
        {} as never,
        vi.fn(),
      ) as unknown as { handleInput(data: string): void };
      await new Promise((resolve) => setTimeout(resolve, 5));
      component.handleInput('j');
      component.handleInput('x');
      component.handleInput('q');
      return undefined;
    });
    const ctx = contextFor('tui', custom as unknown as ExtensionContext['ui']['custom']);
    (ctx.ui.confirm as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    await openGoalHistoryOverlay(ctx, manager as never);
    expect(manager.removeHistory).not.toHaveBeenCalled();

    const failing = {
      listHistory: vi.fn().mockRejectedValue(new Error('history unavailable')),
      removeHistory: vi.fn(),
      restartFromHistory: vi.fn(),
    };
    const failingCustom = vi.fn(async (factory: Parameters<ExtensionContext['ui']['custom']>[0]) => {
      const component = factory(
        { requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } } as never,
        {} as Theme,
        {} as never,
        vi.fn(),
      ) as unknown as { handleInput(data: string): void };
      await new Promise((resolve) => setTimeout(resolve, 5));
      component.handleInput('j');
      component.handleInput('\n');
      component.handleInput('x');
      component.handleInput('q');
      return undefined;
    });
    const failingContext = contextFor('tui', failingCustom as unknown as ExtensionContext['ui']['custom']);
    await expect(openGoalHistoryOverlay(failingContext, failing as never)).resolves.toBeUndefined();
    expect(failing.restartFromHistory).not.toHaveBeenCalled();
  });
});
