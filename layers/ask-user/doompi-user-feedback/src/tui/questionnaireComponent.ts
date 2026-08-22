import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import {
  Editor,
  Key,
  Markdown,
  matchesKey,
  type Focusable,
  type MarkdownTheme,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type { QuestionData, QuestionParams } from '../schemas/questionnaire.js';
import type { ExternalEditResult, QuestionAnswer, QuestionnaireResult } from '../types/questionnaire.js';

export interface QuestionnaireComponentOptions {
  tui: TUI;
  theme: Theme;
  markdownTheme: MarkdownTheme;
  keybindings: KeybindingsManager;
  params: QuestionParams;
  collapseKey: string;
  done: (result: QuestionnaireResult) => void;
  editExternally: (content: string) => Promise<ExternalEditResult>;
  reportProgress?: (result: QuestionnaireResult) => void;
}

type EditorMode = 'custom' | 'notes';

const SELECT_CANCEL_KEYBINDING = 'tui.select.cancel';
const EXTERNAL_EDITOR_KEYBINDING = 'app.editor.external';

export class QuestionnaireComponent implements Focusable {
  private readonly answers = new Map<number, QuestionAnswer>();
  private readonly selectedOptions = new Map<number, Set<number>>();
  private readonly notes = new Map<number, string>();
  private readonly editor: Editor;
  private currentQuestion = 0;
  private currentOption = 0;
  private editorMode: EditorMode | undefined;
  private collapsed = false;
  private settled = false;
  private externalEditorError: string | undefined;
  private cachedLines: string[] | undefined;
  private cachedWidth: number | undefined;
  private isFocused = false;

  constructor(private readonly options: QuestionnaireComponentOptions) {
    this.editor = new Editor(options.tui, {
      borderColor: (text) => options.theme.fg('accent', text),
      selectList: {
        selectedPrefix: (text) => options.theme.fg('accent', text),
        selectedText: (text) => options.theme.fg('accent', text),
        description: (text) => options.theme.fg('muted', text),
        scrollInfo: (text) => options.theme.fg('dim', text),
        noMatch: (text) => options.theme.fg('warning', text),
      },
    });
    this.editor.onSubmit = (value) => this.submitEditor(value);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.editor.focused = value;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }

  cancel(): void {
    this.finish(true);
  }

  handleInput(data: string): void {
    if (this.settled) return;

    if (
      this.options.collapseKey !== 'off' &&
      matchesKey(data, this.options.collapseKey as Parameters<typeof matchesKey>[1])
    ) {
      this.collapsed = !this.collapsed;
      this.refresh();
      return;
    }

    if (this.collapsed) return;

    if (this.editorMode) {
      if (this.options.keybindings.matches(data, SELECT_CANCEL_KEYBINDING)) {
        this.editorMode = undefined;
        this.externalEditorError = undefined;
        this.editor.setText('');
        this.refresh();
        return;
      }
      if (this.options.keybindings.matches(data, EXTERNAL_EDITOR_KEYBINDING)) {
        void this.openExternalEditor();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }

    if (this.options.keybindings.matches(data, SELECT_CANCEL_KEYBINDING)) {
      this.cancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveOption(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveOption(1);
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.moveQuestion(1);
      return;
    }
    if (matchesKey(data, Key.shift('tab')) || matchesKey(data, Key.left)) {
      this.moveQuestion(-1);
      return;
    }
    if (matchesKey(data, 'n') || matchesKey(data, Key.shift('n'))) {
      this.openEditor('notes');
      return;
    }
    if (matchesKey(data, Key.space) || data === ' ') {
      this.toggleCurrentOption();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.confirmCurrentSelection();
    }
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    if (this.cachedLines && this.cachedWidth === renderWidth) return this.cachedLines;
    this.cachedWidth = renderWidth;
    if (this.collapsed) {
      const lines: string[] = [];
      const answerCount = this.answers.size;
      this.addWrapped(
        lines,
        '',
        this.options.theme.fg(
          'accent',
          `▸ Questionnaire (${answerCount}/${this.options.params.questions.length} answered) — ${this.options.collapseKey} to expand`,
        ),
        renderWidth,
      );
      this.cachedLines = lines;
      return lines;
    }

    const lines: string[] = [];
    const question = this.question();
    const border = this.options.theme.fg('accent', '─'.repeat(renderWidth));
    lines.push(border);
    this.addWrapped(lines, ' ', this.renderTabs(), renderWidth);
    lines.push('');
    this.addWrapped(lines, ' ', this.options.theme.bold(question.question), renderWidth);
    lines.push('');

    this.renderOptions(lines, question, renderWidth);
    this.renderPreview(lines, question, renderWidth);
    this.renderNotes(lines, renderWidth);
    this.renderEditor(lines, renderWidth);
    lines.push('');
    this.addWrapped(lines, ' ', this.helpText(question), renderWidth);
    lines.push(border);
    this.cachedLines = lines;
    return lines;
  }

  private question(): QuestionData {
    const question = this.options.params.questions[this.currentQuestion];
    if (!question) throw new Error('Questionnaire has no active question');
    return question;
  }

  private optionCount(question: QuestionData): number {
    return question.options.length + 1;
  }

  private renderTabs(): string {
    const tabs = this.options.params.questions.map((question, index) => {
      const mark = this.answers.has(index) ? '✓' : '○';
      const label = ` ${mark} ${question.header} `;
      return index === this.currentQuestion
        ? this.options.theme.bg('selectedBg', this.options.theme.fg('text', label))
        : this.options.theme.fg(this.answers.has(index) ? 'success' : 'muted', label);
    });
    return tabs.join(' ');
  }

  private renderOptions(lines: string[], question: QuestionData, width: number): void {
    const selected = this.selectedOptions.get(this.currentQuestion) ?? new Set<number>();
    question.options.forEach((option, index) => {
      const focused = index === this.currentOption;
      const checked = question.multiSelect ? (selected.has(index) ? '[x]' : '[ ]') : `${index + 1}.`;
      const prefix = focused ? this.options.theme.fg('accent', '> ') : '  ';
      const label = `${checked} ${option.label}`;
      this.addWrapped(lines, prefix, this.options.theme.fg(focused ? 'accent' : 'text', label), width);
      if (option.description) {
        this.addWrapped(lines, '      ', this.options.theme.fg('muted', option.description), width);
      }
    });

    const customIndex = question.options.length;
    const customFocused = this.currentOption === customIndex;
    this.addWrapped(
      lines,
      customFocused ? this.options.theme.fg('accent', '> ') : '  ',
      this.options.theme.fg(customFocused ? 'accent' : 'text', '✎ Type something.'),
      width,
    );
  }

  private renderPreview(lines: string[], question: QuestionData, width: number): void {
    if (this.currentOption >= question.options.length) return;
    const preview = question.options[this.currentOption]?.preview;
    if (!preview) return;
    lines.push('');
    this.addWrapped(lines, ' ', this.options.theme.fg('accent', this.options.theme.bold('Preview')), width);
    const markdown = new Markdown(
      preview,
      0,
      0,
      this.options.markdownTheme,
      { color: (text) => this.options.theme.fg('muted', text) },
      { preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
    );
    for (const previewLine of markdown.render(Math.max(1, width - 3))) {
      this.addWrapped(lines, ' │ ', previewLine || ' ', width);
    }
  }

  private renderNotes(lines: string[], width: number): void {
    const note = this.notes.get(this.currentQuestion);
    if (!note || this.editorMode === 'notes') return;
    lines.push('');
    this.addWrapped(lines, ' ', this.options.theme.fg('muted', `Note: ${note}`), width);
  }

  private renderEditor(lines: string[], width: number): void {
    if (!this.editorMode) return;
    lines.push('');
    const label = this.editorMode === 'custom' ? 'Your answer:' : 'Optional note:';
    this.addWrapped(lines, ' ', this.options.theme.fg('muted', label), width);
    for (const line of this.editor.render(Math.max(1, width - 2))) {
      lines.push(truncateToWidth(` ${line}`, width, ''));
    }
    if (this.externalEditorError) {
      this.addWrapped(lines, ' ', this.options.theme.fg('warning', this.externalEditorError), width);
    }
  }

  private helpText(question: QuestionData): string {
    if (this.editorMode) return 'Enter submit • Esc/Ctrl+C return • Ctrl+G external editor';
    const selectionHelp = question.multiSelect ? 'Space toggle • Enter confirm' : 'Enter select';
    return `Tab/←→ questions • ↑↓ options • ${selectionHelp} • N note • Esc/Ctrl+C cancel`;
  }

  private addWrapped(lines: string[], prefix: string, text: string, width: number): void {
    const prefixWidth = Math.min(visibleWidth(prefix), Math.max(0, width - 1));
    const renderedPrefix = truncateToWidth(prefix, prefixWidth, '');
    const available = Math.max(1, width - prefixWidth);
    const wrapped = wrapTextWithAnsi(text, available);
    if (wrapped.length === 0) {
      lines.push(renderedPrefix);
      return;
    }
    for (let index = 0; index < wrapped.length; index += 1) {
      const linePrefix = index === 0 ? renderedPrefix : ' '.repeat(prefixWidth);
      lines.push(truncateToWidth(`${linePrefix}${wrapped[index]}`, width, ''));
    }
  }

  private moveOption(delta: number): void {
    const count = this.optionCount(this.question());
    this.currentOption = (this.currentOption + delta + count) % count;
    this.refresh();
  }

  private moveQuestion(delta: number): void {
    const count = this.options.params.questions.length;
    this.currentQuestion = (this.currentQuestion + delta + count) % count;
    this.currentOption = 0;
    this.refresh();
  }

  private toggleCurrentOption(): void {
    const question = this.question();
    if (!question.multiSelect || this.currentOption >= question.options.length) return;
    const selected = this.selectedOptions.get(this.currentQuestion) ?? new Set<number>();
    if (selected.has(this.currentOption)) selected.delete(this.currentOption);
    else selected.add(this.currentOption);
    this.selectedOptions.set(this.currentQuestion, selected);
    this.refresh();
  }

  private confirmCurrentSelection(): void {
    const question = this.question();
    if (this.currentOption === question.options.length) {
      this.openEditor('custom');
      return;
    }

    if (question.multiSelect) {
      const selected = this.selectedOptions.get(this.currentQuestion) ?? new Set<number>();
      if (selected.size === 0) selected.add(this.currentOption);
      const labels = [...selected]
        .sort((left, right) => left - right)
        .flatMap((index) => (question.options[index] ? [question.options[index].label] : []));
      this.recordAnswer({
        questionIndex: this.currentQuestion,
        question: question.question,
        kind: 'multi',
        answer: null,
        selected: labels,
        ...this.noteFields(),
      });
      return;
    }

    const option = question.options[this.currentOption];
    if (!option) return;
    this.recordAnswer({
      questionIndex: this.currentQuestion,
      question: question.question,
      kind: 'option',
      answer: option.label,
      ...(option.preview ? { preview: option.preview } : {}),
      ...this.noteFields(),
    });
  }

  private openEditor(mode: EditorMode): void {
    this.editorMode = mode;
    this.externalEditorError = undefined;
    this.editor.setText(mode === 'notes' ? (this.notes.get(this.currentQuestion) ?? '') : '');
    this.refresh();
  }

  private async openExternalEditor(): Promise<void> {
    const editorMode = this.editorMode;
    if (!editorMode) return;
    this.options.tui.stop();
    try {
      const result = await this.options.editExternally(this.editor.getText());
      if (this.settled || this.editorMode !== editorMode) return;
      if (result.status === 'complete') {
        this.editor.setText(result.content);
        this.externalEditorError = undefined;
      } else {
        this.externalEditorError = result.message;
      }
    } catch (error) {
      this.externalEditorError = `External editor failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.options.tui.start();
      this.refresh();
    }
  }

  private submitEditor(value: string): void {
    const mode = this.editorMode;
    this.editorMode = undefined;
    this.editor.setText('');
    if (mode === 'notes') {
      const trimmed = value.trim();
      if (trimmed) this.notes.set(this.currentQuestion, trimmed);
      else this.notes.delete(this.currentQuestion);
      const answer = this.answers.get(this.currentQuestion);
      if (answer) {
        this.answers.set(this.currentQuestion, {
          ...answer,
          ...(trimmed ? { notes: trimmed } : { notes: undefined }),
        });
        this.reportProgress();
      }
      this.refresh();
      return;
    }
    if (mode === 'custom') {
      this.recordAnswer({
        questionIndex: this.currentQuestion,
        question: this.question().question,
        kind: 'custom',
        answer: value,
        ...this.noteFields(),
      });
    }
  }

  private noteFields(): { notes?: string } {
    const note = this.notes.get(this.currentQuestion);
    return note ? { notes: note } : {};
  }

  private recordAnswer(answer: QuestionAnswer): void {
    this.answers.set(this.currentQuestion, answer);
    this.reportProgress();
    if (this.answers.size === this.options.params.questions.length) {
      this.finish(false);
      return;
    }
    const next = this.options.params.questions.findIndex(
      (_question, index) => index > this.currentQuestion && !this.answers.has(index),
    );
    this.currentQuestion =
      next >= 0 ? next : this.options.params.questions.findIndex((_question, index) => !this.answers.has(index));
    this.currentOption = 0;
    this.refresh();
  }

  private orderedAnswers(): QuestionAnswer[] {
    return [...this.answers.values()]
      .sort((left, right) => left.questionIndex - right.questionIndex)
      .map((answer) => ({ ...answer }));
  }

  private reportProgress(): void {
    this.options.reportProgress?.({ answers: this.orderedAnswers(), cancelled: false });
  }

  private finish(cancelled: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.options.done({ answers: this.orderedAnswers(), cancelled });
  }

  private refresh(): void {
    this.invalidate();
    this.options.tui.requestRender();
  }
}
