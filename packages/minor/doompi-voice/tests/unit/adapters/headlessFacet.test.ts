import {
  DOOM_HEADLESS_OWNER as TEST_OWNER,
  DOOM_HEADLESS_HOST_SERVICE as TEST_AGENT,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE as TEST_SERVER, type DoomServerFacet } from '@agimon-ai/doompi-core/server-facet';
import { DOOM_MINOR_MODE_CATALOG_SERVICE as TEST_CATALOG } from '@agimon-ai/doompi-minor-mode';
import type { DoomHeadlessMinorMode } from '@agimon-ai/doompi-minor-mode';
import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/server-facet';
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
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import { voiceServerFacet } from '../../../src/extensions/server';

async function fixture(selectionModes: string[] = []) {
  let minorModes = selectionModes;
  const execution = {
    cwd: process.cwd(),
    repoRoot: process.cwd(),
    sessionId: 'voice-headless-test',
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
  const publish = vi.fn();
  const dispose = vi.fn();
  const registrations = { dispose: vi.fn() };
  const registerOwner = vi.fn((mode: DoomHeadlessMinorMode) => {
    modes.push(mode);
    return { publish, dispose };
  });
  const host = {
    context: execution,
    changeSelection: vi.fn(async ({ values: selected }: { values?: string[] }) => {
      if (selected) minorModes = selected;
    }),
    assertActive: vi.fn(),
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
  const context = new Context();
  context.provide(DOOM_HEADLESS_HOST_SERVICE, host);
  context.provide(DOOM_SERVER_HOST_SERVICE, {
    scope: 'session',
    context: {},
    registerApi: () => ({ dispose() {} }),
  } as unknown as DoomServerHostService);
  const close = await mountFacet(voiceServerFacet, context, host, registerOwner);
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
    const test = await fixture(['voice-auto']);
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

    await test.close?.();
    expect(test.dispose).toHaveBeenCalledOnce();
    expect(test.registrations.dispose).toHaveBeenCalled();
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
