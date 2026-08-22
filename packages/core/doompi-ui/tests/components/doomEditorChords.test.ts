import type { AppKeybinding, KeybindingsManager as CodingKeybindingsManager } from '@earendil-works/pi-coding-agent';
import { KeybindingsManager, TUI_KEYBINDINGS, type EditorTheme, type TUI } from '@earendil-works/pi-tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DoomEditor, type DoomEditorLeaderOptions } from '../../src/exports/components/doomEditor.ts';
import { createDoomLeaderRegistry } from '../helpers/leader.ts';
import { DoomUiState } from '../../src/exports/uiState.ts';

const APP_CHORDS: Array<{ keys: string[]; action: AppKeybinding }> = [
  { keys: ['m', 'm'], action: 'app.model.select' },
  { keys: ['m', 'n'], action: 'app.model.cycleForward' },
  { keys: ['m', 't'], action: 'app.thinking.cycle' },
  { keys: ['s', 'n'], action: 'app.session.new' },
  { keys: ['s', 'r'], action: 'app.session.resume' },
  { keys: ['s', 't'], action: 'app.session.tree' },
  { keys: ['s', 'f'], action: 'app.session.fork' },
];

const COMMAND_CHORDS = [
  { keys: ['e', 't'], command: '/tools' },
  { keys: ['p', 'p'], command: '/plan' },
  { keys: ['t'], command: '/tasks' },
  { keys: ['h', 'h'], command: '/hotkeys' },
];

function createEditor(leaderOptions?: DoomEditorLeaderOptions): DoomEditor {
  const tui = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI;
  const theme = { borderColor: (text: string) => text, selectList: {} } as unknown as EditorTheme;
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as CodingKeybindingsManager;
  return new DoomEditor(
    tui,
    theme,
    keybindings,
    new DoomUiState(),
    () => undefined,
    undefined,
    undefined,
    leaderOptions ?? { registry: createDoomLeaderRegistry() },
  );
}

function enterChord(editor: DoomEditor, keys: string[]): void {
  editor.handleInput('\x00');
  for (const key of keys) editor.handleInput(key);
}

describe('DoomEditor leader chords', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(APP_CHORDS)('dispatches $action through $keys', ({ keys, action }) => {
    const editor = createEditor();
    const handler = vi.fn();
    editor.onAction(action, handler);
    editor.setText('draft');

    enterChord(editor, keys);

    expect(handler).toHaveBeenCalledOnce();
    expect(editor.getText()).toBe('draft');
  });

  it.each(COMMAND_CHORDS)('submits $command through $keys and restores the draft', ({ keys, command }) => {
    const editor = createEditor();
    const submit = vi.fn();
    editor.onSubmit = submit;
    editor.setText('draft');

    enterChord(editor, keys);

    expect(submit).toHaveBeenCalledWith(command);
    expect(editor.getText()).toBe('draft');
  });

  it('dispatches typed extension actions without slash submission and preserves the draft', () => {
    const registry = createDoomLeaderRegistry();
    registry.register({
      source: '@agimon-ai/doompi-plan',
      bindings: [
        {
          id: 'plan.normal',
          path: [
            { key: 'p', label: 'plan', order: 60 },
            { key: 'p', label: 'normal' },
          ],
          action: { name: 'plan.normal' },
        },
      ],
    });
    const onLeaderAction = vi.fn();
    const editor = createEditor({ registry, onLeaderAction });
    const submit = vi.fn();
    editor.onSubmit = submit;
    editor.setText('draft');

    enterChord(editor, ['p', 'p']);

    expect(onLeaderAction).toHaveBeenCalledWith('@agimon-ai/doompi-plan', 'plan.normal');
    expect(submit).not.toHaveBeenCalled();
    expect(editor.getText()).toBe('draft');

    const onUnavailableAction = vi.fn();
    const unavailableEditor = createEditor({ registry, onUnavailableAction });
    enterChord(unavailableEditor, ['p', 'p']);
    expect(onUnavailableAction).toHaveBeenCalledWith('@agimon-ai/doompi-plan:plan.normal');
  });
});
