import fs from 'node:fs';
import os from 'node:os';
import path, { resolve } from 'node:path';

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
import { createServerLauncher } from '../../../src/services/serverLaunch';
import type { ServerLaunchDependencies } from '../../../src/services/serverLaunch/type';

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
  type Registration = { runKey: string; runId: string; workspace: string; runDir: string; displayName: string };
  const run = vi.fn(
    async (input?: {
      env?: Record<string, string>;
      workflowPath?: string;
      onRegistered?: (registration: Registration) => void;
    }): Promise<{ exitCode: number; output: string }> => {
      input?.onRegistered?.({
        runKey: 'registered-run',
        runId: 'run-id',
        workspace: '/tmp',
        runDir: '/tmp/no-such-run-dir',
        displayName: 'registered-run',
      });
      return { exitCode: 0, output: 'workflow launched' };
    },
  );
  const runLoggers: { error: (message: string) => void }[] = [];
  // A run a test leaves going ends when the session asks it to stop, as the engine's would.
  const pendingRuns: (() => void)[] = [];
  const recover = vi.fn(async (): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> => ({
    content: [{ type: 'text', text: 'recovered' }],
  }));
  const registry = {
    listRuns: vi.fn(
      async () =>
        [] as Array<{
          runKey: string;
          workspace: string;
          stage: string;
          displayName: string;
          env?: Record<string, string>;
        }>,
    ),
    runDirectoryFor: vi.fn(() => '/tmp/missing-recovery-evidence'),
    readRunByKey: vi.fn(async (workspace: string, _stage: string, runKey: string) => ({
      runKey,
      workspace,
      displayName: runKey,
    })),
    requestStop: vi.fn(async () => {
      for (const settle of pendingRuns.splice(0)) settle();
    }),
  };
  let recordFilter: ((record: Record<string, unknown>) => boolean) | undefined;
  const feature = {
    createRecoverTool: vi.fn((_options?: { ownerSessionId: () => string }) => ({ execute: recover })),
    createListStatusesTool: vi.fn((options: { recordFilter: (record: Record<string, unknown>) => boolean }) => {
      recordFilter = options.recordFilter;
      return statuses;
    }),
    createRunControl: vi.fn(() => control),
    createRunService: vi.fn((options?: { logger?: { error: (message: string) => void } }) => {
      if (options?.logger) runLoggers.push(options.logger);
      return { run };
    }),
    registry,
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
    recover,
    control,
    statuses,
    feature,
    run,
    registry,
    runLoggers,
    pendingRuns,
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
vi.mock('zod', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zod')>();
  return { ...actual, z: { ...actual.z, toJSONSchema: vi.fn(() => ({ type: 'object' })) } };
});
const telemetry = vi.hoisted(() => ({
  recordEvent: vi.fn(async () => undefined),
  recordWarning: vi.fn(async () => undefined),
  recordError: vi.fn(async () => undefined),
  shutdown: vi.fn(async () => undefined),
}));
vi.mock('@agimon-ai/doompi-telemetry', () => ({ createDoomTelemetry: () => telemetry }));
// The executor has its own tests; this suite covers how the facet launches and controls runs.
vi.mock('../../../src/services/stepExecutor', () => ({
  createStepExecutor: vi.fn(() => ({})),
  createNativeStepPaneLauncher: vi.fn(),
}));

async function fixture(
  options: {
    environment?: Record<string, string>;
    requestApi?: DoomApiContext['requestApi'];
    sessionService?: DoomApiContext['sessionService'];
    sessionCommunication?: DoomApiContext['sessionCommunication'];
    publishActivity?: DoomApiContext['publishActivity'];
    sessionContext?: DoomApiContext['sessionContext'];
  } = {},
) {
  workflowWatcher.records = [
    { piSessionId: 'workflow-headless-test', view: { runKey: 'run-1', workspace: '/tmp' } },
    { piSessionId: 'other', view: { runKey: 'foreign', workspace: '/tmp' } },
    { view: { runKey: 'unstamped', workspace: '/tmp' } },
  ];
  let minorModes: string[] = [];
  const execution = {
    cwd: process.cwd(),
    // The mocked catalog lists workflows under /tmp, which launches must be inside.
    repoRoot: '/tmp',
    sessionId: 'workflow-headless-test',
    environment: options.environment ?? {},
    ...(options.sessionContext === undefined ? {} : { sessionContext: options.sessionContext }),
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
      ...(options.sessionService === undefined ? {} : { sessionService: options.sessionService }),
      ...(options.sessionCommunication === undefined ? {} : { sessionCommunication: options.sessionCommunication }),
      ...(options.publishActivity === undefined ? {} : { publishActivity: options.publishActivity }),
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
  it('selects only unambiguous failed runs and validates the flat recovery schema', async () => {
    const test = await fixture();
    const tool = test.tools.find(({ name }) => name === 'workflow_tools')!;
    try {
      for (const records of [
        [],
        [{ runKey: 'broken', workspace: '/tmp', stage: 'running', displayName: 'Broken' }],
        [
          { runKey: 'broken', workspace: '/one', stage: 'error', displayName: 'Broken' },
          { runKey: 'broken', workspace: '/two', stage: 'error', displayName: 'Broken' },
        ],
      ]) {
        embeddedFeature.registry.listRuns.mockResolvedValueOnce(records);
        expect(
          await tool.execute('recover', { action: 'recover', runKey: 'broken' }, undefined, undefined, test.execution),
        ).toMatchObject({ isError: true });
      }
      expect(
        await tool.execute(
          'recover',
          { action: 'recover', runKey: 'broken', job: 'invented' },
          undefined,
          undefined,
          test.execution,
        ),
      ).toMatchObject({ isError: true });
    } finally {
      await test.close();
    }
  });

  it('reads durable evidence and keeps the no-files fallback outside run.json', async () => {
    const test = await fixture();
    const tool = test.tools.find(({ name }) => name === 'workflow_tools')!;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-evidence-'));
    const record = { runKey: 'broken', workspace: '/tmp', stage: 'error', displayName: 'Broken' };
    try {
      embeddedFeature.registry.runDirectoryFor.mockReturnValue(directory);
      embeddedFeature.registry.listRuns.mockResolvedValue([record]);
      const empty = await tool.execute(
        'evidence',
        { action: 'recovery-evidence', runKey: 'broken' },
        undefined,
        undefined,
        test.execution,
      );
      const text = JSON.stringify(empty);
      expect(text).toContain('No durable evidence files found.');
      const evidenceText = empty.content.find((item) => item.type === 'text');
      if (evidenceText?.type !== 'text') throw new Error('Missing evidence text');
      expect(JSON.parse(evidenceText.text.split('--- run.json ---\n')[1]!)).toEqual(record);
      fs.writeFileSync(path.join(directory, 'changelog.md'), 'repair evidence');
      const result = await tool.execute(
        'evidence',
        { action: 'recovery-evidence', runKey: 'broken' },
        undefined,
        undefined,
        test.execution,
      );
      expect(JSON.stringify(result)).toContain('--- changelog.md ---');
      expect(JSON.stringify(result)).not.toContain('--- context.md ---');
      embeddedFeature.recover.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'already claimed' }],
        isError: true,
      });
      expect(
        await tool.execute('recover', { action: 'recover', runKey: 'broken' }, undefined, undefined, test.execution),
      ).toMatchObject({ isError: true });
      expect(
        await tool.execute(
          'dry',
          { action: 'recover', runKey: 'broken', dryRun: true },
          undefined,
          undefined,
          test.execution,
        ),
      ).not.toMatchObject({ isError: true });
      const options = embeddedFeature.feature.createRecoverTool.mock.calls.at(-1)?.[0] as unknown as {
        ownerSessionId(): string;
      };
      expect(options.ownerSessionId()).toBe('workflow-headless-test');
    } finally {
      embeddedFeature.registry.listRuns.mockResolvedValue([]);
      fs.rmSync(directory, { recursive: true, force: true });
      await test.close();
    }
  });

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
      expect(test.tools.map(({ name }) => name).sort()).toEqual([
        'launch_workflow',
        'list_workflows',
        'workflow_run',
        'workflow_tools',
      ]);
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
    const launchGuidelines = launch.promptGuidelines?.join(' ') ?? '';
    expect(launch.description).toContain('in-process Pi');
    expect(launch.description).toContain('command: "pi"');
    expect(launchGuidelines).toContain('inProcess: true');
    expect(launchGuidelines).toContain('runner: "codex" does not imply command: "pi"');
    expect(launchGuidelines).toContain('each step uses its first command');
    expect(launchGuidelines).toContain(
      'Only use an external CLI when the user requests it or no in-process option exists',
    );
    expect(launchGuidelines).toContain('not when it finishes');
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

    for (const resource of test.resources
      .filter(({ kind }) => kind === 'skill')
      .filter(({ name }) => name !== 'workflow-recovery'))
      expect(await resource.read(test.execution)).toContain('workflow');
    // The owner brief is live state that only a workflow session reads; an ordinary session adds nothing.
    const brief = test.resources.find(({ name }) => name === 'workflow-session');
    expect(brief?.kind).toBe('context');
    expect(await brief?.read(test.execution)).toBe('');
    const recovery = test.resources.find(({ name }) => name === 'workflow-recovery');
    if (!recovery) throw new Error('Workflow recovery resource was not registered');
    expect(await recovery.read(test.execution)).toContain('recovery');
    const listed = await list.execute('list', {}, undefined, undefined, test.execution);
    expect(listed.content).toEqual([
      { type: 'text', text: 'workflow-one' },
      { type: 'image', data: 'workflow-image', mimeType: 'image/png' },
    ]);
    expect(await launch.execute('launch', {}, undefined, undefined, test.execution)).toMatchObject({
      content: [{ type: 'text', text: 'Error: A launch needs a workflowPath.' }],
      isError: true,
    });
    await launch.execute('launch', { workflowPath: 'automations/build.yml' }, undefined, undefined, {
      ...test.execution,
      cwd: '/external/worktree/subdir',
      repoRoot: '/external/worktree',
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
      env: { PI_SESSION_ID: test.execution.sessionId, DOOMPI_WORKFLOW_LAUNCH_ID: expect.any(String) },
      skipLaunch: true,
      onRegistered: expect.any(Function),
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
        env: { PI_SESSION_ID: test.execution.sessionId, DOOMPI_WORKFLOW_LAUNCH_ID: expect.any(String) },
        skipLaunch: true,
        onRegistered: expect.any(Function),
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
        env: {
          CUSTOM: 'kept',
          PI_SESSION_ID: test.execution.sessionId,
          DOOMPI_WORKFLOW_LAUNCH_ID: expect.any(String),
        },
        skipLaunch: true,
        onRegistered: expect.any(Function),
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
      embeddedFeature.run.mockImplementationOnce((parameters) => {
        parameters?.onRegistered?.({
          runKey: 'long-run',
          runId: 'long-id',
          workspace: '/tmp',
          runDir: '/tmp/no-such-run-dir',
          displayName: 'build-long',
        });
        return new Promise((resolve) => embeddedFeature.pendingRuns.push(() => resolve({ exitCode: 0, output: '' })));
      });
      const result = await launch.execute(
        'launch',
        { workflowPath: '/tmp/build.workflow.yml' },
        undefined,
        undefined,
        test.execution,
      );
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Run key: long-run') }]);
      expect(telemetry.recordEvent).toHaveBeenCalledWith('doom_workflow.run_started', { outcome: 'started' });
    } finally {
      await test.close?.();
    }
    // Closing the session stops the run it was still running.
    expect(embeddedFeature.registry.requestStop).toHaveBeenCalledWith(
      '/tmp',
      'long-run',
      'The session that runs this workflow closed.',
      'long-id',
    );
  });

  it('keeps the engine log in the run directory and reports its errors and a late failure', async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-run-'));
    const test = await fixture();
    try {
      const launch = test.tools.find(({ name }) => name === 'launch_workflow')!;
      let fail: () => void = () => undefined;
      embeddedFeature.run.mockImplementationOnce((parameters) => {
        const logger = embeddedFeature.runLoggers.at(-1)!;
        logger.error('\u001b[31merror\u001b[0m step "Build" failed: No configured model matched p/unknown.');
        parameters?.onRegistered?.({
          runKey: 'logged-run',
          runId: 'logged-id',
          workspace: '/tmp',
          runDir,
          displayName: 'logged-run',
        });
        return new Promise((resolve) => {
          fail = () => resolve({ exitCode: 1, output: 'step "Build" failed' });
        });
      });

      await launch.execute('launch', { workflowPath: '/tmp/build.workflow.yml' }, undefined, undefined, test.execution);
      fail();

      await vi.waitFor(() =>
        expect(test.execution.client.notify).toHaveBeenCalledWith({
          body: expect.stringContaining('Workflow launch failed after it was reported started.'),
          level: 'warning',
        }),
      );
      expect(fs.readFileSync(path.join(runDir, 'engine.log'), 'utf8')).toBe(
        'error step "Build" failed: No configured model matched p/unknown.\n',
      );
      expect(telemetry.recordError).toHaveBeenCalledWith(
        'doom_workflow.engine_error',
        new Error('error step "Build" failed: No configured model matched p/unknown.'),
        {},
        { includeException: true },
      );
      expect(telemetry.recordError).toHaveBeenCalledWith(
        'doom_workflow.run_failed',
        expect.any(Error),
        { exit_code: 1 },
        { includeException: true },
      );
    } finally {
      await test.close?.();
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('refuses a workflow outside the session repository, whoever asks', async () => {
    const test = await fixture();
    try {
      const launch = test.tools.find(({ name }) => name === 'launch_workflow')!;
      const calls = embeddedFeature.run.mock.calls.length;
      const refused = await launch.execute(
        'launch',
        { workflowPath: '/etc/elsewhere.workflow.yml' },
        undefined,
        undefined,
        test.execution,
      );
      const handler = test.apis
        .find(({ basePath }) => basePath === 'workflow')!
        .start({ scope: 'session' } as DoomApiContext);
      const viaApi = await handler.fetch(
        new Request('http://doompi.local/launch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // A prompt-less launch of a workflow that needs its brief input.
          body: JSON.stringify({ workflowPath: '/tmp/blog.workflow.yml' }),
        }),
      );

      expect(refused).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining('outside this session') }],
      });
      expect(await viaApi.json()).toEqual({
        text: expect.stringContaining('Missing required input: brief'),
        isError: true,
      });
      expect(embeddedFeature.run).toHaveBeenCalledTimes(calls);
    } finally {
      await test.close?.();
    }
  });

  it('hands a dispatcher launch to its root session, which runs and keeps it', async () => {
    const requestApi = vi.fn(async (_mount: unknown, _basePath: string, _request: Request) =>
      Response.json({ text: 'Started build.\nRun key: root-run' }),
    );
    const test = await fixture({
      environment: { PI_SUBAGENT_CHILD_AGENT: 'agiflow-dispatcher', PI_SUBAGENT_PARENT_SESSION: 'root-session' },
      requestApi,
    });
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
      // A dispatcher never works a run itself, as a CLI dispatcher child cannot.
      expect(test.registerToolRestriction).toHaveBeenCalledWith(
        expect.objectContaining({ excludedTools: ['workflow_run', 'workflow_tools'] }),
      );

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
      workflowWatcher.records = [
        {
          piSessionId: 'workflow-headless-test',
          view: {
            runKey: 'handed-run',
            workspace: '/tmp',
            stage: 'running',
            startedAt: new Date().toISOString(),
            jobs: [],
          },
        },
      ];
      test.backgroundUpdate.mockClear();
      embeddedFeature.run.mockImplementationOnce((parameters) => {
        parameters?.onRegistered?.({
          runKey: 'handed-run',
          runId: 'handed-id',
          workspace: '/tmp',
          runDir: '/tmp/no-such-run-dir',
          displayName: 'build-handed',
        });
        return new Promise((resolve) => embeddedFeature.pendingRuns.push(() => resolve({ exitCode: 0, output: '' })));
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
      await vi.waitFor(() =>
        expect(test.backgroundProvider()?.listActiveWork()).toEqual([
          { id: '/tmp/handed-run', sessionId: 'workflow-headless-test' },
        ]),
      );
      expect(test.backgroundUpdate).toHaveBeenCalled();
      expect(embeddedFeature.run).toHaveBeenLastCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ PI_SESSION_ID: 'workflow-headless-test' }),
          skipLaunch: true,
        }),
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
      // A refusal names the workflow and says nothing ran, since the findings only name a job and a step.
      expect(test.execution.client.notify).toHaveBeenCalledWith({
        body: 'Workflow "broken" was not launched: it needs fixing.\nInvalid workflow',
        level: 'error',
      });
      expect(
        await launch.execute(
          'launch',
          { workflowPath: '/tmp/broken.workflow.yml' },
          undefined,
          undefined,
          test.execution,
        ),
      ).toMatchObject({
        content: [
          {
            type: 'text',
            text: 'Error: Workflow "broken.workflow.yml" was not launched: it needs fixing.\nInvalid workflow',
          },
        ],
        isError: true,
      });
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
      embeddedFeature.run.mockResolvedValueOnce({ exitCode: 1, output: '\u001b[31mengine failed\u001b[0m' });
      await command.execute('build', test.execution);
      expect(test.execution.client.notify).toHaveBeenLastCalledWith({
        body: expect.stringContaining('Workflow failed (exit code 1):\n\nengine failed'),
        level: 'error',
      });
    } finally {
      await test.close?.();
    }
  });

  it('republishes run state on job and step transitions, which only the progress log records', async () => {
    const test = await fixture();
    try {
      // With the mode off and nothing running, a refresh retires the monitor, as it should.
      await test.modes[0]!.handleAction('activate', {}, operation(test.execution));
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

  it('keeps monitor cleanup when its refresh coalesces into a launcher publication', async () => {
    const test = await fixture();
    try {
      workflowWatcher.records = [];
      await test.activities[0]!.start(test.execution);
      const disposalCount = embeddedFeature.control.dispose.mock.calls.length;
      test.backgroundUpdate.mockClear();
      await test.commands[0]!.execute('build', test.execution);
      await test.modes[0]!.handleAction('deactivate', {}, operation(test.execution));
      embeddedFeature.emit('runFinished');
      await vi.waitFor(() => expect(embeddedFeature.control.dispose).toHaveBeenCalledTimes(disposalCount + 1));
      expect(test.backgroundUpdate).toHaveBeenCalledOnce();
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

describe('server recovery lifecycle', () => {
  it('acknowledges its hosting session, reports late failure, and stops registration after closing and the ack deadline', async () => {
    let registered = false;
    let finish!: (result: { content: { type: 'text'; text: string }[]; isError?: boolean }) => void;
    const execution = new Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>((resolve) => {
      finish = resolve;
    });
    const registry = {
      readRunByKey: vi.fn(async () =>
        registered
          ? {
              workspace: '/tmp',
              runKey: 'broken',
              runId: 'replay-id',
              displayName: 'Broken',
              env: { PI_SESSION_ID: 'hosting' },
            }
          : undefined,
      ),
      requestStop: vi.fn(async () => undefined),
    };
    const execute = vi.fn(() => execution);
    const createRecoverTool = vi.fn((_options: { ownerSessionId: () => string }) => ({ execute }));
    const notify = vi.fn();
    const launcher = createServerLauncher({
      feature: { registry },
      createRecoverTool,
      sessionId: 'hosting',
      environment: { PI_SESSION_ID: 'root' },
      notify,
      launchAckPollMs: 1,
      launchAckTimeoutMs: 2,
      stopTimeoutMs: 1,
    } as unknown as ServerLaunchDependencies);
    const result = await launcher.recover({ workspace: '/tmp', runKey: 'broken' }, {});
    expect(JSON.stringify(result)).toContain('not running yet');
    expect(createRecoverTool.mock.calls[0]![0].ownerSessionId()).toBe('hosting');
    expect(execute).toHaveBeenCalledWith({ workspace: '/tmp', runKey: 'broken' });
    await launcher.dispose();
    registered = true;
    await vi.waitFor(() =>
      expect(registry.requestStop).toHaveBeenCalledWith('/tmp', 'broken', expect.any(String), 'replay-id'),
    );
    finish({ content: [{ type: 'text', text: 'late failure' }], isError: true });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining('late failure'), 'warning'));
    expect(await launcher.recover({ workspace: '/tmp', runKey: 'broken' }, {})).toMatchObject({ isError: true });
  });

  it('acknowledges registration and does not stop a foreign recovery owner', async () => {
    let finish!: (result: { content: { type: 'text'; text: string }[] }) => void;
    const execution = new Promise<{ content: { type: 'text'; text: string }[] }>((resolve) => {
      finish = resolve;
    });
    let owner = 'hosting';
    const registry = {
      readRunByKey: vi.fn(async () => ({
        workspace: '/tmp',
        runKey: 'broken',
        runId: 'replay-id',
        displayName: 'Broken',
        env: { PI_SESSION_ID: owner },
      })),
      requestStop: vi.fn(async () => undefined),
    };
    const launcher = createServerLauncher({
      feature: { registry },
      createRecoverTool: () => ({ execute: () => execution }),
      sessionId: 'hosting',
      environment: {},
      notify: vi.fn(),
      launchAckPollMs: 1,
      launchAckTimeoutMs: 2,
      stopTimeoutMs: 1,
    } as unknown as ServerLaunchDependencies);
    expect(JSON.stringify(await launcher.recover({ workspace: '/tmp', runKey: 'broken' }, {}))).toContain(
      'Run key: broken',
    );
    owner = 'foreign';
    await launcher.dispose();
    expect(registry.requestStop).not.toHaveBeenCalled();
    finish({ content: [{ type: 'text', text: 'done' }] });
  });
});

describe('workflow sessions', () => {
  const owned = (sessionId: string, stage: string, extra: Record<string, unknown> = {}) => ({
    piSessionId: sessionId,
    launcherSessionId: 'workflow-headless-test',
    view: {
      runKey: `${sessionId}-run`,
      workspace: '/tmp',
      stage,
      displayName: 'build',
      startedAt: new Date().toISOString(),
      jobs: [],
      ownerSessionId: sessionId,
      launcherSessionId: 'workflow-headless-test',
      ...extra,
    },
  });

  function sessionService() {
    return {
      create: vi.fn(async () => ({ sessionId: 'workflow-child', cwd: '/tmp' })),
      close: vi.fn(async () => undefined),
      isLive: vi.fn(() => true),
      release: vi.fn(async () => undefined),
    };
  }

  function communication() {
    const listeners = new Map<string, (source: string, payload: unknown) => void>();
    return {
      listeners,
      endpoint: {
        sessionId: 'workflow-headless-test',
        publish: vi.fn(() => true),
        subscribe: vi.fn((type: string, listener: (source: string, payload: unknown) => void) => {
          listeners.set(type, listener);
          return () => listeners.delete(type);
        }),
        onPeerReady: vi.fn(() => () => undefined),
        close: vi.fn(),
      },
    };
  }

  it('creates a workflow session under this one and hands it the launch with the launcher stamp', async () => {
    const service = sessionService();
    const requestApi = vi.fn(async () => Response.json({ text: 'Run key: build-1' }));
    const test = await fixture({ sessionService: service as never, requestApi });
    try {
      await test.modes[0]!.handleAction('activate', {}, operation(test.execution));
      const launch = test.tools.find(({ name }) => name === 'launch_workflow')!;
      const result = await launch.execute(
        'launch',
        { workflowPath: '/tmp/build.workflow.yml' },
        undefined,
        undefined,
        test.execution,
      );

      expect(service.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'build',
          parentSessionId: 'workflow-headless-test',
          sessionProvenance: 'workflow-session',
          selection: { minorModes: ['workflow'] },
        }),
      );
      expect((service.create.mock.calls as unknown as [Record<string, unknown>][])[0]![0]).not.toHaveProperty(
        'environment',
      );
      const [mount, , request] = requestApi.mock.calls[0]! as unknown as [unknown, string, Request];
      expect(mount).toEqual({ scope: 'session', sessionId: 'workflow-child' });
      expect(await request.json()).toMatchObject({
        workflowPath: '/tmp/build.workflow.yml',
        env: { DOOMPI_WORKFLOW_LAUNCHER_SESSION_ID: 'workflow-headless-test' },
      });
      expect(embeddedFeature.run).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).toContain('Runs in workflow session \\"build\\" (workflow-child)');
    } finally {
      await test.close?.();
    }
  });

  it('creates nothing for a refused launch and closes a workflow session whose hand-off failed', async () => {
    const service = sessionService();
    const requestApi = vi.fn(async () => Response.json({ error: 'Session not found.' }, { status: 404 }));
    const test = await fixture({ sessionService: service as never, requestApi });
    try {
      await test.modes[0]!.handleAction('activate', {}, operation(test.execution));
      const launch = test.tools.find(({ name }) => name === 'launch_workflow')!;
      const outside = await launch.execute(
        'launch',
        { workflowPath: '/elsewhere/build.workflow.yml' },
        undefined,
        undefined,
        test.execution,
      );
      expect(outside).toMatchObject({ isError: true });
      expect(service.create).not.toHaveBeenCalled();

      const failed = await launch.execute(
        'launch',
        { workflowPath: '/tmp/build.workflow.yml' },
        undefined,
        undefined,
        test.execution,
      );
      expect(failed).toMatchObject({ isError: true });
      expect(service.close).toHaveBeenCalledWith('workflow-child');
    } finally {
      await test.close?.();
    }
  });

  it('refuses a launch past the ceiling before it creates a session', async () => {
    const service = sessionService();
    const test = await fixture({
      sessionService: service as never,
      requestApi: vi.fn(),
      environment: { WORKFLOW_MCP_MAX_CONCURRENT: '1' },
    });
    try {
      workflowWatcher.records = [owned('other-child', 'running')];
      await test.modes[0]!.handleAction('activate', {}, operation(test.execution));
      const launch = test.tools.find(({ name }) => name === 'launch_workflow')!;
      const result = await launch.execute(
        'launch',
        { workflowPath: '/tmp/build.workflow.yml' },
        undefined,
        undefined,
        test.execution,
      );
      expect(JSON.stringify(result)).toContain('at capacity: 1/1');
      expect(service.create).not.toHaveBeenCalled();
    } finally {
      await test.close?.();
    }
  });

  it('runs a launch in place inside a workflow session and re-selects workflow mode when it wakes', async () => {
    const service = sessionService();
    const test = await fixture({
      sessionService: service as never,
      requestApi: vi.fn(),
      sessionContext: {
        sessionId: 'workflow-headless-test',
        workspaceId: 'w',
        workspaceRoot: '/tmp',
        checkoutRoot: '/tmp',
        cwd: '/tmp',
        parentSessionId: 'parent',
        provenance: 'workflow-session',
      },
    });
    try {
      const start = test.hooks.find(({ event }) => event === 'session_start')!;
      await (start.handle as (event: unknown, context: unknown) => Promise<void>)({}, test.execution);
      expect(test.execution.selection.state?.['minor-mode']).toContain('workflow');

      const launch = test.tools.find(({ name }) => name === 'launch_workflow')!;
      await launch.execute('launch', { workflowPath: '/tmp/build.workflow.yml' }, undefined, undefined, test.execution);
      expect(service.create).not.toHaveBeenCalled();
      expect(embeddedFeature.run).toHaveBeenCalled();

      workflowWatcher.records = [owned('workflow-headless-test', 'error', { failedJob: 'test' })];
      const brief = test.resources.find(({ name }) => name === 'workflow-session')!;
      expect(await brief.read(test.execution)).toContain('owner agent of this workflow session');
    } finally {
      await test.close?.();
    }
  });

  it('releases a workflow session only when every run it owns succeeded and one was launched here', async () => {
    const service = sessionService();
    const channel = communication();
    const test = await fixture({ sessionService: service as never, sessionCommunication: channel.endpoint });
    try {
      expect(channel.endpoint.onPeerReady).toHaveBeenCalled();
      const release = channel.listeners.get('doompi-workflow.session-release')!;

      workflowWatcher.records = [owned('workflow-child', 'error')];
      release('workflow-child', {});
      await vi.waitFor(() => expect(telemetry.recordEvent).toBeDefined());
      expect(service.release).not.toHaveBeenCalled();

      workflowWatcher.records = [owned('workflow-child', 'completed', { outcome: 'success' })];
      release('workflow-child', {});
      await vi.waitFor(() => expect(service.release).toHaveBeenCalledWith('workflow-child'));
    } finally {
      await test.close?.();
    }
  });

  it('lets the launcher read a handed-off run but not control or recover it while its owner is live', async () => {
    const service = sessionService();
    const test = await fixture({ sessionService: service as never });
    try {
      await test.modes[0]!.handleAction('activate', {}, operation(test.execution));
      workflowWatcher.records = [owned('workflow-child', 'running')];
      const run = test.tools.find(({ name }) => name === 'workflow_run')!;
      const status = await run.execute(
        'status',
        { action: 'status', runKey: 'workflow-child-run' },
        undefined,
        undefined,
        test.execution,
      );
      expect(JSON.stringify(status)).toContain('workflow-child-run');
      const stop = await run.execute(
        'stop',
        { action: 'stop', runKey: 'workflow-child-run', expectedRunId: 'id' },
        undefined,
        undefined,
        test.execution,
      );
      expect(JSON.stringify(stop)).toContain('belongs to workflow session workflow-child');

      embeddedFeature.registry.listRuns.mockResolvedValueOnce([
        {
          runKey: 'broken',
          workspace: '/tmp',
          stage: 'error',
          displayName: 'Broken',
          env: { PI_SESSION_ID: 'workflow-child' },
        },
      ]);
      const tools = test.tools.find(({ name }) => name === 'workflow_tools')!;
      const recovered = await tools.execute(
        'recover',
        { action: 'recover', runKey: 'broken' },
        undefined,
        undefined,
        test.execution,
      );
      expect(JSON.stringify(recovered)).toContain('belongs to live workflow session workflow-child');
      expect(embeddedFeature.recover).not.toHaveBeenCalled();
    } finally {
      await test.close?.();
    }
  });
});
