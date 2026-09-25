import { resolve } from 'node:path';

import { DOOM_BACKGROUND_WORK_SERVICE, type BackgroundWorkProvider } from '@agimon-ai/doompi-core/backgroundWork';
import {
  DOOM_HEADLESS_OWNER as TEST_OWNER,
  DOOM_HEADLESS_HOST_SERVICE as TEST_AGENT,
} from '@agimon-ai/doompi-core/headless';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessActivity,
  type DoomHeadlessCommand,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHook,
  type DoomHeadlessHostService,
  type DoomHeadlessResource,
  type DoomHeadlessTool,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE as TEST_SERVER, type DoomServerFacet } from '@agimon-ai/doompi-core/serverFacet';
import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/serverFacet';
import { DOOM_MINOR_MODE_CATALOG_SERVICE as TEST_CATALOG } from '@agimon-ai/doompi-minor-mode';
import type { DoomHeadlessMinorMode } from '@agimon-ai/doompi-minor-mode';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';

import { facet as workflowServerFacet } from '../../../generated/server';
import { workflowLaunchLine } from '../../../src/extensions/workspaces/sessions/(frontend)/_lib/launchLine';

const embeddedFeature = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  const control = {
    start: vi.fn(async () => undefined),
    pause: vi.fn(async () => ({ ok: 'paused' })),
    resume: vi.fn(async () => ({ ok: 'resumed' })),
    stop: vi.fn(async () => ({ ok: 'stopped' })),
    dispose: vi.fn(),
    on: vi.fn((event: string, listener: () => void) => {
      const current = listeners.get(event) ?? new Set();
      current.add(listener);
      listeners.set(event, current);
      return () => current.delete(listener);
    }),
  };
  const statuses = { execute: vi.fn(async () => []) };
  let recordFilter: ((record: Record<string, unknown>) => boolean) | undefined;
  const feature = {
    createListStatusesTool: vi.fn((options: { recordFilter: (record: Record<string, unknown>) => boolean }) => {
      recordFilter = options.recordFilter;
      return statuses;
    }),
    createRunControl: vi.fn(() => control),
    listWorkflowsTool: {
      getInputSchema: vi.fn(() => ({})),
      execute: vi.fn(async () => ({
        content: [
          { type: 'text', text: 'workflow-one' },
          { type: 'image', data: 'workflow-image', mimeType: 'image/png' },
          { type: 'unknown' },
          { type: 'text', text: 42 },
        ],
      })),
    },
    runTool: {
      getInputSchema: vi.fn(() => ({})),
      execute: vi.fn(
        async (_parameters?: {
          env?: Record<string, string>;
          workflowPath?: string;
        }): Promise<{
          content: { type: string; text: string }[];
          isError?: boolean;
        }> => ({ content: [{ type: 'text', text: 'workflow launched' }] }),
      ),
    },
  };
  return {
    control,
    statuses,
    feature,
    getRecordFilter: () => recordFilter,
    emit: (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
});

const workflowWatcher = vi.hoisted(() => ({
  records: [
    { piSessionId: 'workflow-headless-test', view: { runKey: 'run-1', workspace: '/tmp' } },
    { piSessionId: 'other', view: { runKey: 'foreign', workspace: '/tmp' } },
    { view: { runKey: 'unstamped', workspace: '/tmp' } },
  ] as Array<{ piSessionId?: string; view: Record<string, unknown> }>,
}));

vi.mock('@agimon-ai/workflow-mcp', () => ({
  createEmbeddedWorkflowFeature: () => embeddedFeature.feature,
}));
vi.mock('../../../src/services/workflowCatalogDeps', () => ({
  defaultCatalogDeps: () => ({
    list: async () => [
      { path: '/tmp/build.workflow.yml', relativePath: 'build.workflow.yml', name: 'build', description: '', tags: [] },
      {
        path: '/tmp/blog.workflow.yml',
        relativePath: 'blog.workflow.yml',
        name: 'Blog Writing',
        description: '',
        tags: [],
      },
      {
        path: '/tmp/broken.workflow.yml',
        relativePath: 'broken.workflow.yml',
        name: 'broken',
        description: '',
        tags: [],
      },
    ],
    stamp: () => undefined,
    summarize: (path: string) => ({
      triggers: [],
      inputs: path.includes('blog') ? [{ name: 'brief', required: true }] : [],
      jobs: [],
      artifacts: [],
      ...(path.includes('broken') ? { error: 'Invalid workflow' } : {}),
    }),
  }),
}));
vi.mock('../../../src/services/workflowWatcher', () => ({
  readWorkflowRuns: () => workflowWatcher.records,
}));
vi.mock('zod', () => ({ z: { toJSONSchema: vi.fn(() => ({ type: 'object' })) } }));

async function fixture() {
  workflowWatcher.records = [
    { piSessionId: 'workflow-headless-test', view: { runKey: 'run-1', workspace: '/tmp' } },
    { piSessionId: 'other', view: { runKey: 'foreign', workspace: '/tmp' } },
    { view: { runKey: 'unstamped', workspace: '/tmp' } },
  ];
  let minorModes: string[] = [];
  const execution = {
    cwd: process.cwd(),
    repoRoot: process.cwd(),
    sessionId: 'workflow-headless-test',
    get selection() {
      return { majorMode: 'copilot', activeLayers: [], domains: [], state: { 'minor-mode': minorModes } };
    },
    client: { notify: vi.fn(), request: vi.fn(), setStatus: vi.fn() },
    session: {
      entries: vi.fn(() => []),
      appendCustomEntry: vi.fn(),
      prompt: vi.fn(),
      abort: vi.fn(),
      compact: vi.fn(),
      activity: vi.fn(),
    },
    shutdown: vi.fn(),
  } as unknown as DoomHeadlessExecutionContext;
  const modes: DoomHeadlessMinorMode[] = [];
  const activities: DoomHeadlessActivity[] = [];
  const tools: DoomHeadlessTool[] = [];
  const resources: DoomHeadlessResource[] = [];
  const commands: DoomHeadlessCommand[] = [];
  const hooks: DoomHeadlessHook[] = [];
  const registration = { dispose: vi.fn() };
  const registerToolRestriction = vi.fn(() => registration);
  let backgroundProvider: BackgroundWorkProvider | undefined;
  const backgroundUpdate = vi.fn();
  const backgroundDispose = vi.fn();
  const registerBackground = vi.fn((provider: BackgroundWorkProvider) => {
    backgroundProvider = provider;
    return { provider: provider.provider, generation: 'test', update: backgroundUpdate, dispose: backgroundDispose };
  });
  const publish = vi.fn();
  const modeDispose = vi.fn();
  const registerOwner = vi.fn((mode: DoomHeadlessMinorMode) => {
    modes.push(mode);
    return { publish, dispose: modeDispose };
  });
  const host = {
    context: execution,
    changeSelection: vi.fn(async ({ values: selected }: { values?: string[] }) => {
      if (selected) minorModes = selected;
    }),
    assertActive: vi.fn(),
    subscribeSelection: vi.fn(() => () => undefined),
    registerToolRestriction,
    registerActivity: (activity: DoomHeadlessActivity) => {
      activities.push(activity);
      return registration;
    },
    registerTool: (tool: DoomHeadlessTool) => {
      tools.push(tool);
      return registration;
    },
    registerResource: (resource: DoomHeadlessResource) => {
      resources.push(resource);
      return registration;
    },
    registerCommand: (command: DoomHeadlessCommand) => {
      commands.push(command);
      return registration;
    },
    registerHook: (hook: DoomHeadlessHook) => {
      hooks.push(hook);
      return registration;
    },
  } as unknown as DoomHeadlessHostService;
  const serverHost = {
    scope: 'session',
    registerApi: () => registration,
    registerChannel: () => registration,
    context: { directEvents: { publish: vi.fn() } },
  } as unknown as DoomServerHostService;
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, serverHost);
  context.provide(DOOM_HEADLESS_HOST_SERVICE, host);
  context.provide(DOOM_BACKGROUND_WORK_SERVICE, {
    generation: 'test',
    register: registerBackground,
    snapshot: () => ({ items: [], errors: [] }),
  });
  const close = await mountFacet(workflowServerFacet, context, host, registerOwner);
  await vi.waitFor(() => expect(registerBackground).toHaveBeenCalledOnce());
  return {
    execution,
    modes,
    activities,
    tools,
    resources,
    commands,
    hooks,
    publish,
    modeDispose,
    registration,
    registerToolRestriction,
    close,
    backgroundProvider: () => backgroundProvider,
    backgroundUpdate,
    backgroundDispose,
  };
}

function operation(execution: DoomHeadlessExecutionContext) {
  return {
    context: execution,
    operationId: 'workflow-headless-test',
    sessionKind: 'headless' as const,
    signal: new AbortController().signal,
  };
}

describe('workflow headless facet', () => {
  it('resolves discovery against each invocation cwd, including a worktree sharing its workspace', async () => {
    const test = await fixture();
    try {
      const list = test.tools.find(({ name }) => name === 'list_workflows');
      if (!list) throw new Error('Missing list_workflows tool');
      const workspace = { ...test.execution, cwd: '/tmp/workspace', repoRoot: '/tmp/workspace' };
      const worktree = { ...workspace, cwd: '/tmp/worktree' };
      const execute = embeddedFeature.feature.listWorkflowsTool.execute;
      await list.execute('workspace', {}, undefined, undefined, workspace);
      expect(execute).toHaveBeenLastCalledWith({ directory: workspace.cwd });
      await list.execute(
        'worktree',
        { directory: 'automations', filter: 'blog', page: 2 },
        undefined,
        undefined,
        worktree,
      );
      expect(execute).toHaveBeenLastCalledWith({
        directory: resolve(worktree.cwd, 'automations'),
        filter: 'blog',
        page: 2,
      });
      await list.execute('absolute', { directory: workspace.cwd }, undefined, undefined, worktree);
      expect(execute).toHaveBeenLastCalledWith({ directory: workspace.cwd });
      await list.execute('worktree-again', {}, undefined, undefined, worktree);
      expect(execute).toHaveBeenLastCalledWith({ directory: worktree.cwd });
      await list.execute('workspace-again', {}, undefined, undefined, workspace);
      expect(execute).toHaveBeenLastCalledWith({ directory: workspace.cwd });
    } finally {
      await test.close?.();
    }
  });
  it('adds workflow tools without restricting other packages', async () => {
    const test = await fixture();
    try {
      await test.modes[0]!.handleAction('activate', {}, operation(test.execution));
      expect(test.registerToolRestriction).not.toHaveBeenCalled();
      expect(test.tools.map(({ name }) => name).sort()).toEqual(['launch_workflow', 'list_workflows', 'workflow_run']);
      for (const tool of test.tools) expect(tool.when?.state).toEqual({ 'minor-mode': 'workflow' });
      await test.modes[0]!.handleAction('deactivate', {}, operation(test.execution));
      expect(test.registerToolRestriction).not.toHaveBeenCalled();
    } finally {
      await test.close?.();
    }
  });
  it('executes mode, resource, workflow, run-control, command, and shutdown boundaries', async () => {
    const test = await fixture();
    const mode = test.modes[0];
    const activity = test.activities[0];
    const list = test.tools.find(({ name }) => name === 'list_workflows');
    const launch = test.tools.find(({ name }) => name === 'launch_workflow');
    const run = test.tools.find(({ name }) => name === 'workflow_run');
    const command = test.commands[0];
    const shutdown = test.hooks.find(({ event }) => event === 'session_shutdown') as
      | DoomHeadlessHook<'session_shutdown'>
      | undefined;
    if (!mode || !activity || !list || !launch || !run || !command || !shutdown)
      throw new Error('Workflow headless registrations were not created');

    expect(mode.initialState).toMatchObject({ activation: 'inactive', condition: 'ready' });
    await expect(mode.handleAction('activate', {}, operation(test.execution))).resolves.toEqual({
      message: 'Workflow mode activated.',
    });
    await expect(mode.handleAction('deactivate', {}, operation(test.execution))).resolves.toEqual({
      message: 'Workflow mode deactivated.',
    });
    await expect(mode.handleAction('unknown', {}, operation(test.execution))).rejects.toThrow(
      'Unknown workflow mode action: unknown',
    );

    for (const resource of test.resources.filter(({ name }) => name !== 'workflow-recovery'))
      expect(await resource.read(test.execution)).toContain('workflow');
    const recovery = test.resources.find(({ name }) => name === 'workflow-recovery');
    if (!recovery) throw new Error('Workflow recovery resource was not registered');
    expect(await recovery.read(test.execution)).toContain('recovery');
    const listed = await list.execute('list', {}, undefined, undefined, test.execution);
    expect(listed.content).toEqual([
      { type: 'text', text: 'workflow-one' },
      { type: 'image', data: 'workflow-image', mimeType: 'image/png' },
    ]);
    expect(await launch.execute('launch', {}, undefined, undefined, test.execution)).toEqual({
      content: [{ type: 'text', text: 'workflow launched' }],
      details: { content: [{ type: 'text', text: 'workflow launched' }] },
    });
    expect(
      await run.execute('run-status', { action: 'status', runKey: 'run-1' }, undefined, undefined, test.execution),
    ).toEqual({
      content: [{ type: 'text', text: '{\n  "runKey": "run-1",\n  "workspace": "/tmp"\n}' }],
      details: { runKey: 'run-1', workspace: '/tmp' },
    });
    expect(
      await run.execute(
        'run-pause-no-control',
        { action: 'pause', runKey: 'run-1' },
        undefined,
        undefined,
        test.execution,
      ),
    ).toEqual({
      content: [{ type: 'text', text: '{\n  "error": "Workflow activity is not active."\n}' }],
      details: { error: 'Workflow activity is not active.' },
    });

    for (const runKey of ['foreign', 'unstamped', 'missing']) {
      expect(
        await run.execute('missing', { action: 'status', runKey }, undefined, undefined, test.execution),
      ).toMatchObject({
        isError: true,
        details: { error: 'Workflow run was not found in this session.' },
      });
    }
    const stopActivity = await activity.start(test.execution);
    expect(embeddedFeature.control.start).toHaveBeenCalledOnce();
    await expect(
      run.execute('run-missing-id', { action: 'pause', runKey: 'run-1' }, undefined, undefined, test.execution),
    ).resolves.toMatchObject({
      details: { error: 'expectedRunId is required for workflow control.' },
    });
    await run.execute(
      'run-pause',
      { action: 'pause', runKey: 'run-1', expectedRunId: 'expected-1', workspace: '/tmp', reason: 'test' },
      undefined,
      undefined,
      test.execution,
    );
    await run.execute(
      'run-resume',
      { action: 'resume', runKey: 'run-1', expectedRunId: 'expected-1', workspace: '/tmp' },
      undefined,
      undefined,
      test.execution,
    );
    await run.execute(
      'run-stop',
      { action: 'stop', runKey: 'run-1', expectedRunId: 'expected-1', workspace: '/tmp', reason: 'test' },
      undefined,
      undefined,
      test.execution,
    );
    expect(embeddedFeature.control.pause).toHaveBeenCalledWith('run-1', 'expected-1', '/tmp', 'test');
    expect(embeddedFeature.control.resume).toHaveBeenCalledWith('run-1', 'expected-1', '/tmp');
    expect(embeddedFeature.control.stop).toHaveBeenCalledWith('run-1', 'expected-1', '/tmp', 'test');

    await command.execute('', test.execution);
    expect(test.execution.client.notify).toHaveBeenCalledWith({
      body: 'Usage: /workflow-launch <workflow> [key=value …] [prompt]',
      level: 'error',
    });
    await command.execute('build runner=local environment=prod Deploy now', test.execution);
    expect(embeddedFeature.feature.runTool.execute).toHaveBeenLastCalledWith({
      workflowPath: '/tmp/build.workflow.yml',
      runner: 'local',
      inputs: { environment: 'prod' },
      prompt: 'Deploy now',
      env: { PI_SESSION_ID: test.execution.sessionId },
    });
    expect(test.execution.client.notify).toHaveBeenLastCalledWith({ body: 'workflow launched', level: 'info' });

    await shutdown.handle({}, test.execution);
    expect(embeddedFeature.control.dispose).toHaveBeenCalledOnce();
    await stopActivity();
    await test.close?.();
    expect(test.modeDispose).toHaveBeenCalledOnce();
    expect(test.registration.dispose).toHaveBeenCalled();
  });

  it('resolves a browser launch and makes both launch paths visible to session status', async () => {
    const test = await fixture();
    try {
      const command = test.commands[0]!;
      const launch = test.tools.find(({ name }) => name === 'launch_workflow')!;
      const status = test.tools.find(({ name }) => name === 'workflow_run')!;
      embeddedFeature.feature.runTool.execute.mockImplementationOnce(async (parameters) => {
        workflowWatcher.records.push({
          piSessionId: parameters?.env?.PI_SESSION_ID,
          view: { runKey: 'browser-run', workspace: '/tmp' },
        });
        return { content: [{ type: 'text', text: 'workflow launched' }] };
      });
      const line = workflowLaunchLine({
        workflow: 'Blog Writing',
        inputs: { brief: 'a good post' },
        prompt: 'Draft it',
      });
      await command.execute(line.slice('/workflow-launch '.length), test.execution);
      expect(embeddedFeature.feature.runTool.execute).toHaveBeenLastCalledWith({
        workflowPath: '/tmp/blog.workflow.yml',
        inputs: { brief: 'a good post' },
        prompt: 'Draft it',
        env: { PI_SESSION_ID: test.execution.sessionId },
      });
      expect(
        await status.execute(
          'status',
          { action: 'status', runKey: 'browser-run' },
          undefined,
          undefined,
          test.execution,
        ),
      ).toMatchObject({ details: { runKey: 'browser-run', workspace: '/tmp' } });

      embeddedFeature.feature.runTool.execute.mockImplementationOnce(async (parameters) => {
        workflowWatcher.records.push({
          piSessionId: parameters?.env?.PI_SESSION_ID,
          view: { runKey: 'tool-run', workspace: '/tmp' },
        });
        return { content: [{ type: 'text', text: 'workflow launched' }] };
      });
      await launch.execute(
        'launch',
        { workflowPath: '/tmp/build.workflow.yml', env: { CUSTOM: 'kept', PI_SESSION_ID: 'foreign' } },
        undefined,
        undefined,
        test.execution,
      );
      expect(embeddedFeature.feature.runTool.execute).toHaveBeenLastCalledWith({
        workflowPath: '/tmp/build.workflow.yml',
        env: { CUSTOM: 'kept', PI_SESSION_ID: test.execution.sessionId },
      });
      expect(
        await status.execute('status', { action: 'status', runKey: 'tool-run' }, undefined, undefined, test.execution),
      ).toMatchObject({ details: { runKey: 'tool-run', workspace: '/tmp' } });
    } finally {
      await test.close?.();
    }
  });

  it('rejects invalid manual launches and preserves engine errors', async () => {
    const test = await fixture();
    try {
      const command = test.commands[0]!;
      const launch = test.tools.find(({ name }) => name === 'launch_workflow')!;
      const calls = embeddedFeature.feature.runTool.execute.mock.calls.length;
      for (const name of ['missing', 'broken', 'Blog Writing']) {
        await command.execute(name, test.execution);
        expect(test.execution.client.notify).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'error' }));
      }
      expect(embeddedFeature.feature.runTool.execute).toHaveBeenCalledTimes(calls);
      embeddedFeature.feature.runTool.execute.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'engine failed' }],
        isError: true,
      });
      expect(
        await launch.execute(
          'launch',
          { workflowPath: '/tmp/build.workflow.yml' },
          undefined,
          undefined,
          test.execution,
        ),
      ).toMatchObject({ isError: true });
      embeddedFeature.feature.runTool.execute.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'engine failed' }],
        isError: true,
      });
      await command.execute('build', test.execution);
      expect(test.execution.client.notify).toHaveBeenLastCalledWith({ body: 'engine failed', level: 'error' });
    } finally {
      await test.close?.();
    }
  });

  it('reports only active owned workflow runs as background work', async () => {
    const test = await fixture();
    const startedAt = new Date().toISOString();
    workflowWatcher.records = [
      {
        piSessionId: 'workflow-headless-test',
        view: { runKey: 'owned', workspace: '/repo', stage: 'running', startedAt, jobs: [] },
      },
      { piSessionId: 'other', view: { runKey: 'foreign', workspace: '/repo', stage: 'running', startedAt, jobs: [] } },
      { view: { runKey: 'unstamped', workspace: '/repo', stage: 'running', startedAt, jobs: [] } },
      {
        piSessionId: 'workflow-headless-test',
        view: { runKey: 'stale', workspace: '/repo', stage: 'running', startedAt, stale: true, jobs: [] },
      },
      {
        piSessionId: 'workflow-headless-test',
        view: { runKey: 'done', workspace: '/repo', stage: 'completed', startedAt, finishedAt: startedAt, jobs: [] },
      },
    ];
    const activity = test.activities[0];
    if (!activity) throw new Error('Workflow activity was not registered');

    const stop = await activity.start(test.execution);
    expect(test.backgroundProvider()?.provider).toBe('workflow-mcp');
    expect(test.backgroundProvider()?.listActiveWork()).toEqual([
      { id: '/repo/owned', sessionId: 'workflow-headless-test' },
    ]);

    const disposalCount = embeddedFeature.control.dispose.mock.calls.length;
    await stop();
    await vi.waitFor(() => expect(test.backgroundProvider()?.listActiveWork()).toHaveLength(1));
    expect(embeddedFeature.control.dispose).toHaveBeenCalledTimes(disposalCount);

    workflowWatcher.records = [];
    embeddedFeature.emit('runFinished');
    await vi.waitFor(() => expect(test.backgroundProvider()?.listActiveWork()).toEqual([]));
    expect(test.backgroundUpdate).toHaveBeenCalled();
    await vi.waitFor(() => expect(embeddedFeature.control.dispose).toHaveBeenCalledTimes(disposalCount + 1));

    await test.close?.();
    expect(test.backgroundDispose).toHaveBeenCalled();
  });

  it('cleans up a failed workflow monitor before retrying', async () => {
    const test = await fixture();
    const activity = test.activities[0];
    if (!activity) throw new Error('Workflow activity was not registered');
    const disposalCount = embeddedFeature.control.dispose.mock.calls.length;
    embeddedFeature.control.start.mockRejectedValueOnce(new Error('monitor failed'));

    await expect(activity.start(test.execution)).rejects.toThrow('monitor failed');
    expect(embeddedFeature.control.dispose).toHaveBeenCalledTimes(disposalCount + 1);

    embeddedFeature.control.start.mockResolvedValueOnce(undefined);
    const stop = await activity.start(test.execution);
    await stop();
    await test.close?.();
  });

  it('keeps the monitor when Workflow mode is reactivated during cleanup', async () => {
    const test = await fixture();
    const mode = test.modes[0];
    const activity = test.activities[0];
    if (!mode || !activity) throw new Error('Workflow mode and activity were not registered');
    await mode.handleAction('activate', {}, operation(test.execution));
    const stop = await activity.start(test.execution);
    await mode.handleAction('deactivate', {}, operation(test.execution));
    const disposalCount = embeddedFeature.control.dispose.mock.calls.length;

    void stop();
    await mode.handleAction('activate', {}, operation(test.execution));
    await activity.start(test.execution);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(embeddedFeature.control.dispose).toHaveBeenCalledTimes(disposalCount);
    await test.close?.();
  });
});

async function mountFacet(
  facet: DoomServerFacet,
  existing: Context,
  host: DoomHeadlessHostService,
  registerOwner: ReturnType<typeof vi.fn>,
) {
  const root = new Context();
  root.provide(TEST_SERVER, existing.get(TEST_SERVER));
  root.provide(TEST_AGENT, host);
  root.provide(DOOM_BACKGROUND_WORK_SERVICE, existing.get(DOOM_BACKGROUND_WORK_SERVICE)!);
  root.provide(TEST_CATALOG, { registerOwner } as never);
  const owner = root.extend({ [TEST_OWNER]: { packageName: '@fixture/mode' } });
  const release = await facet.apply(owner);
  await vi.waitFor(() => expect(registerOwner).toHaveBeenCalled());
  return async () => {
    await release?.();
    await root.fiber.dispose();
  };
}
