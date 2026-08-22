import { copyToClipboard, type ExtensionContext, type Theme } from '@earendil-works/pi-coding-agent';
import { DoomLeaderRegistry } from '@agimon-ai/doompi-ui/leaderRegistry';
import { describe, expect, it, vi } from 'vitest';
import { FILE_EDIT_LEADER_CONTRIBUTION } from '../src/adapters/pi/extension.ts';
import { FileEditWorkflow } from '../src/tui/fileEditWorkflow';

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return { ...actual, copyToClipboard: vi.fn() };
});

describe('doom-file-edit leader contribution', () => {
  it('adds e f beside the core e t and e c bindings without diagnostics', () => {
    const registry = new DoomLeaderRegistry();
    registry.register(FILE_EDIT_LEADER_CONTRIBUTION);
    registry.register(FILE_EDIT_LEADER_CONTRIBUTION);
    const options = registry.getGroup(['e'])?.options ?? [];
    // `SPC e e` no longer has a core binding, so this package contributes only `f`.
    expect(new Set(options.map((option) => option.key))).toEqual(new Set(['t', 'f', 'c']));
    expect(options.filter((option) => option.key === 'f')).toHaveLength(1);
    expect(options.find((option) => option.key === 'c')?.action).toMatchObject({
      type: 'command',
      command: { name: 'config' },
    });
    expect(registry.getDiagnostics()).toEqual([]);
  });
});

describe('FileEditWorkflow', () => {
  it('opens with the required full-screen overlay geometry', async () => {
    const custom = vi.fn().mockResolvedValue({ action: 'close', index: 0 });
    const workflow = new FileEditWorkflow(
      { initialize: vi.fn(), append: vi.fn(), list: async () => [], clear: vi.fn() },
      { diff: vi.fn() },
      { path: () => '/tmp/config.yaml', packagePath: () => '/tmp/package-config.yaml', command: async () => undefined },
      { resolve: async () => undefined, launch: vi.fn() },
    );
    const ctx = { cwd: '/tmp', ui: { custom } } as unknown as ExtensionContext;
    await workflow.open(ctx);
    expect(custom.mock.calls[0]?.[1]).toEqual({
      overlay: true,
      overlayOptions: { anchor: 'top-left', width: '100%', maxHeight: '100%', margin: 0 },
    });
  });

  it('copies, launches, reports failures, refreshes, and remains usable', async () => {
    const actions = [
      { action: 'copy', index: 0 },
      { action: 'open', index: 0 },
      { action: 'refresh', index: 0 },
      { action: 'close', index: 0 },
    ];
    const tui = { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      inverse: (text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const custom = vi.fn(
      async (factory: (tuiValue: typeof tui, themeValue: Theme, keys: object, done: () => void) => unknown) => {
        factory(tui, theme, {}, () => undefined);
        return actions.shift();
      },
    );
    const notify = vi.fn();
    const launch = vi.fn().mockResolvedValue({ success: false, error: 'spawn failed' });
    const entry = { path: '/tmp/edited.ts', tool: 'edit' as const, at: 10, count: 1 };
    const diff = {
      path: entry.path,
      state: 'modified' as const,
      lines: ['+new'],
      additions: 1,
      removals: 0,
      tracked: true,
      truncated: false,
      suggestedLine: 4,
    };
    const workflow = new FileEditWorkflow(
      { initialize: vi.fn(), append: vi.fn(), list: async () => [entry], clear: vi.fn() },
      { diff: async () => diff },
      { path: () => '/tmp/config.yaml', packagePath: () => '/tmp/package-config.yaml', command: async () => undefined },
      { resolve: async () => ({ template: 'vi {file}', source: 'fallback' }), launch },
    );
    const ctx = { cwd: '/tmp', ui: { custom, notify } } as unknown as ExtensionContext;
    await workflow.open(ctx);
    expect(copyToClipboard).toHaveBeenCalledWith(entry.path);
    expect(launch).toHaveBeenCalledWith(entry.path, 4, tui);
    expect(notify).toHaveBeenCalledWith('Could not open editor: spawn failed', 'error');
    expect(custom).toHaveBeenCalledTimes(4);
  });
});
