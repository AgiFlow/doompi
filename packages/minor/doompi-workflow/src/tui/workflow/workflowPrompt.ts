/**
 * The short prompts: pick one of a few options, or type one value.
 *
 * These were `ui.select` and `ui.input`, which meant the run manager, the runner
 * picker and every `workflow_dispatch` input rendered as native Pi widgets in the
 * middle of a flow whose other steps are framed doom overlays. Same surface for
 * all of them now, so a launch reads as one sequence rather than three styles.
 *
 * Rendering is pure, so both modes can be asserted as text without a terminal.
 */

import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey } from '@earendil-works/pi-tui';
import {
  DOOM_FULLSCREEN_UI_OPTIONS,
  DOOM_OVERLAY_ACCENT,
  DoomOverlay,
  type DoomOverlayChrome,
  type DoomOverlayTui,
} from './doomOverlay.ts';
import { CURSOR_BLOCK, fit, isControlInput, rightAligned, SELECTION_MARKER } from './overlayText';

export const WORKFLOW_PROMPT_OVERLAY_OPTIONS = DOOM_FULLSCREEN_UI_OPTIONS.overlayOptions;

const CHOICE_TITLE = 'WORKFLOW PROMPT';
const CHOOSE_LABEL = 'CHOOSE';
const VALUE_LABEL = 'VALUE';
const DEFAULT_MARKER = 'default';
const EMPTY_CHOICES = 'No options are available.';
const CHOICE_HINTS: readonly (readonly [string, string])[] = [
  ['↑↓', 'select'],
  ['enter', 'confirm'],
  ['esc', 'cancel'],
];
const INPUT_HINTS: readonly (readonly [string, string])[] = [
  ['type', 'edit'],
  ['enter', 'confirm'],
  ['ctrl+u', 'clear'],
  ['esc', 'cancel'],
];
const KEY_CLEAR = '\x15';
/** Rows the heading and its spacer take before the first option. */
const HEADING_ROWS = 2;

/** Neither palette name is exported, so take both from the theme's methods. */
type ThemeBg = Parameters<Theme['bg']>[0];
type ThemeColor = Parameters<Theme['fg']>[0];

const DIM: ThemeColor = 'dim';
const ACCENT: ThemeColor = 'accent';
const SELECTED_BG: ThemeBg = 'selectedBg';
const ROW_BG: ThemeBg = 'userMessageBg';

export interface WorkflowChoiceOptions {
  title: string;
  breadcrumb: string;
  choices: readonly string[];
  /** Marked `default` in the list and pre-selected. */
  preselect?: string;
}

export interface WorkflowInputOptions {
  title: string;
  breadcrumb: string;
  /** Committed when the field is left empty, and shown beside the label. */
  fallback?: string;
}

export class WorkflowChoiceComponent extends DoomOverlay {
  private selected: number;

  constructor(
    tui: DoomOverlayTui,
    theme: Theme,
    private readonly options: WorkflowChoiceOptions,
    private readonly done: (choice: string | undefined) => void,
  ) {
    super(tui, theme);
    this.selected = Math.max(0, options.preselect ? options.choices.indexOf(options.preselect) : 0);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, 'enter')) {
      const choice = this.options.choices[this.selected];
      if (choice !== undefined) this.done(choice);
      return;
    }
    const count = this.options.choices.length;
    if (count === 0) return;
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n'))
      this.selected = Math.min(count - 1, this.selected + 1);
    else return;
    this.tui.requestRender();
  }

  protected getChrome(): DoomOverlayChrome {
    return {
      title: CHOICE_TITLE,
      accent: DOOM_OVERLAY_ACCENT,
      breadcrumb: this.options.breadcrumb,
      headerRight: `${this.options.choices.length} options`,
      footer: '↑↓ select · enter confirm · esc cancel',
      footerHints: CHOICE_HINTS,
      footerRight:
        this.options.choices.length > 0 ? `${this.selected + 1}/${this.options.choices.length}` : 'no options',
    };
  }

  protected renderBody(width: number, height: number): string[] {
    const lines = [this.theme.bold(fit(this.options.title, width)), ''];
    if (this.options.choices.length === 0) {
      lines.push(this.theme.fg(DIM, EMPTY_CHOICES));
      return lines.slice(0, height);
    }

    lines.push(this.theme.fg(DIM, CHOOSE_LABEL));
    // The window follows the cursor, so a list longer than the body still scrolls.
    const capacity = Math.max(1, height - HEADING_ROWS - 1);
    const start = Math.max(
      0,
      Math.min(this.selected - capacity + 1, Math.max(0, this.options.choices.length - capacity)),
    );
    for (const [offset, choice] of this.options.choices.slice(start, start + capacity).entries()) {
      const current = start + offset === this.selected;
      const marker = current ? this.theme.fg(ACCENT, SELECTION_MARKER) : ' ';
      const label = current ? this.theme.bold(choice) : choice;
      const note = choice === this.options.preselect ? this.theme.fg(DIM, DEFAULT_MARKER) : '';
      const background: ThemeBg = current ? SELECTED_BG : ROW_BG;
      lines.push(this.theme.bg(background, rightAligned(`${marker} ${label}`, note, width)));
    }
    return lines.slice(0, height);
  }
}

export class WorkflowInputComponent extends DoomOverlay {
  private draft = '';

  constructor(
    tui: DoomOverlayTui,
    theme: Theme,
    private readonly options: WorkflowInputOptions,
    private readonly done: (value: string | undefined) => void,
  ) {
    super(tui, theme);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, 'enter')) {
      // An empty field commits the fallback rather than an empty string: the
      // caller offered a default, and pressing enter is how you accept it.
      this.done(this.draft.trim() || this.options.fallback || '');
      return;
    }
    if (matchesKey(data, 'backspace')) this.draft = this.draft.slice(0, -1);
    else if (data === KEY_CLEAR) this.draft = '';
    else if (!isControlInput(data)) this.draft += data;
    else return;
    this.tui.requestRender();
  }

  protected getChrome(): DoomOverlayChrome {
    return {
      title: CHOICE_TITLE,
      accent: DOOM_OVERLAY_ACCENT,
      breadcrumb: this.options.breadcrumb,
      headerRight: this.options.fallback ? `default ${this.options.fallback}` : 'no default',
      footer: 'type to edit · enter confirm · ctrl+u clear · esc cancel',
      footerHints: INPUT_HINTS,
    };
  }

  protected renderBody(width: number, height: number): string[] {
    const label = this.options.fallback
      ? rightAligned(
          this.theme.fg(DIM, VALUE_LABEL),
          this.theme.fg(DIM, `${DEFAULT_MARKER} ${this.options.fallback}`),
          width,
        )
      : this.theme.fg(DIM, VALUE_LABEL);
    return [
      this.theme.bold(fit(this.options.title, width)),
      '',
      label,
      this.theme.bg(SELECTED_BG, fit(` ${this.draft}${CURSOR_BLOCK}`, width)),
    ].slice(0, height);
  }
}

export async function openWorkflowChoice(
  ctx: ExtensionContext,
  options: WorkflowChoiceOptions,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (tui, theme, _keybindings, done) => new WorkflowChoiceComponent(tui, theme, options, done),
    DOOM_FULLSCREEN_UI_OPTIONS,
  );
}

export async function openWorkflowInput(
  ctx: ExtensionContext,
  options: WorkflowInputOptions,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (tui, theme, _keybindings, done) => new WorkflowInputComponent(tui, theme, options, done),
    DOOM_FULLSCREEN_UI_OPTIONS,
  );
}
