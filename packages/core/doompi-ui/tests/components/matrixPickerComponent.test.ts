import type { Theme } from '@earendil-works/pi-coding-agent';
import type { KeybindingsManager, SelectItem } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import { MatrixPickerComponent } from '../../src/exports/components/matrixPicker.ts';

const ITEMS: SelectItem[] = [
  { value: 'development', label: 'development' },
  { value: 'design', label: 'design' },
  { value: 'marketing', label: 'marketing' },
];

const UP = '[A';
const DOWN = '[B';
const ENTER = '\r';
const ESCAPE = '';
const SPACE = ' ';

/** Only the theme surface the component touches. */
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

/** Maps the four navigation actions onto the escape sequences above. */
const keybindings = {
  matches: (data: string, action: string) =>
    (action === 'tui.select.up' && data === UP) ||
    (action === 'tui.select.down' && data === DOWN) ||
    (action === 'tui.select.confirm' && data === ENTER) ||
    (action === 'tui.select.cancel' && data === ESCAPE),
} as unknown as KeybindingsManager;

function createPicker(overrides: { multi?: boolean; selected?: string[]; items?: SelectItem[] } = {}): {
  picker: MatrixPickerComponent;
  done: ReturnType<typeof vi.fn>;
} {
  const done = vi.fn();
  const picker = new MatrixPickerComponent(
    {
      title: 'Domains',
      items: overrides.items ?? ITEMS,
      selected: overrides.selected ?? [],
      multi: overrides.multi ?? false,
    },
    theme,
    keybindings,
    done,
  );
  return { picker, done };
}

/** The rendered row labels, which is what a selection marker shows up in. */
function labels(picker: MatrixPickerComponent): string[] {
  const { list } = picker as unknown as { list: { getItems?: () => SelectItem[]; items?: SelectItem[] } };
  const items = list.getItems ? list.getItems() : (list.items ?? []);
  return items.map((item) => item.label);
}

describe('MatrixPickerComponent', () => {
  it('uses Doom border, heading, and selection colors', () => {
    const decoratedTheme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bg: (color: string, text: string) => `<bg:${color}>${text}</bg:${color}>`,
      bold: (text: string) => text,
    } as unknown as Theme;
    const picker = new MatrixPickerComponent(
      { title: 'Domains', items: ITEMS, selected: [], multi: false },
      decoratedTheme,
      keybindings,
      vi.fn(),
    );
    const rendered = picker.render(60).join('\n');

    expect(picker.render(0)).toBeDefined();
    expect(rendered).toContain('<borderAccent>');
    expect(rendered).toContain('<mdHeading>Domains</mdHeading>');
    expect(rendered).toContain('<bg:selectedBg>');
  });

  it('renders single-select rows without markers', () => {
    const { picker } = createPicker({ selected: ['design'] });

    expect(labels(picker)).toEqual(['development', 'design', 'marketing']);
  });

  it('renders multi-select rows with the preselected row marked', () => {
    const { picker } = createPicker({ multi: true, selected: ['design'] });

    expect(labels(picker)).toEqual(['[ ] development', '[x] design', '[ ] marketing']);
  });

  it('toggles the cursor row on space and leaves the rest of the selection alone', () => {
    // The cursor opens on the preselected row, so this moves off it first.
    const { picker } = createPicker({ multi: true, selected: ['design'] });

    picker.handleInput(DOWN);
    picker.handleInput(SPACE);

    expect(labels(picker)).toEqual(['[ ] development', '[x] design', '[x] marketing']);
  });

  it('untoggles a row that is already selected', () => {
    const { picker } = createPicker({ multi: true, selected: ['development'] });

    picker.handleInput(SPACE);

    expect(labels(picker)).toEqual(['[ ] development', '[ ] design', '[ ] marketing']);
  });

  it('treats space as filter input in single-select mode', () => {
    const { picker, done } = createPicker();

    picker.handleInput(SPACE);

    expect(labels(picker)).toEqual(['development', 'design', 'marketing']);
    expect(done).not.toHaveBeenCalled();
  });

  it('confirms the cursor row in single-select mode', () => {
    const { picker, done } = createPicker();

    picker.handleInput(ENTER);

    expect(done).toHaveBeenCalledWith(['development']);
  });

  it('confirms the whole toggled set in multi-select mode', () => {
    const { picker, done } = createPicker({ multi: true, selected: ['marketing'] });

    // Enter resolves the accumulated set, not just the row under the cursor.
    picker.handleInput(UP);
    picker.handleInput(SPACE);
    picker.handleInput(ENTER);

    expect(done).toHaveBeenCalledWith(['marketing', 'design']);
  });

  it('resolves with nothing when cancelled', () => {
    const { picker, done } = createPicker();

    picker.handleInput(ESCAPE);

    expect(done).toHaveBeenCalledWith(undefined);
  });

  it('resolves once, so a late selection cannot overwrite a cancel', () => {
    const { picker, done } = createPicker();

    picker.handleInput(ESCAPE);
    picker.handleInput(ENTER);

    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it('moves the cursor with the navigation keys rather than editing the filter', () => {
    const { picker, done } = createPicker();

    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    expect(done).toHaveBeenCalledWith(['design']);
  });

  it('returns to the previous row on the up key', () => {
    const { picker, done } = createPicker();

    picker.handleInput(DOWN);
    picker.handleInput(DOWN);
    picker.handleInput(UP);
    picker.handleInput(ENTER);

    expect(done).toHaveBeenCalledWith(['design']);
  });

  it('places the cursor on the preselected row', () => {
    const { picker, done } = createPicker({ selected: ['marketing'] });

    picker.handleInput(ENTER);

    expect(done).toHaveBeenCalledWith(['marketing']);
  });

  it('leaves the cursor at the top when the preselected row is not in the list', () => {
    const { picker, done } = createPicker({ selected: ['gone'] });

    picker.handleInput(ENTER);

    expect(done).toHaveBeenCalledWith(['development']);
  });

  it('keeps the typed filter applied across a toggle rebuild', () => {
    const { picker } = createPicker({ multi: true });

    for (const character of 'de') picker.handleInput(character);
    picker.handleInput(SPACE);

    expect(labels(picker)).toEqual(['[x] development', '[ ] design', '[ ] marketing']);
  });
});
