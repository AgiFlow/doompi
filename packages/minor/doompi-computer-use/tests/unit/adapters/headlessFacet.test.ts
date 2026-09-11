import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessActivity,
  type DoomHeadlessCommand,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHook,
  type DoomHeadlessHostService,
  type DoomHeadlessMinorMode,
  type DoomHeadlessResource,
  type DoomHeadlessTool,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComputerUseSessionClient } from '../../../src/adapters/pi/sessionApiClient.ts';
import type { ComputerUseObservation } from '../../../src/types/computerUse.ts';
import type { ComputerUseSessionView } from '../../../src/types/computerUseApi.ts';
import { computerUseHeadlessFacet } from '../../../src/adapters/headless/facet.ts';

const clientState = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('../../../src/adapters/pi/sessionApiClient.ts', () => ({
  createComputerUseSessionClient: () => clientState.current,
}));

function contextFor(host: DoomHeadlessHostService): Context {
  return { get: (name: string) => (name === DOOM_HEADLESS_HOST_SERVICE ? host : undefined) } as unknown as Context;
}

function fixture(selectionModes: string[] = []) {
  let minorModes = selectionModes;
  const execution = {
    cwd: process.cwd(),
    repoRoot: process.cwd(),
    sessionId: 'computer-use-headless-test',
    get selection() {
      return { majorMode: 'copilot', activeLayers: [], domains: [], minorModes };
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
  const restrictions: unknown[] = [];
  const activities: DoomHeadlessActivity[] = [];
  const tools: DoomHeadlessTool[] = [];
  const resources: DoomHeadlessResource[] = [];
  const commands: DoomHeadlessCommand[] = [];
  const hooks: DoomHeadlessHook[] = [];
  const publish = vi.fn();
  const dispose = vi.fn();
  const registrations = { dispose: vi.fn() };
  const host = {
    context: execution,
    select: vi.fn(async ({ minorModes: selected }: { minorModes?: string[] }) => {
      if (selected) minorModes = selected;
    }),
    registerMinorMode: (mode: DoomHeadlessMinorMode) => {
      modes.push(mode);
      return { publish, dispose };
    },
    registerToolRestriction: (restriction: unknown) => {
      restrictions.push(restriction);
      return registrations;
    },
    registerActivity: (activity: DoomHeadlessActivity) => {
      activities.push(activity);
      return registrations;
    },
    registerTool: (tool: DoomHeadlessTool) => {
      tools.push(tool);
      return registrations;
    },
    registerResource: (resource: DoomHeadlessResource) => {
      resources.push(resource);
      return registrations;
    },
    registerCommand: (command: DoomHeadlessCommand) => {
      commands.push(command);
      return registrations;
    },
    registerHook: (hook: DoomHeadlessHook) => {
      hooks.push(hook);
      return registrations;
    },
  } as unknown as DoomHeadlessHostService;
  const close = computerUseHeadlessFacet.apply(contextFor(host));
  return {
    execution,
    modes,
    restrictions,
    activities,
    tools,
    resources,
    commands,
    hooks,
    publish,
    dispose,
    registrations,
    close,
  };
}

function operation(execution: DoomHeadlessExecutionContext) {
  return {
    context: execution,
    operationId: 'computer-use-test',
    sessionKind: 'headless' as const,
    signal: new AbortController().signal,
  };
}

const observation: ComputerUseObservation = {
  runId: 'run-1',
  snapshotId: 'snapshot-1',
  targetGeneration: 'target-1',
  applicationName: 'Test App',
  bundleId: 'test.app',
  windowTitle: 'Test Window',
  elements: [],
  screenshot: { data: 'image-data', mimeType: 'image/png' },
};

beforeEach(() => {
  clientState.current = undefined;
});

describe('computer use headless facet', () => {
  it('exposes the unavailable behavior without a desktop transport', async () => {
    const test = fixture();
    const mode = test.modes[0];
    const activity = test.activities[0];
    const stateTool = test.tools.find(({ name }) => name === 'computer_state');
    const actionTool = test.tools.find(({ name }) => name === 'computer_action');
    const execTool = test.tools.find(({ name }) => name === 'computer_exec');
    const command = test.commands[0];
    const beforeStart = test.hooks.find(({ event }) => event === 'before_agent_start') as
      | DoomHeadlessHook<'before_agent_start'>
      | undefined;
    const shutdown = test.hooks.find(({ event }) => event === 'session_shutdown') as
      | DoomHeadlessHook<'session_shutdown'>
      | undefined;
    if (!mode || !activity || !stateTool || !actionTool || !execTool || !command || !beforeStart || !shutdown)
      throw new Error('Computer-use headless registrations were not created');

    expect(mode.initialState).toMatchObject({ activation: 'inactive', condition: 'ready' });
    await expect(mode.handleAction('activate', {}, operation(test.execution))).rejects.toThrow(
      'DoomPi Desktop computer use is unavailable.',
    );
    await expect(mode.handleAction('doctor', {}, operation(test.execution))).resolves.toEqual({
      message: 'DoomPi Desktop session API is unavailable.',
    });
    await expect(mode.handleAction('deactivate', {}, operation(test.execution))).resolves.toEqual({
      message: 'Computer use deactivated.',
    });
    await expect(mode.handleAction('unknown', {}, operation(test.execution))).rejects.toThrow(
      'Unknown computer-use action: unknown',
    );
    const stopActivity = await activity.start(test.execution);
    await stopActivity();

    expect(await stateTool.execute('state', {}, undefined, undefined, test.execution)).toMatchObject({ isError: true });
    expect(await actionTool.execute('action', {}, undefined, undefined, test.execution)).toMatchObject({
      isError: true,
    });
    expect(
      await execTool.execute('exec', { scriptPath: 'missing.ts', input: {} }, undefined, undefined, test.execution),
    ).toMatchObject({
      isError: true,
    });
    await command.execute('status', test.execution);
    expect(test.execution.client.notify).toHaveBeenCalledWith({
      body: 'Computer use requires a DoomPi Desktop session.',
      level: 'error',
    });
    expect(beforeStart.handle({}, test.execution)).toBeUndefined();
    await shutdown.handle({}, test.execution);
    expect(test.execution.client.setStatus).toHaveBeenCalledWith('@agimon-ai/doompi-computer-use', undefined);
    test.close?.();
    expect(test.dispose).toHaveBeenCalledOnce();
    expect(test.registrations.dispose).toHaveBeenCalled();
  });

  it('runs the desktop-backed state, action, command, activity, and lifecycle paths', async () => {
    const state = { phase: 'active' as 'active' | 'inactive' };
    const client: ComputerUseSessionClient = {
      state: vi.fn(async (): Promise<ComputerUseSessionView> => ({
        sessionId: 'session-1',
        revision: 1,
        wake: 0,
        phase: state.phase,
      })),
      observe: vi.fn(async () => observation),
      act: vi.fn(async () => ({ accepted: true })),
      stop: vi.fn(async (): Promise<ComputerUseSessionView> => {
        state.phase = 'inactive';
        return { sessionId: 'session-1', revision: 2, wake: 0, phase: 'inactive' };
      }),
    };
    clientState.current = client;
    const test = fixture();
    const mode = test.modes[0];
    const activity = test.activities[0];
    const stateTool = test.tools.find(({ name }) => name === 'computer_state');
    const actionTool = test.tools.find(({ name }) => name === 'computer_action');
    const execTool = test.tools.find(({ name }) => name === 'computer_exec');
    const command = test.commands[0];
    const beforeStart = test.hooks.find(({ event }) => event === 'before_agent_start') as
      | DoomHeadlessHook<'before_agent_start'>
      | undefined;
    const shutdown = test.hooks.find(({ event }) => event === 'session_shutdown') as
      | DoomHeadlessHook<'session_shutdown'>
      | undefined;
    if (!mode || !activity || !stateTool || !actionTool || !execTool || !command || !beforeStart || !shutdown)
      throw new Error('Computer-use headless registrations were not created');

    await expect(mode.handleAction('activate', {}, operation(test.execution))).resolves.toEqual({
      message: 'Computer use activated.',
    });
    expect(test.execution.selection.minorModes).toContain('computer-use');
    expect(test.publish).toHaveBeenCalled();
    expect(test.execution.client.setStatus).toHaveBeenCalledWith(
      '@agimon-ai/doompi-computer-use',
      'computer use: active',
    );
    expect(await mode.handleAction('doctor', {}, operation(test.execution))).toEqual({
      message: 'Computer use is active.',
    });
    expect(await stateTool.execute('state', {}, undefined, undefined, test.execution)).toMatchObject({
      details: observation,
      content: [{ type: 'text' }, { type: 'image', data: 'image-data', mimeType: 'image/png' }],
    });
    expect(
      await actionTool.execute(
        'action',
        { kind: 'press', snapshotId: 'snapshot-1', elementRef: 'button' },
        undefined,
        undefined,
        test.execution,
      ),
    ).toEqual(expect.objectContaining({ details: { accepted: true } }));
    expect(
      await execTool.execute('exec', { scriptPath: 'missing.ts', input: {} }, undefined, undefined, test.execution),
    ).toMatchObject({
      isError: true,
    });
    const stopActivity = await activity.start(test.execution);
    await stopActivity();
    await command.execute('deactivate', test.execution);
    expect(client.stop).toHaveBeenCalled();
    expect(test.execution.selection.minorModes).not.toContain('computer-use');
    state.phase = 'active';
    await mode.handleAction('doctor', {}, operation(test.execution));
    expect(beforeStart.handle({ systemPrompt: 'Base prompt' }, test.execution)).toMatchObject({
      systemPrompt: expect.stringContaining('[COMPUTER USE ACTIVE]'),
    });
    await shutdown.handle({}, test.execution);
    expect(client.stop).toHaveBeenCalledTimes(2);
    test.close?.();
    expect(test.dispose).toHaveBeenCalledOnce();
  });
});
