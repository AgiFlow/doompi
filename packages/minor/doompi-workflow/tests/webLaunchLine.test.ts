import { describe, expect, it, vi } from 'vitest';
import type { WorkflowCatalogEntryView } from '../src/types/webWorkflows.ts';
import { initialInputs, initialRunner, launchProblems } from '../src/web/launchLine.ts';
import {
  catalog,
  filterCatalog,
  openCatalog,
  openLaunch,
  selectWorkflow,
  toggleInspect,
  workflowCatalogChannel,
} from '../src/web/catalogStore.ts';
import { requestLaunch, workflowRunsChannel, workflows } from '../src/web/workflowsStore.ts';

/** Feeds runs through the real channel, which is where the pending launch resolves. */
function workflowsApply(runs: WorkflowRunView[]): void {
  workflowRunsChannel.apply('s1', { runs });
}
import { workflowActivityGroups, workflowActivityRows } from '../src/web/workflowActivity.ts';
import type { WorkflowRunView } from '../src/types/webWorkflows.ts';

function entry(overrides: Partial<WorkflowCatalogEntryView> = {}): WorkflowCatalogEntryView {
  return {
    path: '/repo/blog.workflow.yml',
    relativePath: 'blog.workflow.yml',
    name: 'Blog Writing',
    description: 'Research and draft.',
    tags: ['writing'],
    triggers: [],
    inputs: [],
    jobs: [{ name: 'research', steps: ['read'] }],
    artifacts: [],
    ...overrides,
  };
}

function run(overrides: Partial<WorkflowRunView> = {}): WorkflowRunView {
  return {
    runKey: 'blog-writing-4',
    workspace: 'repo',
    displayName: 'blog-writing',
    workflowPath: '/repo/blog.workflow.yml',
    stage: 'running',
    startedAt: '2026-08-25T09:00:00.000Z',
    jobs: [],
    ...overrides,
  };
}

describe('launch dialog defaults and guards', () => {
  it('starts every field at what the workflow declared', () => {
    const workflow = entry({ inputs: [{ name: 'tone', default: 'practical' }, { name: 'brief' }] });
    expect(initialInputs(workflow)).toEqual({ tone: 'practical', brief: '' });
  });

  it('starts on the first runner the workflow declares, and on none when it declares none', () => {
    expect(initialRunner(entry({ runners: ['tmux', 'cmux'] }))).toBe('tmux');
    expect(initialRunner(entry())).toBeUndefined();
  });

  // A prompt-triggered workflow launched without one waits for terminal input
  // that is never coming.
  it('will not send a prompt-triggered workflow without a prompt', () => {
    const problems = launchProblems(entry({ triggers: ['user_prompt'] }), { workflow: 'Blog Writing', inputs: {} });
    expect(problems).toEqual(['This workflow is triggered by a prompt, so it needs one.']);
  });

  it('names the required inputs still empty', () => {
    const workflow = entry({
      inputs: [
        { name: 'brief', required: true },
        { name: 'tone', required: true },
      ],
    });
    const problems = launchProblems(workflow, { workflow: 'Blog Writing', inputs: { brief: '' } });
    expect(problems).toEqual(['Missing required inputs: brief, tone.']);
  });

  it('has nothing to say once every requirement is met', () => {
    const workflow = entry({ triggers: ['user_prompt'], inputs: [{ name: 'brief', required: true }] });
    expect(launchProblems(workflow, { workflow: 'x', inputs: { brief: 'a post' }, prompt: 'draft it' })).toEqual([]);
  });
});

describe('catalog store', () => {
  it('folds a published catalog into the session record', () => {
    catalog.reset();
    workflowCatalogChannel.apply('s1', { cwd: '/repo', workflows: [entry()] });
    expect(catalog.select(catalog.store.state, 's1').workflows).toHaveLength(1);
  });

  it('rejects a payload that is not a catalog', () => {
    expect(workflowCatalogChannel.parse({ cwd: 5 })).toBeNull();
    expect(workflowCatalogChannel.parse(null)).toBeNull();
  });

  // A row that is gone cannot stay selected, inspected, or half-launched.
  it('drops a selection whose workflow is no longer listed', () => {
    catalog.reset();
    workflowCatalogChannel.apply('s1', { cwd: '/repo', workflows: [entry()] });
    selectWorkflow('s1', '/repo/blog.workflow.yml');
    toggleInspect('s1', '/repo/blog.workflow.yml');
    openLaunch('s1', '/repo/blog.workflow.yml');
    workflowCatalogChannel.apply('s1', { cwd: '/repo', workflows: [] });
    const state = catalog.select(catalog.store.state, 's1');
    expect([state.selected, state.inspected, state.launch]).toEqual([undefined, undefined, undefined]);
  });

  it('keeps the drawer open across a republish', () => {
    catalog.reset();
    openCatalog('s1');
    workflowCatalogChannel.apply('s1', { cwd: '/repo', workflows: [entry()] });
    expect(catalog.select(catalog.store.state, 's1').open).toBe(true);
  });

  it('filters on name, tag and job', () => {
    const workflows = [
      entry(),
      entry({ path: '/repo/dev.yml', name: 'Dev Fix', description: 'Reproduce and fix.', tags: ['dev'], jobs: [] }),
    ];
    expect(filterCatalog(workflows, 'writing').map((row) => row.name)).toEqual(['Blog Writing']);
    expect(filterCatalog(workflows, 'research').map((row) => row.name)).toEqual(['Blog Writing']);
    expect(filterCatalog(workflows, '')).toHaveLength(2);
  });
});

describe('requesting a launch', () => {
  it('sends the line to the session and remembers what was already running', () => {
    workflows.reset();
    const send = vi.fn();
    requestLaunch(send, 's1', '/workflow-launch dev-fix', '/repo/dev.yml');
    expect(send).toHaveBeenCalledWith('s1', { type: 'prompt', message: '/workflow-launch dev-fix' });
    expect(workflows.select(workflows.store.state, 's1').pendingLaunch?.workflowPath).toBe('/repo/dev.yml');
  });

  // Nothing connects the line to the run but timing: the first run this session
  // did not already have is the one that was asked for.
  it('focuses the run that arrives after a launch', () => {
    workflows.reset();
    requestLaunch(vi.fn(), 's1', '/workflow-launch dev-fix', '/repo/dev.yml');
    workflowsApply([run({ runKey: 'dev-fix-1' })]);
    const state = workflows.select(workflows.store.state, 's1');
    expect(state.focusedRun).toBe('repo/dev-fix-1');
    expect(state.pendingLaunch).toBeUndefined();
  });

  it('keeps the launch pending while no new run has appeared', () => {
    workflows.reset();
    const existing = run();
    workflowsApply([existing]);
    requestLaunch(vi.fn(), 's1', '/workflow-launch dev-fix', '/repo/dev.yml');
    workflowsApply([existing]);
    expect(workflows.select(workflows.store.state, 's1').pendingLaunch).toBeDefined();
  });
});

describe('activity groups', () => {
  it('splits the session history into running, failed and successful', () => {
    const rows = workflowActivityRows(
      [
        run({ runKey: 'live' }),
        run({ runKey: 'broke', stage: 'error', finishedAt: '2026-08-25T09:10:00.000Z' }),
        run({ runKey: 'done', stage: 'completed', outcome: 'success', finishedAt: '2026-08-25T09:05:00.000Z' }),
      ],
      Date.parse('2026-08-25T09:20:00.000Z'),
    );
    const groups = workflowActivityGroups(rows);
    expect(groups.map((group) => [group.name, group.rows.length, group.openByDefault])).toEqual([
      ['running', 1, true],
      ['failed', 1, true],
      ['successful', 1, false],
    ]);
  });

  it('drops the groups with nothing in them', () => {
    const rows = workflowActivityRows([run({ runKey: 'live' })], Date.now());
    expect(workflowActivityGroups(rows).map((group) => group.name)).toEqual(['running']);
  });

  // A paused run is still live work: it belongs with running, where somebody
  // will see that it is waiting.
  it('files a paused run with the running ones', () => {
    const rows = workflowActivityRows([run({ executionState: 'paused' })], Date.now());
    expect(workflowActivityGroups(rows)[0]?.name).toBe('running');
  });
});
