import type { Theme } from '@earendil-works/pi-coding-agent';
import type { DoomOverlayTui } from '@agimon-ai/doompi-ui/components/doomOverlay';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowChoiceComponent, WorkflowInputComponent } from '../../src/tui/workflow/workflowPrompt';

const WIDTH = 100;
const KEY_UP = '\x1b[A';
const KEY_DOWN = '\x1b[B';
const KEY_ESC = '\x1b';
const KEY_ENTER = '\r';
const KEY_BACKSPACE = '\x7f';
const KEY_CLEAR = '\x15';
const BREADCRUMB = 'SPC › w / workflows › l / manage';
const SELECTION_MARKER = '›';
/** The breadcrumb uses the same glyph as the row marker, so body rows only. */
const BREADCRUMB_MARKER = 'SPC ›';

/** Pass-through theme so assertions read plain text, not colour codes. */
function createTheme(): Theme {
  const identity = (text: string): string => text;
  return {
    fg: (_colour: string, text: string) => text,
    bg: (_colour: string, text: string) => text,
    inverse: identity,
    bold: identity,
    dim: identity,
    italic: identity,
    strikethrough: identity,
    underline: identity,
  } as unknown as Theme;
}

function tui(rows = 24): DoomOverlayTui {
  return { terminal: { rows, columns: WIDTH }, requestRender: vi.fn() };
}

function createChoice(choices: string[], preselect?: string) {
  const picked: (string | undefined)[] = [];
  const component = new WorkflowChoiceComponent(
    tui(),
    createTheme(),
    { title: 'Manage auth-run', breadcrumb: BREADCRUMB, choices, ...(preselect ? { preselect } : {}) },
    (choice) => picked.push(choice),
  );
  const render = (): string[] => component.render(WIDTH);
  return {
    component,
    render,
    text: () => render().join('\n'),
    selected: () => render().find((line) => line.includes(SELECTION_MARKER) && !line.includes(BREADCRUMB_MARKER)),
    picked: () => picked,
  };
}

function createInput(fallback?: string) {
  const committed: (string | undefined)[] = [];
  const component = new WorkflowInputComponent(
    tui(),
    createTheme(),
    { title: 'Workflow input: purpose', breadcrumb: BREADCRUMB, ...(fallback ? { fallback } : {}) },
    (value) => committed.push(value),
  );
  const render = (): string[] => component.render(WIDTH);
  return {
    component,
    text: () => render().join('\n'),
    committed: () => committed,
    type: (text: string) => {
      for (const character of text) component.handleInput(character);
    },
  };
}

describe('WorkflowChoiceComponent', () => {
  it('frames the prompt with its title, breadcrumb and key legend', () => {
    const choice = createChoice(['Open output', 'Pause', 'Stop', 'Back']);

    expect(choice.render()[0]).toContain('╭');
    expect(choice.text()).toContain('WORKFLOW PROMPT');
    expect(choice.text()).toContain(BREADCRUMB);
    expect(choice.text()).toContain('Manage auth-run');
    expect(choice.text()).toContain('4 options');
    expect(choice.text()).toContain('confirm');
    expect(choice.text()).toContain('1/4');
  });

  it('moves the cursor with the arrows and clamps at both ends', () => {
    const choice = createChoice(['Open output', 'Pause', 'Back']);
    expect(choice.selected()).toContain('Open output');

    choice.component.handleInput(KEY_UP);
    expect(choice.selected()).toContain('Open output');

    choice.component.handleInput(KEY_DOWN);
    expect(choice.selected()).toContain('Pause');

    for (let press = 0; press < 5; press += 1) choice.component.handleInput(KEY_DOWN);
    expect(choice.selected()).toContain('Back');
  });

  it('commits the option under the cursor and cancels on escape', () => {
    const choice = createChoice(['Open output', 'Pause', 'Back']);
    choice.component.handleInput(KEY_DOWN);
    choice.component.handleInput(KEY_ENTER);
    expect(choice.picked()).toEqual(['Pause']);

    choice.component.handleInput(KEY_ESC);
    expect(choice.picked()).toEqual(['Pause', undefined]);
  });

  it('starts on the preselected option and marks it as the default', () => {
    const choice = createChoice(['conversion', 'awareness'], 'awareness');

    expect(choice.selected()).toContain('awareness');
    expect(choice.text()).toContain('default');
    choice.component.handleInput(KEY_ENTER);
    expect(choice.picked()).toEqual(['awareness']);
  });

  it('says so rather than rendering an empty body when there is nothing to choose', () => {
    const choice = createChoice([]);

    expect(choice.text()).toContain('No options are available.');
    expect(choice.text()).toContain('no options');
    choice.component.handleInput(KEY_ENTER);
    expect(choice.picked()).toEqual([]);
  });

  it('scrolls so a list longer than the body keeps the cursor on screen', () => {
    const many = Array.from({ length: 60 }, (_, index) => `option-${index}`);
    const choice = createChoice(many);
    for (let press = 0; press < 40; press += 1) choice.component.handleInput(KEY_DOWN);

    expect(choice.selected()).toContain('option-40');
    expect(choice.text()).toContain('41/60');
  });
});

describe('WorkflowInputComponent', () => {
  it('frames the field with its title and shows what is typed', () => {
    const input = createInput();
    input.type('asset-7');

    expect(input.text()).toContain('WORKFLOW PROMPT');
    expect(input.text()).toContain('Workflow input: purpose');
    expect(input.text()).toContain('asset-7');
    expect(input.text()).toContain('no default');
  });

  it('edits with backspace and clears with ctrl+u', () => {
    const input = createInput();
    input.type('asset-7');
    input.component.handleInput(KEY_BACKSPACE);
    expect(input.text()).toContain('asset-');

    input.component.handleInput(KEY_CLEAR);
    input.component.handleInput(KEY_ENTER);
    expect(input.committed()).toEqual(['']);
  });

  it('commits the typed value, trimmed', () => {
    const input = createInput();
    input.type('  asset-7  ');
    input.component.handleInput(KEY_ENTER);

    expect(input.committed()).toEqual(['asset-7']);
  });

  // The caller offered a default, and pressing enter is how you accept it.
  it('commits the fallback when the field is left empty, and shows it', () => {
    const input = createInput('conversion');

    expect(input.text()).toContain('default conversion');
    input.component.handleInput(KEY_ENTER);
    expect(input.committed()).toEqual(['conversion']);
  });

  it('prefers what was typed over the fallback, and cancels on escape', () => {
    const input = createInput('conversion');
    input.type('awareness');
    input.component.handleInput(KEY_ENTER);
    expect(input.committed()).toEqual(['awareness']);

    input.component.handleInput(KEY_ESC);
    expect(input.committed()).toEqual(['awareness', undefined]);
  });
});
