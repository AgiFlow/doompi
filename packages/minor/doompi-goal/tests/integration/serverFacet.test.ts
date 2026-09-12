import type { Context } from '@deepseek-ai/cordis';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessCommand,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHook,
  type DoomHeadlessHostService,
  type DoomHeadlessMinorMode,
  type DoomHeadlessResource,
  type DoomHeadlessSelection,
  type DoomHeadlessTool,
} from '@agimon-ai/doompi-extension-contracts/headless';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerHostService,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import { describe, expect, it, vi } from 'vitest';
import { goalServerFacet } from '../../src/extensions/server';

async function fixture() {
  let selection: DoomHeadlessSelection = {
    majorMode: 'copilot',
    activeLayers: [],
    domains: [],
    minorModes: [],
  };
  const appendedEntries: unknown[][] = [];
  const commands: DoomHeadlessCommand[] = [];
  const hooks: DoomHeadlessHook[] = [];
  const resources: DoomHeadlessResource[] = [];
  const tools: DoomHeadlessTool[] = [];
  let mode!: DoomHeadlessMinorMode;
  const publish = vi.fn();
  const dispose = vi.fn();
  const registration = () => ({ dispose: vi.fn() });
  const execution = {
    cwd: process.cwd(),
    repoRoot: process.cwd(),
    sessionId: 'goal-headless-test',
    get selection() {
      return selection;
    },
    client: {
      notify: vi.fn(),
      request: vi.fn(),
      setStatus: vi.fn(),
    },
    session: {
      entries: async () => [],
      appendCustomEntry: async (...entry: unknown[]) => {
        appendedEntries.push(entry);
      },
      prompt: vi.fn(),
      abort: vi.fn(),
      compact: vi.fn(),
      activity: vi.fn(),
    },
    shutdown: vi.fn(),
  } as unknown as DoomHeadlessExecutionContext;
  const host = {
    context: execution,
    changeSelection: async (change: { axis: 'minorModes'; minorModes: string[] }) => {
      selection = { ...selection, minorModes: change.minorModes };
    },
    registerMinorMode: (value: DoomHeadlessMinorMode) => {
      mode = value;
      return { publish, dispose };
    },
    registerToolRestriction: registration,
    registerResource: (value: DoomHeadlessResource) => {
      resources.push(value);
      return registration();
    },
    registerTool: (value: DoomHeadlessTool) => {
      tools.push(value);
      return registration();
    },
    registerCommand: (value: DoomHeadlessCommand) => {
      commands.push(value);
      return registration();
    },
    registerHook: (value: DoomHeadlessHook) => {
      hooks.push(value);
      return registration();
    },
  } as unknown as DoomHeadlessHostService;
  const serverHost = { scope: 'session' } as DoomServerHostService;
  const close = await goalServerFacet.apply({
    effect() {},
    get: (service: string) =>
      service === DOOM_SERVER_HOST_SERVICE ? serverHost : service === DOOM_HEADLESS_HOST_SERVICE ? host : undefined,
  } as unknown as Context);
  return {
    execution,
    selection: () => selection,
    appendedEntries,
    commands,
    hooks,
    resources,
    tools,
    mode,
    publish,
    dispose,
    close,
  };
}

describe('goal server facet', () => {
  it('starts a goal through the command and adds it to the agent-start prompt', async () => {
    const test = await fixture();
    const command = test.commands.find(({ name }) => name === 'goal');
    const hook = test.hooks.find(({ event }) => event === 'before_agent_start') as
      | DoomHeadlessHook<'before_agent_start'>
      | undefined;
    const startHook = test.hooks.find(({ event }) => event === 'session_start') as
      | DoomHeadlessHook<'session_start'>
      | undefined;
    const shutdownHook = test.hooks.find(({ event }) => event === 'session_shutdown') as
      | DoomHeadlessHook<'session_shutdown'>
      | undefined;
    const resource = test.resources[0];
    if (!command || !hook || !startHook || !shutdownHook || !resource)
      throw new Error('Goal command, hooks, or resource were not registered');

    await expect(startHook.handle({}, test.execution)).resolves.toBeUndefined();
    await command.execute('Ship the feature', test.execution);

    expect(test.selection().minorModes).toEqual(['goal']);
    expect(test.appendedEntries).toHaveLength(1);
    expect(test.appendedEntries[0]).toEqual([
      'goal-state',
      { goal: expect.objectContaining({ status: 'active', text: 'Ship the feature' }) },
    ]);
    expect(test.execution.client.notify).toHaveBeenCalledWith({ body: 'Goal started.', level: 'info' });
    expect(hook.handle({ systemPrompt: 'Base prompt' }, test.execution)).toMatchObject({
      systemPrompt: expect.stringContaining('[GOAL ACTIVE]\nShip the feature'),
    });
    expect(await resource.read(test.execution)).toContain('goal');
    await command.execute('status', test.execution);
    await command.execute('pause', test.execution);
    await command.execute('resume', test.execution);
    await command.execute('pause unexpectedly', test.execution);
    expect(test.execution.client.notify).toHaveBeenCalledWith({ body: 'Goal paused.', level: 'info' });
    expect(test.execution.client.notify).toHaveBeenCalledWith({ body: 'Goal resumed.', level: 'info' });
    expect(test.execution.client.notify).toHaveBeenCalledWith({ body: 'Usage: /goal pause', level: 'error' });

    await shutdownHook.handle({}, test.execution);
    const state = test.appendedEntries.at(-1)?.[1] as { goal: { id: string } };
    const complete = test.tools.find(({ name }) => name === 'goal_complete');
    if (!complete) throw new Error('Goal completion tool was not registered');
    const result = await complete.execute(
      'call-1',
      { goal_id: state.goal.id, summary: 'Feature shipped.' } as never,
      undefined,
      undefined,
      test.execution,
    );
    expect(result).toMatchObject({ details: { completed: true } });
    expect(test.selection().minorModes).toEqual([]);

    await test.close?.();
    expect(test.dispose).toHaveBeenCalled();
  });
});
