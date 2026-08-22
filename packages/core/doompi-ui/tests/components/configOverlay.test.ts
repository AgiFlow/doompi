import type { Theme } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { ConfigOverlayComponent, type DoomConfigStoreView } from '../../src/exports/components/configOverlay.ts';
import type { ConfigField, DoomConfigInvocation, DoomConfigSectionView } from '../../src/exports/config.ts';

/** Definite accessor so a fixture drifting out of shape fails loudly here. */
function fieldOf(list: readonly DoomConfigSectionView[], sectionIndex: number, fieldIndex: number): ConfigField {
  const field = list[sectionIndex]?.fields[fieldIndex];
  if (!field) throw new Error(`fixture has no field ${sectionIndex}.${fieldIndex}`);
  return field;
}

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

const KEY_ENTER = '\r';
const KEY_TAB = '\t';
const KEY_ESCAPE = '\x1b';
const KEY_BACKSPACE = '\x7f';
const KEY_DOWN = '\x1b[B';
const KEY_CTRL_C = '\x03';

function sections(): DoomConfigSectionView[] {
  return [
    {
      source: '@agimon-ai/doompi-file-edit',
      id: 'editor',
      title: 'editor',
      order: 10,
      fields: [
        { id: 'resolved', label: 'resolved', kind: 'info', value: 'configured' },
        {
          id: 'command',
          label: 'command',
          kind: 'text',
          placeholder: 'nvim +{line} {file}',
          detail: 'Launched from the file-edits overlay.',
          keyPath: 'editor.command',
        },
      ],
    },
    {
      source: '@agimon-ai/doompi-voice',
      id: 'voice',
      title: 'voice',
      order: 20,
      notice: 'no model installed',
      noticeLevel: 'error',
      fields: [
        {
          id: 'model',
          label: 'model',
          kind: 'choice',
          choices: [
            { id: 'tiny', label: 'tiny', group: 'whisper-cpp', detail: '75 MB', action: 'install' },
            { id: 'small', label: 'small', group: 'whisper-cpp', detail: '466 MB', action: 'select' },
          ],
        },
      ],
    },
  ];
}

function createOverlay(initial: DoomConfigSectionView[] = sections()) {
  let current = initial;
  let listener: (() => void) | undefined;
  const invocations: DoomConfigInvocation[] = [];
  const registry = {
    getSections: () => current,
    subscribe: (next: () => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    invoke: (invocation: DoomConfigInvocation) => invocations.push(invocation),
  } satisfies DoomConfigStoreView;
  const tui = { terminal: { rows: 24, columns: 120 }, requestRender: vi.fn() };
  const done = vi.fn();
  const overlay = new ConfigOverlayComponent(tui, theme, registry, done);
  const publish = (next: DoomConfigSectionView[]): void => {
    current = next;
    listener?.();
  };
  return { done, invocations, overlay, publish, tui };
}

/** Puts the cursor on the named field of the section already selected. */
function focusField(overlay: ConfigOverlayComponent, steps: number): void {
  overlay.handleInput(KEY_TAB);
  for (let index = 0; index < steps; index += 1) overlay.handleInput(KEY_DOWN);
}

describe('ConfigOverlayComponent', () => {
  it('lists every contributed section with the owning package', () => {
    const { overlay } = createOverlay();
    const rendered = overlay.render(120).join('\n');
    expect(rendered).toContain('CONFIG');
    expect(rendered).toContain('editor');
    expect(rendered).toContain('voice');
    expect(rendered).toContain('@agimon-ai/doompi-file-edit');
  });

  it('points at help mode for what a setting means, without stealing rows from the fields', () => {
    const { overlay } = createOverlay();

    const rendered = overlay.render(120);

    expect(rendered.join('\n')).toContain('SPC h e');
    // Last row of the body, which the frame follows with a divider and its footer.
    expect(rendered.at(-4)).toContain('HELP');
  });

  it('drops the help banner rather than the fields on a short terminal', () => {
    const { overlay, tui } = createOverlay();
    tui.terminal.rows = 12;

    const rendered = overlay.render(120).join('\n');

    expect(rendered).not.toContain('SPC h e');
    expect(rendered).toContain('editor');
  });

  it('shows the placeholder for an unset field and its key path when focused', () => {
    const { overlay } = createOverlay();
    focusField(overlay, 0);
    const rendered = overlay.render(120).join('\n');
    expect(rendered).toContain('nvim +{line} {file}');
    expect(rendered).toContain('editor.command');
    expect(rendered).toContain('Launched from the file-edits overlay.');
  });

  it('renders a section notice', () => {
    const { overlay } = createOverlay();
    overlay.handleInput(KEY_DOWN);
    expect(overlay.render(120).join('\n')).toContain('no model installed');
  });

  it('sends the typed value and keeps the draft until the owner answers', () => {
    const { invocations, overlay, publish } = createOverlay();
    focusField(overlay, 0);
    overlay.handleInput(KEY_ENTER);
    for (const character of 'nvi') overlay.handleInput(character);
    overlay.handleInput('x');
    overlay.handleInput(KEY_BACKSPACE);
    expect(overlay.render(120).join('\n')).toContain('nvi');

    overlay.handleInput(KEY_ENTER);
    expect(invocations).toEqual([
      { source: '@agimon-ai/doompi-file-edit', sectionId: 'editor', fieldId: 'command', action: 'set', value: 'nvi' },
    ]);

    // A rejected value comes back with the reason, and the draft survives so the
    // typing is not thrown away.
    const rejected = sections();
    Object.assign(fieldOf(rejected, 0, 1), { statusText: 'Unsupported editor placeholder' });
    publish(rejected);
    const rendered = overlay.render(120).join('\n');
    expect(rendered).toContain('Unsupported editor placeholder');
    expect(rendered).toContain('nvi');
  });

  it('leaves edit mode when the owner answers cleanly', () => {
    const { overlay, publish } = createOverlay();
    focusField(overlay, 0);
    overlay.handleInput(KEY_ENTER);
    overlay.handleInput('v');
    overlay.handleInput(KEY_ENTER);

    const accepted = sections();
    Object.assign(fieldOf(accepted, 0, 1), { value: 'v' });
    publish(accepted);
    expect(overlay.render(120).join('\n')).toContain('enter');
  });

  it('clears a field with d and never closes on it', () => {
    const { done, invocations, overlay } = createOverlay();
    focusField(overlay, 0);
    overlay.handleInput('d');
    expect(invocations[0]).toMatchObject({ action: 'clear', fieldId: 'command' });
    expect(done).not.toHaveBeenCalled();
  });

  it('escapes edit mode without sending anything', () => {
    const { done, invocations, overlay } = createOverlay();
    focusField(overlay, 0);
    overlay.handleInput(KEY_ENTER);
    overlay.handleInput('z');
    overlay.handleInput(KEY_ESCAPE);
    expect(invocations).toEqual([]);
    expect(done).not.toHaveBeenCalled();
  });

  it("uses each choice's own action, so one list can install or merely select", () => {
    const { invocations, overlay } = createOverlay();
    overlay.handleInput(KEY_DOWN);
    overlay.handleInput(KEY_TAB);
    overlay.handleInput(KEY_ENTER);
    const rendered = overlay.render(120).join('\n');
    expect(rendered).toContain('whisper-cpp');
    expect(rendered).toContain('75 MB');
    expect(rendered).toContain('install');

    overlay.handleInput(KEY_ENTER);
    expect(invocations[0]).toMatchObject({ action: 'install', value: 'tiny', fieldId: 'model' });

    overlay.handleInput(KEY_ENTER);
    overlay.handleInput(KEY_DOWN);
    overlay.handleInput(KEY_ENTER);
    expect(invocations[1]).toMatchObject({ action: 'select', value: 'small' });
  });

  it('leaves the choice list on escape without choosing', () => {
    const { invocations, overlay } = createOverlay();
    overlay.handleInput(KEY_DOWN);
    overlay.handleInput(KEY_TAB);
    overlay.handleInput(KEY_ENTER);
    overlay.handleInput(KEY_ESCAPE);
    expect(invocations).toEqual([]);
  });

  it('offers the owner-supplied keys while a field carries them', () => {
    const withConfirm = sections();
    Object.assign(fieldOf(withConfirm, 1, 0), {
      actions: [
        { key: 'y', label: 'install', action: 'confirm' },
        { key: 'n', label: 'cancel', action: 'cancel' },
      ],
    });
    const { invocations, overlay } = createOverlay(withConfirm);
    overlay.handleInput(KEY_DOWN);
    overlay.handleInput(KEY_TAB);
    expect(overlay.render(120).join('\n')).toContain('install');

    overlay.handleInput('y');
    expect(invocations[0]).toMatchObject({ action: 'confirm', fieldId: 'model' });
  });

  it('renders progress and aborts with ctrl+c while busy', () => {
    const busy = sections();
    Object.assign(fieldOf(busy, 1, 0), {
      busy: true,
      progress: { label: 'downloading ggml-tiny.bin', ratio: 0.5 },
    });
    const { done, invocations, overlay } = createOverlay(busy);
    overlay.handleInput(KEY_DOWN);
    overlay.handleInput(KEY_TAB);
    const rendered = overlay.render(120).join('\n');
    expect(rendered).toContain('downloading ggml-tiny.bin');
    expect(rendered).toContain('50%');

    overlay.handleInput(KEY_CTRL_C);
    expect(invocations[0]).toMatchObject({ action: 'abort' });
    // Aborting is not closing: the panel stays up to report the outcome.
    expect(done).not.toHaveBeenCalled();
  });

  it('backs out of the fields pane before closing', () => {
    const { done, overlay } = createOverlay();
    overlay.handleInput(KEY_TAB);
    overlay.handleInput(KEY_ESCAPE);
    expect(done).not.toHaveBeenCalled();
    overlay.handleInput(KEY_ESCAPE);
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it('renders an empty registry and a narrow terminal without throwing', () => {
    const { done, overlay } = createOverlay([]);
    expect(overlay.render(120).join('\n')).toContain('No extension has contributed');
    expect(() => overlay.render(40)).not.toThrow();
    overlay.handleInput(KEY_ENTER);
    overlay.handleInput('d');
    overlay.handleInput(KEY_CTRL_C);
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it('stops listening once disposed', () => {
    const { overlay, publish, tui } = createOverlay();
    overlay.dispose();
    const before = tui.requestRender.mock.calls.length;
    publish([]);
    expect(tui.requestRender.mock.calls.length).toBe(before);
  });
});
