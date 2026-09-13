import {
  DOOM_HEADLESS_OWNER as TEST_OWNER,
  DOOM_HEADLESS_HOST_SERVICE as TEST_AGENT,
} from '@agimon-ai/doompi-core/headless';
import type {
  DoomHeadlessActivity,
  DoomHeadlessCommand,
  DoomHeadlessExecutionContext,
  DoomHeadlessHook,
  DoomHeadlessHostService,
  DoomHeadlessResource,
  DoomHeadlessSelection,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_HEADLESS_HOST_SERVICE } from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE as TEST_SERVER, type DoomServerFacet } from '@agimon-ai/doompi-core/server-facet';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-core/server-facet';
import { DOOM_MINOR_MODE_CATALOG_SERVICE as TEST_CATALOG } from '@agimon-ai/doompi-minor-mode';
import type { DoomHeadlessMinorMode } from '@agimon-ai/doompi-minor-mode';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';

import { loopServerFacet } from '../../src/extensions/server';

async function fixture() {
  let selection: DoomHeadlessSelection = {
    majorMode: 'copilot',
    activeLayers: [],
    domains: [],
    state: {},
  };
  const commands: DoomHeadlessCommand[] = [];
  const hooks: DoomHeadlessHook[] = [];
  const resources: DoomHeadlessResource[] = [];
  let activity!: DoomHeadlessActivity;
  let mode!: DoomHeadlessMinorMode;
  const registration = () => ({ dispose: vi.fn() });
  const execution = {
    cwd: process.cwd(),
    repoRoot: process.cwd(),
    sessionId: 'loop-headless-test',
    get selection() {
      return selection;
    },
    client: {
      notify: vi.fn(),
      request: vi.fn(async (request: { title: string }) => {
        if (request.title === 'Loop prompt') return 'Check status';
        if (request.title === 'Choose a loop launcher') return 'doompi.default';
        return '30';
      }),
      setStatus: vi.fn(),
    },
    session: {
      entries: () => [],
      appendCustomEntry: vi.fn(),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(),
      compact: vi.fn(),
      activity: vi.fn(),
    },
    shutdown: vi.fn(),
  } as unknown as DoomHeadlessExecutionContext;
  const registerOwner = vi.fn((value: DoomHeadlessMinorMode) => {
    mode = value;
    return { publish: vi.fn(), dispose: vi.fn() };
  });
  const host = {
    context: execution,
    changeSelection: async (change: { axis: 'state'; key: string; values: string[] }) => {
      selection = { ...selection, state: { ...selection.state, [change.key]: change.values } };
    },
    assertActive: vi.fn(),
    registerResource: (value: DoomHeadlessResource) => {
      resources.push(value);
      return registration();
    },
    registerActivity: (value: DoomHeadlessActivity) => {
      activity = value;
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
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, { scope: 'session', context: {} });
  context.provide(DOOM_HEADLESS_HOST_SERVICE, host);
  const close = await mountFacet(loopServerFacet, context, host, registerOwner);
  return { execution, selection: () => selection, commands, hooks, resources, activity, mode, close };
}

describe('loop headless facet', () => {
  it('starts the default loop through its activity and lists the active instance', async () => {
    const test = await fixture();
    const start = test.commands.find(({ name }) => name === 'loop');
    const list = test.commands.find(({ name }) => name === 'loops');
    const shutdown = test.hooks.find(({ event }) => event === 'session_shutdown') as
      | DoomHeadlessHook<'session_shutdown'>
      | undefined;
    const resource = test.resources[0];
    if (!start || !list || !shutdown || !resource) throw new Error('Loop registrations were not created');

    expect(await resource.read(test.execution)).toContain('loop');
    const stopActivity = await test.activity.start(test.execution);
    await start.execute('', test.execution);

    expect(test.execution.client.request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'select', title: 'Choose a loop launcher' }),
    );
    expect(test.execution.session.prompt).toHaveBeenCalledWith('Check status');
    expect(test.execution.client.notify).toHaveBeenCalledWith({
      body: expect.stringMatching(/^Loop '.+' started\.$/),
      level: 'info',
    });

    await list.execute('', test.execution);
    expect(test.execution.client.notify).toHaveBeenLastCalledWith({
      body: expect.stringContaining('instanceId'),
      level: 'info',
    });

    const listing = vi.mocked(test.execution.client.notify).mock.calls.at(-1)?.[0] as { body: string };
    const instanceId = (JSON.parse(listing.body) as Array<{ instanceId: string }>)[0]?.instanceId;
    if (!instanceId) throw new Error('Loop listing did not include an instance');
    await test.mode.handleAction(
      'stop',
      { instanceId, reason: 'Test cleanup' },
      {
        context: test.execution,
        operationId: 'stop-loop',
        sessionKind: 'headless',
        signal: new AbortController().signal,
      },
    );
    await shutdown.handle({}, test.execution);
    await list.execute('', test.execution);
    expect(test.execution.client.notify).toHaveBeenLastCalledWith({ body: 'No loops are active.', level: 'info' });

    await stopActivity();
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
  root.provide(TEST_CATALOG, { registerOwner } as never);
  const owner = root.extend({ [TEST_OWNER]: { packageName: '@fixture/mode' } });
  const release = await facet.apply(owner);
  await vi.waitFor(() => expect(registerOwner).toHaveBeenCalled());
  return async () => {
    await release?.();
    await root.fiber.dispose();
  };
}
