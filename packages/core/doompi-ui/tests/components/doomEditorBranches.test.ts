import type { KeybindingsManager as CodingKeybindingsManager } from '@earendil-works/pi-coding-agent';
import { KeybindingsManager, TUI_KEYBINDINGS, type EditorTheme, type TUI } from '@earendil-works/pi-tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DoomEditor } from '../../src/exports/components/doomEditor.ts';
import { createPlanLeaderRegistry } from '../helpers/leader.ts';
import { DoomUiState, type LeaderSnapshot } from '../../src/exports/uiState.ts';

function createEditor(): { editor: DoomEditor; snapshots: LeaderSnapshot[] } {
  const tui = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI;
  const theme = { borderColor: (text: string) => text, selectList: {} } as unknown as EditorTheme;
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as CodingKeybindingsManager;
  const snapshots: LeaderSnapshot[] = [];
  return {
    editor: new DoomEditor(
      tui,
      theme,
      keybindings,
      new DoomUiState(),
      (snapshot) => snapshots.push(snapshot),
      undefined,
      undefined,
      { majorMode: 'copilot', registry: createPlanLeaderRegistry() },
    ),
    snapshots,
  };
}

describe('DoomEditor branch behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('backs up through nested leader groups before cancelling', () => {
    const { editor, snapshots } = createEditor();

    editor.handleInput(' ');
    editor.handleInput('s');
    expect(snapshots.at(-1)?.prefix).toEqual(['SPC', 's']);

    editor.handleInput('\x7f');
    expect(snapshots.at(-1)?.prefix).toEqual(['SPC']);

    editor.handleInput('\x7f');
    expect(snapshots.at(-1)?.active).toBe(false);
  });

  it('publishes the leaf tone so the panel can paint an exit badge', () => {
    const registry = createPlanLeaderRegistry();
    registry.register({
      source: '@agimon-ai/doompi-plan-exit',
      bindings: [
        {
          id: 'plan.exit',
          path: [
            { key: 'p', label: 'plan', order: 60 },
            { key: 'e', label: 'exit', detail: 'restore and exit', tone: 'exit' },
          ],
          command: { name: 'plan-exit' },
        },
      ],
    });
    const tui = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI;
    const theme = { borderColor: (text: string) => text, selectList: {} } as unknown as EditorTheme;
    const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as CodingKeybindingsManager;
    const snapshots: LeaderSnapshot[] = [];
    const editor = new DoomEditor(
      tui,
      theme,
      keybindings,
      new DoomUiState(),
      (snapshot) => snapshots.push(snapshot),
      undefined,
      undefined,
      { majorMode: 'copilot', registry },
    );

    editor.handleInput(' ');
    editor.handleInput('p');

    const options = snapshots.at(-1)?.options ?? [];
    expect(options.find((option) => option.key === 'e')?.tone).toBe('exit');
    expect(options.find((option) => option.key === 'p')?.tone).toBeUndefined();
  });

  it('cancels unsupported single and control keys without changing the draft', () => {
    const { editor, snapshots } = createEditor();
    editor.setText('draft');

    editor.handleInput('\x00');
    editor.handleInput('z');
    expect(snapshots.at(-1)?.active).toBe(false);
    expect(editor.getText()).toBe('draft');

    editor.handleInput('\x00');
    editor.handleInput('\x1b[A');
    expect(snapshots.at(-1)?.active).toBe(false);
  });

  it('renders the major mode and leader labels within the editor width', () => {
    const { editor } = createEditor();
    const inactive = editor.render(80).join('\n');
    expect(inactive).toContain('COPILOT');
    expect(inactive).not.toContain('INSERT');

    editor.handleInput('\x00');
    expect(editor.render(80).join('\n')).toContain('LEADER SPC');
    expect(editor.render(1)).not.toEqual([]);
  });

  it('cancels an open leader during disposal and keeps the draft', () => {
    const { editor, snapshots } = createEditor();
    editor.setText('draft');
    editor.handleInput('\x00');
    editor.handleInput('s');

    editor.dispose();

    expect(editor.getText()).toBe('draft');
    expect(snapshots.at(-1)?.active).toBe(false);
  });

  it('keeps drafts when command or app handlers are absent', () => {
    const { editor } = createEditor();
    editor.setText('draft');

    editor.handleInput('\x00');
    editor.handleInput('p');
    editor.handleInput('p');
    expect(editor.getText()).toBe('draft');

    editor.handleInput('\x00');
    editor.handleInput('q');
    editor.handleInput('q');
    expect(editor.getText()).toBe('draft');
  });
});
