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
import { describe, expect, it, vi } from 'vitest';
import { voiceHeadlessFacet } from '../../../src/adapters/headless/facet.ts';

function fixture(selectionModes: string[] = []) {
  let minorModes = selectionModes;
  const execution = {
    cwd: process.cwd(),
    repoRoot: process.cwd(),
    sessionId: 'voice-headless-test',
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
    registerToolRestriction: () => registrations,
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
  const context = {
    get: (name: string) => (name === DOOM_HEADLESS_HOST_SERVICE ? host : undefined),
  } as unknown as Context;
  const close = voiceHeadlessFacet.apply(context);
  return { execution, modes, activities, tools, resources, commands, hooks, publish, dispose, registrations, close };
}

function operation(execution: DoomHeadlessExecutionContext) {
  return {
    context: execution,
    operationId: 'voice-headless-test',
    sessionKind: 'headless' as const,
    signal: new AbortController().signal,
  };
}

describe('voice headless facet', () => {
  it('reports the explicit no-media contract across mode, tools, commands, and activity', async () => {
    const test = fixture(['voice-auto']);
    const mode = test.modes[0];
    const activity = test.activities[0];
    const resource = test.resources[0];
    const voice = test.commands.find(({ name }) => name === 'voice');
    const voiceAuto = test.commands.find(({ name }) => name === 'voice-auto');
    const shutdown = test.hooks.find(({ event }) => event === 'session_shutdown') as
      | DoomHeadlessHook<'session_shutdown'>
      | undefined;
    if (!mode || !activity || !resource || !voice || !voiceAuto || !shutdown)
      throw new Error('Voice headless registrations were not created');

    expect(mode.initialState).toMatchObject({
      activation: 'active',
      condition: 'ready',
      detail: 'autonomous voice',
    });
    await expect(mode.handleAction('activate', {}, operation(test.execution))).rejects.toThrow(
      'Voice media requires an explicit client media transport.',
    );
    await expect(mode.handleAction('deactivate', {}, operation(test.execution))).resolves.toEqual({
      message: 'Voice mode deactivated.',
    });
    await expect(mode.handleAction('unknown', {}, operation(test.execution))).rejects.toThrow(
      'Unknown voice mode action: unknown',
    );
    await expect(Promise.resolve().then(() => activity.start(test.execution))).rejects.toThrow(
      'Voice media requires an explicit client media transport.',
    );
    expect(await resource.read(test.execution)).toContain('voice');

    for (const tool of test.tools) {
      const result = await tool.execute('voice-tool', {}, undefined, undefined, test.execution);
      expect(result).toMatchObject({ isError: true });
      expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Voice media') });
    }
    await voice.execute('', test.execution);
    await voiceAuto.execute('', test.execution);
    expect(test.execution.client.notify).toHaveBeenNthCalledWith(1, {
      body: 'Voice media requires an explicit client media transport. The current headless host exposes no capture, playback, or transcription transport.',
      level: 'error',
    });
    expect(test.execution.client.notify).toHaveBeenNthCalledWith(2, {
      body: 'Voice media requires an explicit client media transport. The current headless host exposes no capture, playback, or transcription transport.',
      level: 'error',
    });
    await shutdown.handle({}, test.execution);
    expect(test.execution.client.setStatus).toHaveBeenCalledWith('@agimon-ai/doompi-voice', undefined);

    test.close?.();
    expect(test.dispose).toHaveBeenCalledOnce();
    expect(test.registrations.dispose).toHaveBeenCalled();
  });
});
