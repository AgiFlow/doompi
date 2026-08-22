import type { Theme } from '@earendil-works/pi-coding-agent';
import type { DoomOverlayTui } from '@agimon-ai/doompi-ui/components/doomOverlay';
import { describe, expect, it, vi } from 'vitest';
import {
  filterWorkflowRows,
  WorkflowCatalogComponent,
  workflowDetailLines,
  type WorkflowCatalogDetail,
  type WorkflowCatalogRow,
} from '../../src/tui/workflow/workflowCatalog';

const WIDTH = 120;
const ROWS = 24;
const KEY_ESC = '\x1b';
const KEY_ENTER = '\r';
const KEY_BACKSPACE = '\x7f';
const KEY_TAB = '\t';

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

function row(name: string, relativePath: string, overrides: Partial<WorkflowCatalogRow> = {}): WorkflowCatalogRow {
  return {
    key: `/repo/${relativePath}`,
    name,
    relativePath,
    description: `${name} description`,
    tags: [],
    ...overrides,
  };
}

const CATALOG = [
  row('Deploy', 'automations/deploy.workflow.yml', { tags: ['release'] }),
  row('Analyse', 'automations/analyse.workflow.yml'),
  row('Test', 'automations/test-qa.workflow.yml'),
];

function detail(overrides: Partial<WorkflowCatalogDetail> = {}): WorkflowCatalogDetail {
  return {
    triggers: ['user_prompt'],
    inputs: [{ name: 'asset', description: 'Asset id', required: true }],
    jobs: [{ name: 'build', runsOn: 'codex', steps: ['compile'] }],
    runners: ['codex'],
    ...overrides,
  };
}

function createBoard(
  rows: readonly WorkflowCatalogRow[] = CATALOG,
  options: { detail?: WorkflowCatalogDetail; launch?: (row: WorkflowCatalogRow) => void; loads?: string[] } = {},
) {
  const tui: DoomOverlayTui = { terminal: { rows: ROWS, columns: WIDTH }, requestRender: vi.fn() };
  const closed: undefined[] = [];
  const component = new WorkflowCatalogComponent(tui, createTheme(), rows, (value) => closed.push(value), {
    loadDetail: (target) => {
      options.loads?.push(target.key);
      return options.detail ?? detail();
    },
    ...(options.launch ? { launchWorkflow: options.launch } : {}),
  });
  const render = (): string[] => component.render(WIDTH);
  return { component, closed, render, text: (): string => render().join('\n') };
}

describe('filterWorkflowRows', () => {
  it('matches every whitespace-separated term against name, path, description, and tags', () => {
    expect(filterWorkflowRows(CATALOG, 'deploy release').map((entry) => entry.name)).toEqual(['Deploy']);
    expect(filterWorkflowRows(CATALOG, 'qa').map((entry) => entry.name)).toEqual(['Test']);
    expect(filterWorkflowRows(CATALOG, '   ')).toHaveLength(CATALOG.length);
  });
});

describe('workflowDetailLines', () => {
  it('reports an unset runner map as any runner rather than none', () => {
    const withMap = workflowDetailLines(detail({ runners: ['codex'] }), 'triggers', 80, createTheme()).join('\n');
    const withoutMap = workflowDetailLines(detail({ runners: undefined }), 'triggers', 80, createTheme()).join('\n');

    expect(withMap).toContain('codex');
    expect(withoutMap).toContain('any available runner');
    expect(withoutMap).not.toContain('none');
  });

  it('qualifies each dispatch input with required, default, and options', () => {
    const text = workflowDetailLines(
      detail({ inputs: [{ name: 'asset', description: 'Asset id', default: 'latest', options: ['a', 'b'] }] }),
      'inputs',
      100,
      createTheme(),
    ).join('\n');

    expect(text).toContain('asset');
    expect(text).toContain('Asset id');
    expect(text).toContain('optional');
    expect(text).toContain('default latest');
    expect(text).toContain('one of a, b');
  });

  it('shows the parse error alone rather than an empty outline beside it', () => {
    const text = workflowDetailLines(detail({ error: 'workflow yaml is invalid' }), 'steps', 80, createTheme()).join(
      '\n',
    );

    expect(text).toContain('WORKFLOW ERROR');
    expect(text).toContain('workflow yaml is invalid');
    expect(text).not.toContain('build');
  });
});

describe('WorkflowCatalogComponent', () => {
  it('sorts the list, renders each row as a name over its path, and inspects the cursor row', () => {
    const board = createBoard();
    const text = board.text();

    expect(text.indexOf('Analyse')).toBeLessThan(text.indexOf('Deploy'));
    expect(text).toContain('INSPECTING Analyse');
    const lines = board.render();
    const nameRow = lines.findIndex((line) => line.includes('Analyse') && !line.includes('INSPECTING'));
    expect(lines[nameRow]).not.toContain('.workflow.yml');
    expect(lines[nameRow + 1]).toContain('analyse.workflow.yml');
  });

  it('follows the cursor into the detail pane with no inspect step', () => {
    const board = createBoard();

    board.component.handleInput('j');

    expect(board.text()).toContain('INSPECTING Deploy');
  });

  it('parses each workflow once, however often its row repaints', () => {
    const loads: string[] = [];
    const board = createBoard(CATALOG, { loads });

    board.render();
    board.render();
    board.component.handleInput('j');
    board.render();
    board.render();

    expect(loads).toEqual(['/repo/automations/analyse.workflow.yml', '/repo/automations/deploy.workflow.yml']);
  });

  it('cycles the detail tabs with tab and the letter shortcuts', () => {
    const board = createBoard();

    expect(board.text()).toContain('TRIGGERS');
    board.component.handleInput(KEY_TAB);
    expect(board.text()).toContain('DISPATCH INPUTS');
    board.component.handleInput('s');
    expect(board.text()).toContain('build');
    board.component.handleInput('t');
    expect(board.text()).toContain('user_prompt');
  });

  it('filters through / and restores the full list when the filter is cleared', () => {
    const board = createBoard();

    board.component.handleInput('/');
    for (const character of 'deploy') board.component.handleInput(character);
    const filtered = board.text();
    expect(filtered).toContain('Deploy');
    expect(filtered).not.toContain('Analyse');
    expect(filtered).toContain('1 of 3 workflows');

    for (let index = 0; index < 'deploy'.length; index++) board.component.handleInput(KEY_BACKSPACE);
    expect(board.text()).toContain('3 workflows');
    board.component.handleInput(KEY_ESC);
    const cleared = board.text();
    expect(cleared).toContain('Analyse');
    // Escape leaves the filter; it does not close the board.
    expect(board.closed).toHaveLength(0);
  });

  it('keeps letters as commands while filtering is off', () => {
    const launch = vi.fn();
    const board = createBoard(CATALOG, { launch });

    // `r` launches rather than narrowing the list to rows containing "r".
    board.component.handleInput('r');

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ name: 'Analyse' }));
  });

  it('closes the board before launching, so the launch prompts are reachable', () => {
    const order: string[] = [];
    const board = createBoard(CATALOG, { launch: () => order.push('launch') });
    board.closed.push = (() => order.push('closed')) as never;

    board.component.handleInput('r');

    expect(order).toEqual(['closed', 'launch']);
  });

  it('refuses to launch a workflow that does not parse, and says why', () => {
    const launch = vi.fn();
    const board = createBoard(CATALOG, { launch, detail: detail({ error: 'workflow yaml is invalid' }) });

    board.component.handleInput('r');

    expect(launch).not.toHaveBeenCalled();
    expect(board.text()).toContain('launch unavailable · workflow yaml is invalid');
  });

  it('reports the launch key as unavailable when no launcher is attached', () => {
    const board = createBoard();

    board.component.handleInput('r');

    expect(board.text()).toContain('launch unavailable · no workflow launcher is attached');
  });

  it('renders an empty repository and a filter with no match without closing', () => {
    const empty = createBoard([]);
    expect(empty.text()).toContain('No workflow definitions were found in this repository.');

    const board = createBoard();
    board.component.handleInput('/');
    for (const character of 'zzz') board.component.handleInput(character);
    expect(board.text()).toContain('No workflow matches this filter.');
    expect(board.text()).toContain('no match');
  });

  it('closes on escape and ctrl+c from the list', () => {
    const board = createBoard();
    board.component.handleInput(KEY_ESC);
    expect(board.closed).toEqual([undefined]);

    const other = createBoard();
    other.component.handleInput('\x03');
    expect(other.closed).toEqual([undefined]);
  });

  it('keeps a typed filter after enter and stays inside the width at every terminal size', () => {
    const board = createBoard();
    board.component.handleInput('/');
    for (const character of 'deploy') board.component.handleInput(character);
    board.component.handleInput(KEY_ENTER);

    expect(board.text()).toContain('1 of 3 workflows');
    expect(board.render().every((line) => line.length >= 0)).toBe(true);
  });
});
