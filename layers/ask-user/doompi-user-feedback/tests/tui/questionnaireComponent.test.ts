import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { CURSOR_MARKER, Key, matchesKey, type MarkdownTheme, type TUI, visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import type { QuestionParams } from '../../src/schemas/questionnaire.ts';
import { QuestionnaireComponent } from '../../src/tui/questionnaireComponent.ts';
import type { ExternalEditResult, QuestionnaireResult } from '../../src/types/questionnaire.ts';

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `**${text}**`,
} as unknown as Theme;

const markdownTheme: MarkdownTheme = {
  heading: (text) => `heading(${text})`,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => `code(${text})`,
  codeBlock: (text) => `block(${text})`,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => `bold(${text})`,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

function keybindings(): KeybindingsManager {
  return {
    matches(data: string, id: string): boolean {
      if (id === 'tui.select.cancel') {
        return matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'));
      }
      return id === 'app.editor.external' && matchesKey(data, Key.ctrl('g'));
    },
  } as unknown as KeybindingsManager;
}

const defaultParams: QuestionParams = {
  questions: [
    {
      header: 'Choice',
      question: 'Choose a value',
      options: [
        {
          label: 'Alpha',
          description: 'First option',
          preview: '# Preview\nUse **bold** and `code`.',
        },
      ],
    },
  ],
};

function createComponent(
  overrides: {
    done?: (result: QuestionnaireResult) => void;
    editExternally?: (content: string) => Promise<ExternalEditResult>;
    params?: QuestionParams;
    collapseKey?: string;
    reportProgress?: (result: QuestionnaireResult) => void;
  } = {},
): { component: QuestionnaireComponent; requestRender: ReturnType<typeof vi.fn>; tui: TUI } {
  const requestRender = vi.fn();
  const tui = {
    requestRender,
    stop: vi.fn(),
    start: vi.fn(),
    terminal: { rows: 24, columns: 80 },
  } as unknown as TUI;
  const component = new QuestionnaireComponent({
    tui,
    theme,
    markdownTheme,
    keybindings: keybindings(),
    params: overrides.params ?? defaultParams,
    collapseKey: overrides.collapseKey ?? 'ctrl+]',
    done: overrides.done ?? vi.fn(),
    editExternally: overrides.editExternally ?? (async (content) => ({ status: 'complete', content })),
    ...(overrides.reportProgress ? { reportProgress: overrides.reportProgress } : {}),
  });
  return { component, requestRender, tui };
}

function openCustomEditor(component: QuestionnaireComponent): void {
  component.handleInput('\u001b[B');
  component.handleInput('\r');
}

describe('QuestionnaireComponent', () => {
  it('renders Markdown previews and obeys narrow-width and resize contracts', () => {
    const { component } = createComponent();

    const narrow = component.render(10);
    expect(narrow.every((line) => visibleWidth(line) <= 10)).toBe(true);

    const wide = component.render(40);
    expect(wide.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(wide.join('\n')).toContain('heading(');
    expect(wide.join('\n')).toContain('bold(');
    expect(wide).not.toEqual(narrow);
  });

  it('propagates focus to the embedded editor for hardware cursor placement', () => {
    const { component } = createComponent();
    component.focused = true;
    openCustomEditor(component);

    expect(component.render(40).join('\n')).toContain(CURSOR_MARKER);
  });

  it('honors Ctrl+C cancellation in option and editor modes', () => {
    const doneFromOptions = vi.fn();
    const options = createComponent({ done: doneFromOptions }).component;
    options.handleInput('\u0003');
    expect(doneFromOptions).toHaveBeenCalledWith({ answers: [], cancelled: true });

    const doneFromEditor = vi.fn();
    const editor = createComponent({ done: doneFromEditor }).component;
    openCustomEditor(editor);
    editor.handleInput('\u0003');
    expect(doneFromEditor).not.toHaveBeenCalled();
    expect(editor.render(40).join('\n')).not.toContain('Your answer:');
  });

  it('recognizes Kitty-encoded note input', () => {
    const { component } = createComponent();
    component.handleInput('\u001b[110u');
    expect(component.render(40).join('\n')).toContain('Optional note:');
  });

  it('round-trips editor text through Ctrl+G without losing TUI state', async () => {
    const editExternally = vi.fn(async () => ({ status: 'complete' as const, content: 'external answer' }));
    const { component, tui } = createComponent({ editExternally });
    openCustomEditor(component);

    component.handleInput('\u0007');
    await vi.waitFor(() => expect(editExternally).toHaveBeenCalledWith(''));

    expect(tui.stop).toHaveBeenCalledOnce();
    expect(tui.start).toHaveBeenCalledOnce();
    expect(component.render(40).join('\n')).toContain('external answer');
  });

  it('records notes and a custom answer with progress', () => {
    const done = vi.fn();
    const reportProgress = vi.fn();
    const { component } = createComponent({ done, reportProgress });

    component.handleInput('n');
    component.handleInput('remember this');
    component.handleInput('\r');
    openCustomEditor(component);
    component.handleInput('my answer');
    component.handleInput('\r');

    expect(reportProgress).toHaveBeenCalledWith({
      answers: [expect.objectContaining({ answer: 'my answer', kind: 'custom', notes: 'remember this' })],
      cancelled: false,
    });
    expect(done).toHaveBeenCalledWith({
      answers: [expect.objectContaining({ answer: 'my answer', kind: 'custom', notes: 'remember this' })],
      cancelled: false,
    });
  });

  it('orders single and multi-select answers while navigating questions', () => {
    const done = vi.fn();
    const params: QuestionParams = {
      questions: [
        {
          header: 'One',
          question: 'Pick one',
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' },
          ],
        },
        {
          header: 'Many',
          question: 'Pick many',
          multiSelect: true,
          options: [
            { label: 'C', description: '' },
            { label: 'D', description: '' },
          ],
        },
      ],
    };
    const { component } = createComponent({ done, params });

    component.handleInput('\u001b[B');
    component.handleInput('\r');
    component.handleInput(' ');
    component.handleInput('\u001b[B');
    component.handleInput(' ');
    component.handleInput('\r');

    expect(done).toHaveBeenCalledWith({
      answers: [
        expect.objectContaining({ questionIndex: 0, answer: 'B', kind: 'option' }),
        expect.objectContaining({ questionIndex: 1, answer: null, kind: 'multi', selected: ['C', 'D'] }),
      ],
      cancelled: false,
    });
  });

  it('supports collapse, question navigation, option wrapping, and idempotent finish', () => {
    const done = vi.fn();
    const params: QuestionParams = {
      questions: [
        { header: 'One', question: 'First?', options: [{ label: 'A', description: '' }] },
        { header: 'Two', question: 'Second?', options: [{ label: 'B', description: '' }] },
      ],
    };
    const { component } = createComponent({ done, params });

    component.handleInput('\u001d');
    expect(component.render(24).join('\n')).toContain('Questionnaire');
    component.handleInput('ignored');
    component.handleInput('\u001d');
    component.handleInput('\t');
    expect(component.render(30).join('\n')).toContain('Second?');
    component.handleInput('\u001b[Z');
    expect(component.render(30).join('\n')).toContain('First?');
    component.handleInput('\u001b[A');
    component.handleInput('\r');
    component.cancel();
    component.cancel();

    expect(done).toHaveBeenCalledOnce();
  });

  it('surfaces external-editor failures and always resumes the TUI', async () => {
    const editExternally = vi.fn(async () => ({ status: 'failed' as const, message: 'editor unavailable' }));
    const { component, tui } = createComponent({ editExternally });
    openCustomEditor(component);

    component.handleInput('\u0007');
    await vi.waitFor(() => expect(component.render(40).join('\n')).toContain('editor unavailable'));

    expect(tui.stop).toHaveBeenCalledOnce();
    expect(tui.start).toHaveBeenCalledOnce();
  });
});
