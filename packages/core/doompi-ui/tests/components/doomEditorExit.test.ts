import type { KeybindingsManager as CodingKeybindingsManager } from '@earendil-works/pi-coding-agent';
import { KeybindingsManager, TUI_KEYBINDINGS, type EditorTheme, type TUI } from '@earendil-works/pi-tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DoomEditor, type DoomEditorLeaderOptions } from '../../src/exports/components/doomEditor.ts';
import { createPlanLeaderRegistry } from '../helpers/leader.ts';
import { DoomUiState, type LeaderSnapshot } from '../../src/exports/uiState.ts';

type ExitTestLeaderOptions = DoomEditorLeaderOptions & {
  onUnavailableAction?: (action: string) => void;
};

function createEditor(
  leaderOptions: ExitTestLeaderOptions = {},
  onSnapshot: (snapshot: LeaderSnapshot) => void = () => undefined,
): DoomEditor {
  const tui = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI;
  const theme = { borderColor: (text: string) => text, selectList: {} } as unknown as EditorTheme;
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as CodingKeybindingsManager;
  return new DoomEditor(tui, theme, keybindings, new DoomUiState(), onSnapshot, undefined, undefined, {
    registry: createPlanLeaderRegistry(),
    ...leaderOptions,
  });
}

function enterChord(editor: DoomEditor, keys: string[]): void {
  editor.handleInput('\x00');
  for (const key of keys) editor.handleInput(key);
}

describe('DoomEditor exit action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to the inherited onCtrlD handler for SPC q q', () => {
    const onCtrlD = vi.fn();
    const editor = createEditor();
    editor.onCtrlD = onCtrlD;

    enterChord(editor, ['q', 'q']);

    expect(onCtrlD).toHaveBeenCalledOnce();
  });

  it('prefers a registered app.exit handler over onCtrlD', () => {
    const onCtrlD = vi.fn();
    const registeredExit = vi.fn();
    const editor = createEditor();
    editor.onCtrlD = onCtrlD;
    editor.onAction('app.exit', registeredExit);

    enterChord(editor, ['q', 'q']);

    expect(registeredExit).toHaveBeenCalledOnce();
    expect(onCtrlD).not.toHaveBeenCalled();
  });

  it('reports unresolved non-exit app actions through the optional callback', () => {
    const onUnavailableAction = vi.fn();
    const editor = createEditor({ onUnavailableAction });

    enterChord(editor, ['m', 'm']);

    expect(onUnavailableAction).toHaveBeenCalledWith('app.model.select');
  });

  it('defaults unresolved app actions to a no-op without throwing', () => {
    const editor = createEditor();

    expect(() => enterChord(editor, ['m', 'm'])).not.toThrow();
  });

  it('cancels the leader overlay before dispatching the exit fallback', () => {
    const events: string[] = [];
    const editor = createEditor({}, (snapshot) => {
      events.push(snapshot.active ? 'leader-active' : 'leader-inactive');
    });
    editor.onCtrlD = vi.fn(() => events.push('onCtrlD'));

    enterChord(editor, ['q', 'q']);

    expect(events.slice(-2)).toEqual(['leader-inactive', 'onCtrlD']);
  });

  it('never calls process.exit for the leader exit action', () => {
    const processExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const editor = createEditor();
    editor.onCtrlD = vi.fn();

    enterChord(editor, ['q', 'q']);

    expect(processExit).not.toHaveBeenCalled();
  });
});
