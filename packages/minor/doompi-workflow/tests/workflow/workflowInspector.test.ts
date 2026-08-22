import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkflowInspectorComponent,
  type WorkflowInspectorItem,
  type WorkflowInspectorSource,
} from '../../src/tui/workflow/workflowInspector';

/** Pass-through theme so assertions read plain text, not colour codes. */
const theme = {
  bg: (_colour: string, text: string) => text,
  bold: (text: string) => text,
  fg: (_colour: string, text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

function item(overrides: Partial<WorkflowInspectorItem> = {}): WorkflowInspectorItem {
  return {
    displayName: 'Funny dancing dog today',
    jobs: [
      {
        index: 1,
        name: 'source-tiktok',
        status: 'running',
        steps: [{ name: 'Source TikTok', status: 'running' }],
        total: 4,
      },
    ],
    key: 'agiflow/funny-dancing-dog-today',
    output: [],
    runKey: 'funny-dancing-dog-today',
    startedAt: new Date(Date.now() - 10_000).toISOString(),
    workspace: 'agiflow',
    ...overrides,
  };
}

function createComponent(initial: WorkflowInspectorItem[] = [item()]) {
  let items = initial;
  const done = vi.fn();
  const requestRender = vi.fn();
  const terminal = { rows: 40 };
  const source: WorkflowInspectorSource = {
    list: vi.fn(async () => items.map((entry) => ({ ...entry, jobs: entry.jobs.map((job) => ({ ...job })) }))),
    output: vi.fn(async (entry) => [`old ${entry.runKey}`, `latest ${entry.runKey}`]),
  };
  const component = new WorkflowInspectorComponent({ requestRender, terminal }, theme, source, done, {
    refreshMs: 20,
  });
  return {
    component,
    done,
    requestRender,
    setItems: (next: WorkflowInspectorItem[]) => (items = next),
    setRows: (rows: number) => {
      terminal.rows = rows;
    },
    source,
  };
}

async function waitForRefresh(requestRender: ReturnType<typeof vi.fn>): Promise<void> {
  await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
}

describe('WorkflowInspectorComponent', () => {
  it('renders a compact roster, selected progress, and newest output in two columns', async () => {
    const harness = createComponent();
    await waitForRefresh(harness.requestRender);

    const lines = harness.component.render(100);
    const rendered = lines.join('\n');

    // Doom chrome: the framed title and breadcrumb, not a bespoke header.
    expect(rendered).toContain('WORKFLOW SPACE');
    expect(rendered).toContain('SPC › w / workflows › l / manage');
    expect(lines[0]).toContain('╭');
    expect(rendered).toContain('Funny dancing dog today');
    expect(rendered).toContain('source-tiktok');
    expect(rendered).toContain('Source TikTok');
    expect(rendered).toContain('latest funny-dancing-dog-today');
    expect(rendered).toContain('↑↓');
    expect(rendered).not.toContain('↑↓/jk');
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);

    harness.setRows(5);
    const compact = harness.component.render(100).join('\n');
    expect(compact).toContain('↑↓');
    expect(compact).not.toContain('↑↓/jk');
    harness.component.dispose();
  });

  it('renders paused execution state in the inspector instead of pretending the run is active', async () => {
    const harness = createComponent([item({ executionState: 'paused' })]);
    await waitForRefresh(harness.requestRender);

    const rendered = harness.component.render(100).join('\n');

    expect(rendered).toContain('paused');
    expect(rendered).not.toContain('· running ');
    harness.component.dispose();
  });

  it('uses a single detail pane when two useful columns do not fit', async () => {
    const harness = createComponent();
    await waitForRefresh(harness.requestRender);

    const lines = harness.component.render(60);

    expect(lines.join('\n')).toContain('Source TikTok');
    expect(lines.some((line) => line.includes('┬'))).toBe(false);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    harness.component.dispose();
  });

  it('selects workflows with arrows and opens the highlighted identity on Enter', async () => {
    const second = item({ displayName: 'Deploy API', key: 'agiflow/deploy-api', runKey: 'deploy-api' });
    const harness = createComponent([item(), second]);
    await waitForRefresh(harness.requestRender);

    harness.component.handleInput('\x1b[B');
    harness.component.handleInput('\r');

    // Which run was handed back is the assertion; the selection also carries the
    // start time, which the caller needs to scope the run's progress log.
    expect(harness.done).toHaveBeenCalledWith(expect.objectContaining({ runKey: 'deploy-api', workspace: 'agiflow' }));
  });

  it('preserves selection by stable identity when registry ordering changes', async () => {
    const first = item();
    const second = item({ displayName: 'Deploy API', key: 'agiflow/deploy-api', runKey: 'deploy-api' });
    const harness = createComponent([first, second]);
    await waitForRefresh(harness.requestRender);
    harness.component.handleInput('j');

    harness.requestRender.mockClear();
    harness.setItems([second, first]);
    await waitForRefresh(harness.requestRender);
    harness.component.handleInput('\r');

    expect(harness.done).toHaveBeenCalledWith(expect.objectContaining({ runKey: 'deploy-api', workspace: 'agiflow' }));
  });

  it('renders an empty inspector and closes from a narrow terminal', async () => {
    const harness = createComponent([]);
    await waitForRefresh(harness.requestRender);

    expect(harness.component.render(100).join('\n')).toContain('No active workflows');
    expect(visibleWidth(harness.component.render(20)[0])).toBeLessThanOrEqual(20);
    harness.component.handleInput('j');
    harness.component.handleInput('\x1b');

    expect(harness.done).toHaveBeenCalledWith(undefined);
  });

  it('shows refresh errors without throwing from render', async () => {
    const requestRender = vi.fn();
    const source: WorkflowInspectorSource = {
      list: vi.fn(async () => {
        throw new Error('registry unavailable');
      }),
      output: vi.fn(async () => []),
    };
    const component = new WorkflowInspectorComponent(
      { requestRender, terminal: { rows: 40 } },
      theme,
      source,
      vi.fn(),
      { refreshMs: 20 },
    );
    await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());

    expect(component.render(100).join('\n')).toContain('registry unavailable');
    component.dispose();
  });

  it('renders completed, failed, and running job details with output', async () => {
    const harness = createComponent([
      item({
        jobs: [
          { name: 'done', status: 'completed', steps: [], index: 0, total: 3 },
          { name: 'failed', status: 'failed', steps: [], index: 1, total: 3 },
          {
            name: 'active',
            status: 'running',
            steps: [
              { name: 'done step', status: 'completed' },
              { name: 'failed step', status: 'failed' },
              { name: 'active step', status: 'running' },
            ],
            index: 2,
            total: 3,
          },
        ],
        output: ['launcher output'],
      }),
    ]);
    await waitForRefresh(harness.requestRender);

    const rendered = harness.component.render(100).join('\n');
    expect(rendered).toContain('✓ done');
    expect(rendered).toContain('✗ failed');
    expect(rendered).toContain('active step');
    expect(rendered).toContain('latest funny-dancing-dog-today');
    harness.component.dispose();
  });

  it('closes a captured colour so it cannot bleed through the divider or the rows below', async () => {
    // A real capture ends its colour with a hard reset; the pane must keep that
    // reset rather than strip it the way a themed roster row does.
    const coloured = '\x1b[38;2;255;0;0mbuild failed\x1b[0m';
    const harness = createComponent();
    vi.mocked(harness.source.output).mockResolvedValue([coloured]);
    await waitForRefresh(harness.requestRender);
    await vi.waitFor(() => expect(harness.component.render(100).join('\n')).toContain('build failed'));

    const lines = harness.component.render(100);
    const outputRow = lines.find((line) => line.includes('build failed'));

    expect(outputRow).toBeDefined();
    expect(outputRow).toContain('\x1b[0m');
    // Nothing after the coloured span may still be inside it.
    expect((outputRow ?? '').lastIndexOf('\x1b[0m')).toBeGreaterThan((outputRow ?? '').indexOf('build failed'));
    harness.component.dispose();
  });

  it('closes without selecting or stopping a workflow on Escape', async () => {
    const harness = createComponent();
    await waitForRefresh(harness.requestRender);

    harness.component.handleInput('\x1b');

    expect(harness.done).toHaveBeenCalledWith(undefined);
  });
});
