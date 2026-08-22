import type { Theme } from '@earendil-works/pi-coding-agent';
import {
  type Component,
  Container,
  Input,
  type KeybindingsManager,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Spacer,
  Text,
} from '@earendil-works/pi-tui';

const MAX_VISIBLE = 10;
const SINGLE_HINT = '↑↓ navigate   enter select   esc cancel   type to filter';
const MULTI_HINT = '↑↓ navigate   space toggle   enter confirm   esc cancel   type to filter';
const SPACE = ' ';
const MARK_ON = '[x]';
const MARK_OFF = '[ ]';
const HORIZONTAL_BORDER = '─';

function doomSelectListTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (text) => theme.fg('accent', text),
    selectedText: (text) => theme.bg('selectedBg', theme.fg('text', text)),
    description: (text) => theme.fg('dim', text),
    scrollInfo: (text) => theme.fg('muted', text),
    noMatch: (text) => theme.fg('warning', text),
  };
}

class DoomPickerBorder implements Component {
  constructor(private readonly theme: Theme) {}

  render(width: number): string[] {
    return width > 0 ? [this.theme.fg('borderAccent', HORIZONTAL_BORDER.repeat(width))] : [];
  }

  invalidate(): void {
    // The host rebuilds the picker when the theme changes.
  }
}

export interface MatrixPickerOptions {
  title: string;
  /** Rows with plain labels. Selection markers are added by the component. */
  items: SelectItem[];
  /** Values selected on open. In single mode the first one is the cursor row. */
  selected: string[];
  multi: boolean;
}

/**
 * Rows carrying their current selection marker.
 *
 * Multi-select only. A single-select list is a button group: the cursor is the
 * selection, so adding checkboxes would show two competing indicators.
 */
export function markItems(items: SelectItem[], selected: string[], multi: boolean): SelectItem[] {
  if (!multi) return items;
  return items.map((item) => ({
    ...item,
    label: `${selected.includes(item.value) ? MARK_ON : MARK_OFF} ${item.label}`,
  }));
}

/** SelectList filters on a value prefix, so the visible rows follow that rule. */
export function visibleValues(items: SelectItem[], filter: string): string[] {
  return items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase())).map((item) => item.value);
}

export function toggleValue(selected: string[], value: string): string[] {
  return selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value];
}

/**
 * Filterable picker with preselected rows and optional multi-select.
 *
 * Pi's built-in ui.select() offers none of that: it takes a bare string[], has
 * no filter input, hardcodes selectedIndex = 0 (extension-selector.js:12), and
 * resolves on the first enter. This drives SelectList directly instead.
 */
export class MatrixPickerComponent extends Container {
  private readonly filterInput = new Input();
  private readonly items: SelectItem[];
  private readonly multi: boolean;
  private readonly title: string;
  private readonly theme: Theme;
  // Declared and assigned separately, never as parameter properties: Pi loads
  // extensions through Node's strip-only type stripping, which rejects those.
  private readonly keybindings: KeybindingsManager;
  private readonly done: (value: string[] | undefined) => void;
  private list: SelectList;
  private selected: string[];
  private cursorValue: string | undefined;
  private settled = false;

  constructor(
    options: MatrixPickerOptions,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (value: string[] | undefined) => void,
  ) {
    super();
    this.items = options.items;
    this.multi = options.multi;
    this.title = options.title;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.selected = [...options.selected];
    this.cursorValue = options.selected[0];

    // Focus is set here rather than by the TUI, which focuses the component it
    // was handed (this container) and not the input nested inside it.
    this.filterInput.focused = true;
    this.filterInput.onEscape = () => this.settle(undefined);

    this.list = this.buildList();
    this.render_();
  }

  private buildList(): SelectList {
    const list = new SelectList(
      markItems(this.items, this.selected, this.multi),
      MAX_VISIBLE,
      doomSelectListTheme(this.theme),
    );
    const filter = this.filterInput.getValue();
    if (filter) list.setFilter(filter);

    const visible = visibleValues(this.items, filter);
    const index = this.cursorValue ? visible.indexOf(this.cursorValue) : -1;
    if (index >= 0) list.setSelectedIndex(index);

    list.onSelectionChange = (item) => {
      this.cursorValue = item.value;
    };
    list.onSelect = (item) => (this.multi ? this.settle(this.selected) : this.settle([item.value]));
    list.onCancel = () => this.settle(undefined);
    return list;
  }

  /**
   * SelectList takes its rows at construction and exposes no setter, so a
   * toggled marker means rebuilding the list and the container around it.
   */
  private render_(): void {
    this.clear();
    this.addChild(new DoomPickerBorder(this.theme));
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg('mdHeading', this.theme.bold(this.title)), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.filterInput);
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg('muted', this.multi ? MULTI_HINT : SINGLE_HINT), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DoomPickerBorder(this.theme));
  }

  private rebuild(): void {
    this.list = this.buildList();
    this.render_();
  }

  private settle(value: string[] | undefined): void {
    // The list can fire onSelect after a cancel has already resolved, and
    // resolving twice would drop the first answer on the floor.
    if (this.settled) return;
    this.settled = true;
    this.done(value);
  }

  handleInput(data: string): void {
    if (this.multi && data === SPACE) {
      const current = this.list.getSelectedItem();
      if (current) {
        this.selected = toggleValue(this.selected, current.value);
        this.cursorValue = current.value;
        this.rebuild();
      }
      return;
    }

    // Navigation keys belong to the list, everything else edits the filter, so
    // typing narrows the list without stealing the arrow keys from it.
    const navigational =
      this.keybindings.matches(data, 'tui.select.up') ||
      this.keybindings.matches(data, 'tui.select.down') ||
      this.keybindings.matches(data, 'tui.select.confirm') ||
      this.keybindings.matches(data, 'tui.select.cancel');

    if (navigational) {
      this.list.handleInput(data);
      return;
    }

    const before = this.filterInput.getValue();
    this.filterInput.handleInput(data);
    const after = this.filterInput.getValue();
    if (after !== before) this.list.setFilter(after);
  }
}
