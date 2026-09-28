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
import type { DoomApi, DoomApiContext } from '@agimon-ai/doompi-core/packageApi';
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
  // Launches run in-process: each gets its own run service, whose run() is this mock.
  const run = vi.fn(
    async (_input?: {
      env?: Record<string, string>;
      workflowPath?: string;
    }): Promise<{ exitCode: number; output: string }> => ({ exitCode: 0, output: 'workflow launched' }),
  );
  let recordFilter: ((record: Record<string, unknown>) => boolean) | undefined;
  const feature = {
    createListStatusesTool: vi.fn((options: { recordFilter: (record: Record<string, unknown>) => boolean }) => {
      recordFilter = options.recordFilter;
      return statuses;
    }),
    createRunControl: vi.fn(() => control),
    createRunService: vi.fn(() => ({ run })),
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
      getInputSchema: vi.fn(() => ({ parse: (value: unknown) => value })),
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
    run,
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

vi.mock('@agimon-ai/workflow-mcp', async (importOriginal) => ({
  // The session API builds the real registry; only the engine is replaced.
  ...(await importOriginal<typeof import('@agimon-ai/workflow-mcp')>()),
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
// The executor has its own tests; this suite covers how the facet launches and controls runs.
vi.mock('../../../src/services/stepExecutor', () => ({
  createStepExecutor: vi.fn(() => ({})),
  createNativeStepPaneLauncher: vi.fn(),
}));

async function fixture(
  options: { environment?: Record<string, string>; requestApi?: DoomApiContext['requestApi'] } = {},
) {
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
    environment: options.environment ?? {},
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
  const apis: DoomApi[] = [];
  const serverHost = {
    scope: 'session',
    registerApi: (api: DoomApi) => {
      apis.push(api);
      return { mounted: true, dispose: vi.fn() };
    },
    registerChannel: () => registration,
    context: {
      directEvents: { publish: vi.fn() },
      ...(options.requestApi === undefined ? {} : { requestApi: options.requestApi }),
    },
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
    apis,
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
    expect(list.promptGuidelines?.join(' ')).toContain('not to find an existing run');
    expect(launch.promptGuidelines?.join(' ')).toContain('not when it finishes');
    expect(run.promptGuidelines?.join(' ')).toContain('Do not automatically search CLI commands or filesystem logs');
    expect(run.parameters).toMatchObject({
      properties: {
        runKey: { description: expect.stringContaining('Not an Agiflow job ID') },
        workspace: { description: expect.stringContaining('separately from runKey') },
      },
    });

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
    await launch.execute('launch', { workflowPath: 'automations/build.yml' }, undefined, undefined, {
      ...test.execution,
      cwd: '/external/worktree/subdir',
    });
    expect(embeddedFeature.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ workflowPath: '/external/worktree/subdir/automations/build.yml' }),
    );
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
        details: { error: expect.stringContaining('lookup failure, not evidence that the workflow failed') },
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
    expect(embeddedFeature.run).toHaveBeenLastCalledWith({
      workflowPath: '/tmp/build.workflow.yml',
      runner: 'local',
      inputs: { environment: 'prod' },
      prompt: 'Deploy now',
      env: { PI_SESSION_ID: test.execution.sessionId },
      skipLaunch: true,
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
      embeddedFeature.run.mockImplementationOnce(async (parameters) => {
        workflowWatcher.records.push({
          piSessionId: parameters?.env?.PI_SESSION_ID,
          view: { runKey: 'browser-run', workspace: '/tmp' },
        });
        return { exitCode: 0, output: 'workflow launched' };
      });
      const line = workflowLaunchLine({
        workflow: 'Blog Writing',
        inputs: { brief: 'a good post' },
        prompt: 'Draft it',
      });
      await command.execute(line.slice('/workflow-launch '.length), test.execution);
      expect(embeddedFeature.run).toHaveBeenLastCalledWith({
        workflowPath: '/tmp/blog.workflow.yml',
        inputs: { brief: 'a good post' },
        prompt: 'Draft it',
        env: { PI_SESSION_ID: test.execution.sessionId },
        skipLaunch: true,
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

      embeddedFeature.run.mockImplementationOnce(async (parameters) => {
        workflowWatcher.records.push({
          piSessionId: parameters?.env?.PI_SESSION_ID,
          view: { runKey: 'tool-run', workspace: '/tmp' },
        });
        return { exitCode: 0, output: 'workflow launched' };
      });
      await launch.execute(
        'launch',
        { workflowPath: '/tmp/build.workflow.yml', env: { CUSTOM: 'kept', PI_SESSION_ID: 'foreign' } },
        undefined,
        undefined,
        test.execution,
      );
      expect(embeddedFeature.run).toHaveBeenLastCalledWith({
        workflowPath: '/tmp/build.workflow.yml',
        env: { CUSTOM: 'kept', PI_SESSION_ID: test.execution.sessionId },
        skipLaunch: true,
      });
      expect(
        await status.execute('status', { action: 'status', runKey: 'tool-run' }, undefined, undefined, test.execution),
      ).toMatchObject({ details: { runKey: 'tool-run', workspace: '/tmp' } });
    } finally {
      await test.close?.();
    }
  });

  it('answers a launch once the in-process run registers, without waiting for it to finish', async () => {
    const test = await fixture();
    try {
      const launch = test.tools.find(({ name }) => name === 'launch_workflow')!;
      embeddedFeature.run.mockImplementationOnce(async (parameters) => {
        workflowWatcher.records.push({
          piSessionId: parameters?.env?.PI_SESSION_ID,
          view: {
            runKey: 'long-run',
            workspace: '/tmp',
            displayName: 'build-long',
            workflowPath: '/tmp/build.workflow.yml',
            startedAt: new Date().toISOString(),
          },
        });
        return new Promise<never>(() => undefined);
      });
      const result = await launch.execute(
        'launch',
        { workflowPath: '/tmp/build.workflow.yml' },
        undefined,
        undefined,
        test.execution,
      );
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Run key: long-run') }]);
    } finally {
      await test.close?.();
    }
  });

  it('hands a dispatcher launch to the owning session, which runs and keeps it', async () => {
    const requestApi = vi.fn(async (_mount: unknown, _basePath: string, _request: Request) =>
      Response.json({ text: 'Started build.\nRun key: root-run' }),
    );
    const test = await fixture({ environment: { DOOMPI_WORKFLOW_LAUNCH_SESSION: 'root-session' }, requestApi });
    try {
      const launch = test.tools.find(({ name }) => name === 'launch_workflow')!;
      const calls = embeddedFeature.run.mock.calls.length;
      const result = await launch.execute(
        'launch',
        { workflowPath: '/tmp/build.workflow.yml', runner: 'pi-codex' },
        undefined,
        undefined,
        test.execution,
      );

      expect(result.content).toEqual([{ type: 'text', text: 'Started build.\nRun key: root-run' }]);
      expect(result.isError).toBeUndefined();
      expect(embeddedFeature.run).toHaveBeenCalledTimes(calls);
      const [mount, basePath, request] = requestApi.mock.calls[0]!;
      expect(mount).toEqual({ scope: 'session', sessionId: 'root-session' });
      expect(basePath).toBe('workflow');
      expect(request.method).toBe('POST');
      expect(new URL(request.url).pathname).toBe('/launch');
      expect(await request.json()).toEqual({ workflowPath: '/tmp/build.workflow.yml', runner: 'pi-codex' });

      requestApi.mockResolvedValueOnce(Response.json({ error: 'Session not found.' }, { status: 404 }));
      expect(
        await launch.execute(
          'launch',
          { workflowPath: '/tmp/build.workflow.yml' },
          undefined,
          undefined,
          test.execution,
        ),
      ).toMatchObject({
        isError: true,
        content: [
          { type: 'text', text: 'Error: session root-session did not launch the workflow (Session not found.).' },
        ],
      });
    } finally {
      await test.close?.();
    }
  });

  it('runs a launch another session hands it through its own API mount', async () => {
    const test = await fixture();
    try {
      embeddedFeature.run.mockImplementationOnce(async (parameters) => {
        workflowWatcher.records.push({
          piSessionId: parameters?.env?.PI_SESSION_ID,
          view: {
            runKey: 'handed-run',
            workspace: '/tmp',
            displayName: 'build-handed',
            workflowPath: '/tmp/build.workflow.yml',
            startedAt: new Date().toISOString(),
          },
        });
        return new Promise<never>(() => undefined);
      });
      const api = test.apis.find(({ basePath }) => basePath === 'workflow')!;
      const handler = api.start({ scope: 'session' } as DoomApiContext);
      const response = await handler.fetch(
        new Request('http://doompi.local/launch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workflowPath: '/tmp/build.workflow.yml' }),
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: expect.stringContaining('Run key: handed-run') });
      expect(embeddedFeature.run).toHaveBeenLastCalledWith(
        expect.objectContaining({ env: { PI_SESSION_ID: 'workflow-headless-test' }, skipLaunch: true }),
      );
    } finally {
      await test.close?.();
    }
  });

  it('rejects invalid manual launches and preserves engine errors', async () => {
    const test = await fixture();
    try {
      const command = test.commands[0]!;
      const launch = test.tools.find(({ name }) => name === 'launch_workflow')!;
      const calls = embeddedFeature.run.mock.calls.length;
      for (const name of ['missing', 'broken', 'Blog Writing']) {
        await command.execute(name, test.execution);
        expect(test.execution.client.notify).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'error' }));
      }
      expect(embeddedFeature.run).toHaveBeenCalledTimes(calls);
      embeddedFeature.run.mockResolvedValueOnce({ exitCode: 1, output: 'engine failed' });
      expect(
        await launch.execute(
          'launch',
          { workflowPath: '/tmp/build.workflow.yml' },
          undefined,
          undefined,
          test.execution,
        ),
      ).toMatchObject({ isError: true });
      embeddedFeature.run.mockResolvedValueOnce({ exitCode: 1, output: 'engine failed' });
      await command.execute('build', test.execution);
      expect(test.execution.client.notify).toHaveBeenLastCalledWith({
        body: 'Workflow failed (exit code 1):\n\nengine failed',
        level: 'error',
      });
    } finally {
      await test.close?.();
    }
  });

  it('republishes run state on job and step transitions, which only the progress log records', async () => {
    const test = await fixture();
    try {
      const activity = test.activities[0]!;
      const stop = await activity.start(test.execution);
      for (const transition of ['step', 'job'] as const) {
        const calls = test.backgroundUpdate.mock.calls.length;
        embeddedFeature.emit(transition);
        await vi.waitFor(() => expect(test.backgroundUpdate.mock.calls.length).toBeGreaterThan(calls));
      }
      await stop();
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
