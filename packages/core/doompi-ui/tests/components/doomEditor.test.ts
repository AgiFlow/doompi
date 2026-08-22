import type { KeybindingsManager as CodingKeybindingsManager } from '@earendil-works/pi-coding-agent';
import { KeybindingsManager, TUI_KEYBINDINGS, type EditorTheme, type TUI } from '@earendil-works/pi-tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DoomEditor, type DoomEditorLeaderOptions } from '../../src/exports/components/doomEditor.ts';
import { createPlanLeaderRegistry } from '../helpers/leader.ts';
import { DoomUiState, type LeaderSnapshot } from '../../src/exports/uiState.ts';

function createEditor(leaderOptions: DoomEditorLeaderOptions = {}): {
  editor: DoomEditor;
  snapshots: LeaderSnapshot[];
  requestRender: ReturnType<typeof vi.fn>;
} {
  const requestRender = vi.fn();
  const tui = { terminal: { rows: 24 }, requestRender } as unknown as TUI;
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
    { registry: createPlanLeaderRegistry(), ...leaderOptions },
  );
  return { editor, snapshots, requestRender };
}

describe('DoomEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps ordinary spaces in a non-empty draft', () => {
    const { editor } = createEditor();
    editor.setText('keep');

    editor.handleInput(' ');

    expect(editor.getText()).toBe('keep ');
  });

  it('shows the capitalized harness major mode instead of the insert-state label', () => {
    vi.stubEnv('DOOMPI_MAJOR_MODE', 'minimal');
    try {
      const { editor } = createEditor();
      const rendered = editor.render(100).join('\n');

      expect(rendered).toContain('MINIMAL');
      expect(rendered).not.toContain('INSERT');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('shows the universal and empty-draft leader shortcuts contextually', () => {
    const { editor } = createEditor();

    expect(editor.render(100).join('\n')).toContain('draft 0 · ^SPC leader · SPC shortcut');

    editor.setText('keep this draft');
    const rendered = editor.render(100).join('\n');
    expect(rendered).toContain('draft 15 · ^SPC leader');
    expect(rendered).not.toContain('SPC shortcut');
  });

  it('opens and cancels leader mode with an empty-editor Space', () => {
    const { editor, snapshots } = createEditor();

    editor.handleInput(' ');
    expect(editor.getText()).toBe('');
    expect(snapshots.at(-1)).toMatchObject({ active: true, prefix: ['SPC'], label: 'leader' });

    editor.handleInput('\x1b');
    expect(snapshots.at(-1)).toEqual({ active: false, prefix: [], label: '', options: [] });
  });

  it('delegates a built-in chord through the copied action handlers', () => {
    const { editor } = createEditor();
    const selectModel = vi.fn();
    editor.onAction('app.model.select', selectModel);

    editor.handleInput(' ');
    editor.handleInput('m');
    editor.handleInput('m');

    expect(selectModel).toHaveBeenCalledOnce();
  });

  it('dispatches slash commands while preserving a non-empty draft', () => {
    const { editor } = createEditor();
    const submit = vi.fn();
    editor.onSubmit = submit;
    editor.setText('keep this draft');

    editor.handleInput('\x00');
    editor.handleInput('p');
    editor.handleInput('p');

    expect(submit).toHaveBeenCalledWith('/plan');
    expect(editor.getText()).toBe('keep this draft');
  });

  it('does not submit an unavailable contributed command', () => {
    const unavailable = vi.fn();
    const { editor } = createEditor({
      isCommandAvailable: () => false,
      onUnavailableCommand: unavailable,
    });
    const submit = vi.fn();
    editor.onSubmit = submit;
    editor.setText('draft');

    editor.handleInput('\x00');
    editor.handleInput('p');
    editor.handleInput('p');

    expect(submit).not.toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalledWith('plan');
    expect(editor.getText()).toBe('draft');
  });

  it('restores the draft after a leader command submits', () => {
    const { editor } = createEditor();
    const submit = vi.fn();
    editor.onSubmit = submit;
    editor.setText('draft');

    editor.handleInput('\x00');
    editor.handleInput('h');
    editor.handleInput('h');

    expect(submit).toHaveBeenCalledWith('/hotkeys');
    expect(editor.getText()).toBe('draft');
  });

  it('restores the draft when the leader is cancelled', () => {
    const { editor } = createEditor();
    editor.setText('draft');

    editor.handleInput('\x00');
    editor.handleInput('h');
    editor.handleInput('\x1b');

    expect(editor.getText()).toBe('draft');
  });
});
