import {
  DOOM_HEADLESS_OWNER as TEST_OWNER,
  DOOM_HEADLESS_HOST_SERVICE as TEST_AGENT,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE as TEST_SERVER, type DoomServerFacet } from '@agimon-ai/doompi-core/server-facet';
import { DOOM_MINOR_MODE_CATALOG_SERVICE as TEST_CATALOG } from '@agimon-ai/doompi-minor-mode';
import type { DoomHeadlessMinorMode } from '@agimon-ai/doompi-minor-mode';
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
import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import { workflowServerFacet } from '../../../src/extensions/server';

const embeddedFeature = vi.hoisted(() => {
  const control = {
    start: vi.fn(async () => undefined),
    pause: vi.fn(async () => ({ ok: 'paused' })),
    resume: vi.fn(async () => ({ ok: 'resumed' })),
    stop: vi.fn(async () => ({ ok: 'stopped' })),
    dispose: vi.fn(),
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
      execute: vi.fn(async () => ({ content: [{ type: 'text', text: 'workflow launched' }] })),
    },
  };
  return { control, statuses, feature, getRecordFilter: () => recordFilter };
});

vi.mock('@agimon-ai/workflow-mcp', () => ({
  createEmbeddedWorkflowFeature: () => embeddedFeature.feature,
}));
vi.mock('zod', () => ({ z: { toJSONSchema: vi.fn(() => ({ type: 'object' })) } }));

async function fixture() {
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
    registerToolRestriction: () => registration,
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
    registerApi: () => ({ dispose() {} }),
    context: { directEvents: { publish: vi.fn() } },
  } as unknown as DoomServerHostService;
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, serverHost);
  context.provide(DOOM_HEADLESS_HOST_SERVICE, host);
  const close = await mountFacet(workflowServerFacet, context, host, registerOwner);
  return { execution, modes, activities, tools, resources, commands, hooks, publish, modeDispose, registration, close };
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
    expect(embeddedFeature.getRecordFilter()?.({})).toBe(true);
    expect(embeddedFeature.getRecordFilter()?.({ env: { PI_SESSION_ID: 'other' } })).toBe(false);
    expect(embeddedFeature.getRecordFilter()?.({ env: { PI_SESSION_ID: 'workflow-headless-test' } })).toBe(true);
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
      content: [{ type: 'text', text: '[]' }],
      details: [],
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
      workflowPath: 'build',
      runner: 'local',
      inputs: { environment: 'prod' },
      prompt: 'Deploy now',
    });
    expect(test.execution.client.notify).toHaveBeenLastCalledWith({ body: 'workflow launched', level: 'info' });

    await shutdown.handle({}, test.execution);
    expect(embeddedFeature.control.dispose).toHaveBeenCalledOnce();
    await stopActivity();
    await test.close?.();
    expect(test.modeDispose).toHaveBeenCalledOnce();
    expect(test.registration.dispose).toHaveBeenCalled();
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
  root.provide(TEST_CATALOG, { registerOwner } as never);
  const owner = root.extend({ [TEST_OWNER]: { packageName: '@fixture/mode' } });
  const release = await facet.apply(owner);
  await vi.waitFor(() => expect(registerOwner).toHaveBeenCalled());
  return async () => {
    await release?.();
    await root.fiber.dispose();
  };
}
