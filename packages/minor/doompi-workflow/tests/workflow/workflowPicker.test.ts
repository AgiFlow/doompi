import type { Theme } from '@earendil-works/pi-coding-agent';
import type { DoomOverlayTui } from '@agimon-ai/doompi-ui/components/doomOverlay';
import { describe, expect, it, vi } from 'vitest';
import {
  filterPickerRows,
  WorkflowPickerComponent,
  type PickerRow,
  type WorkflowPickerConfig,
} from '../../src/tui/workflow/workflowPicker';

const WIDTH = 120;
const ROWS = 20;
const KEY_UP = '\x1b[A';
const KEY_DOWN = '\x1b[B';
const KEY_ESC = '\x1b';
const KEY_ENTER = '\r';
const KEY_BACKSPACE = '\x7f';
const KEY_CLEAR = '\x15';
const SELECTION_MARKER = '›';
/** The breadcrumb uses the same glyph as the row marker, so body rows only. */
const BREADCRUMB_MARKER = 'SPC ›';

const CONFIG: WorkflowPickerConfig = {
  title: 'WORKFLOW LAUNCHER',
  breadcrumb: 'SPC › w / workflows › c / recover',
  unit: 'workflows',
  action: 'launch',
  filterPlaceholder: 'type to filter by name, path or tag',
  emptyMessage: 'No workflow definitions were found in this repository.',
};

function row(name: string, detail: string, search?: string): PickerRow<string> {
  return { key: detail, name, detail, ...(search ? { search } : {}), value: name };
}

const CATALOG: PickerRow<string>[] = [
  row('Short Conversion Production', 'automations/marketing-workflows/video-short-conversion.workflow.yml'),
  row('Short Affinity Production', 'automations/marketing-workflows/video-short-affinity.workflow.yml'),
  row('CLI Development', 'automations/workflows/dev-cli.workflow.yml', 'engineering'),
  row('Fix', 'automations/workflows/dev-fix.workflow.yml', 'repair a broken build'),
  row('QA', 'automations/workflows/test-qa.workflow.yml'),
];

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

interface Harness {
  component: WorkflowPickerComponent<string>;
  render: () => string[];
  text: () => string;
  bodyRows: () => string[];
  selectedRow: () => string | undefined;
  picked: () => (string | undefined)[];
  type: (input: string) => void;
}

function createPicker(rows: readonly PickerRow<string>[] = CATALOG, terminalRows = ROWS): Harness {
  const tui: DoomOverlayTui = { terminal: { rows: terminalRows, columns: WIDTH }, requestRender: vi.fn() };
  const picked: (string | undefined)[] = [];
  const component = new WorkflowPickerComponent(tui, createTheme(), CONFIG, rows, (value) => picked.push(value));
  const render = (): string[] => component.render(WIDTH);
  const bodyRows = (): string[] =>
    render().filter((line) => line.includes('.workflow.yml') && !line.includes(BREADCRUMB_MARKER));
  return {
    component,
    render,
    text: () => render().join('\n'),
    bodyRows,
    selectedRow: () => bodyRows().find((line) => line.includes(SELECTION_MARKER)),
    picked: () => picked,
    type: (input: string) => {
      for (const character of input) component.handleInput(character);
    },
  };
}

describe('filterPickerRows', () => {
  it('returns every row for an empty query', () => {
    expect(filterPickerRows(CATALOG, '   ')).toHaveLength(CATALOG.length);
  });

  it('requires every whitespace-separated term to match, across name, detail and search text', () => {
    expect(filterPickerRows(CATALOG, 'short conversion').map((match) => match.name)).toEqual([
      'Short Conversion Production',
    ]);
    // "video" only appears in the detail, "affinity" only in the name.
    expect(filterPickerRows(CATALOG, 'video affinity').map((match) => match.name)).toEqual([
      'Short Affinity Production',
    ]);
    expect(filterPickerRows(CATALOG, 'engineering').map((match) => match.name)).toEqual(['CLI Development']);
    expect(filterPickerRows(CATALOG, 'broken build').map((match) => match.name)).toEqual(['Fix']);
  });

  it('matches case-insensitively and returns nothing when a term is unmatched', () => {
    expect(filterPickerRows(CATALOG, 'SHORT')).toHaveLength(2);
    expect(filterPickerRows(CATALOG, 'short nonsense')).toEqual([]);
  });
});

describe('WorkflowPickerComponent chrome', () => {
  it('frames the list as a doom overlay with a breadcrumb and key legend', () => {
    const picker = createPicker();
    const text = picker.text();

    expect(text).toContain('WORKFLOW LAUNCHER');
    expect(text).toContain('SPC › w / workflows › c / recover');
    expect(text).toContain('5 workflows');
    expect(text).toContain('launch');
    expect(text).toContain('esc');
    expect(picker.render()[0]).toContain('╭');
  });

  it('counts matches against the source list once a filter narrows it', () => {
    const picker = createPicker();
    picker.type('short');

    expect(picker.text()).toContain('2 of 5 workflows');
    expect(picker.text()).toContain('1/2');
  });
});

describe('WorkflowPickerComponent filtering', () => {
  it('shows the typed query in the filter field and narrows the rows', () => {
    const picker = createPicker();
    picker.type('dev-');

    expect(picker.text()).toContain('FILTER');
    expect(picker.text()).toContain('dev-');
    expect(picker.bodyRows()).toHaveLength(2);
    expect(picker.text()).toContain('CLI Development');
    expect(picker.text()).not.toContain('Short Conversion Production');
  });

  it('deletes with backspace and clears the whole query with ctrl+u', () => {
    const picker = createPicker();
    picker.type('dev-cli');
    expect(picker.bodyRows()).toHaveLength(1);

    picker.component.handleInput(KEY_BACKSPACE);
    picker.component.handleInput(KEY_BACKSPACE);
    picker.component.handleInput(KEY_BACKSPACE);
    expect(picker.bodyRows()).toHaveLength(2);

    picker.component.handleInput(KEY_CLEAR);
    expect(picker.bodyRows()).toHaveLength(CATALOG.length);
  });

  it('reports an unmatched query rather than an empty body', () => {
    const picker = createPicker();
    picker.type('nonsense');

    expect(picker.text()).toContain('No workflows match "nonsense".');
    expect(picker.text()).toContain('no match');
  });

  it('says so when the source list itself is empty', () => {
    expect(createPicker([]).text()).toContain('No workflow definitions were found in this repository.');
  });
});

describe('WorkflowPickerComponent selection', () => {
  it('moves the selection with the arrow keys and clamps at both ends', () => {
    const picker = createPicker();
    expect(picker.selectedRow()).toContain('Short Conversion Production');

    picker.component.handleInput(KEY_UP);
    expect(picker.selectedRow()).toContain('Short Conversion Production');

    picker.component.handleInput(KEY_DOWN);
    expect(picker.selectedRow()).toContain('Short Affinity Production');

    for (let press = 0; press < CATALOG.length + 3; press++) picker.component.handleInput(KEY_DOWN);
    expect(picker.selectedRow()).toContain('QA');
  });

  it('resets the selection to the first match when the filter changes', () => {
    const picker = createPicker();
    picker.component.handleInput(KEY_DOWN);
    picker.component.handleInput(KEY_DOWN);
    expect(picker.selectedRow()).toContain('CLI Development');

    picker.type('short');
    expect(picker.selectedRow()).toContain('Short Conversion Production');
  });

  it('hands back the value of the filtered row under the cursor on enter', () => {
    const picker = createPicker();
    picker.type('short');
    picker.component.handleInput(KEY_DOWN);
    picker.component.handleInput(KEY_ENTER);

    expect(picker.picked()).toEqual(['Short Affinity Production']);
  });

  it('returns nothing on enter with no match, and cancels on escape', () => {
    const picker = createPicker();
    picker.type('nonsense');
    picker.component.handleInput(KEY_ENTER);
    expect(picker.picked()).toEqual([]);

    picker.component.handleInput(KEY_ESC);
    expect(picker.picked()).toEqual([undefined]);
  });
});

describe('WorkflowPickerComponent scrolling', () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    row(`Workflow ${index}`, `automations/workflows/w-${index}.workflow.yml`),
  );

  it('windows the list to the rows the body can hold', () => {
    const picker = createPicker(many);

    expect(picker.bodyRows().length).toBeLessThan(many.length);
    expect(picker.bodyRows().length).toBeGreaterThan(0);
    expect(picker.text()).toContain('1/40');
  });

  it('scrolls the window so the selection stays on screen', () => {
    const picker = createPicker(many);
    const visible = picker.bodyRows().length;
    for (let press = 0; press < visible + 2; press++) picker.component.handleInput(KEY_DOWN);

    expect(picker.selectedRow()).toContain(`Workflow ${visible + 2}`);
    expect(picker.text()).toContain(`${visible + 3}/40`);
    expect(picker.text()).not.toContain('Workflow 0 ');
  });

  it('pages with pageDown and pageUp', () => {
    const picker = createPicker(many);
    const visible = picker.bodyRows().length;

    picker.component.handleInput('\x1b[6~');
    expect(picker.selectedRow()).toContain(`Workflow ${visible}`);

    picker.component.handleInput('\x1b[5~');
    expect(picker.selectedRow()).toContain('Workflow 0');
  });

  it('keeps the detail tail visible by trimming the front', () => {
    const picker = createPicker([
      row(
        'Generated Funny Pig One-Shot Dynamic Camera Production',
        'automations/marketing-workflows/video-generated-oinky-one-shot-dynamic-camera.workflow.yml',
      ),
    ]);
    const line = picker.bodyRows()[0] ?? '';

    // Every row is one terminal line: the wrapping in the old select is what the
    // overlay replaces.
    expect(picker.bodyRows()).toHaveLength(1);
    expect(line).toContain('one-shot-dynamic-camera.workflow.yml');
    expect(line).toContain('…');
  });
});
