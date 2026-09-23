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
import { DOOM_SERVER_HOST_SERVICE as TEST_SERVER, type DoomServerFacet } from '@agimon-ai/doompi-core/serverFacet';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-core/serverFacet';
import { DOOM_MINOR_MODE_CATALOG_SERVICE as TEST_CATALOG } from '@agimon-ai/doompi-minor-mode';
import type { DoomHeadlessMinorMode } from '@agimon-ai/doompi-minor-mode';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';

import { facet as loopServerFacet } from '../../generated/server';
import { LOOP_VIEW_STATUS_KEY, parseLoopStatusView } from '../../src/types/loopView';

async function fixture(autoStart = false) {
  let stopStartedActivity: (() => void | Promise<void>) | undefined;
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
      if (autoStart && !stopStartedActivity && change.values.includes('loop.active'))
        stopStartedActivity = await activity.start(execution);
    },
    assertActive: vi.fn(),
    subscribeSelection: vi.fn(() => () => undefined),
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
  return {
    execution,
    selection: () => selection,
    commands,
    hooks,
    resources,
    activity,
    mode,
    close: async () => {
      await stopStartedActivity?.();
      await close?.();
    },
  };
}

describe('loop headless facet', () => {
  it('launches the default loop while inactive without prompting for a launcher', async () => {
    const test = await fixture(true);
    try {
      await test.commands.find((command) => command.name === 'loop')!.execute('doompi.default', test.execution);
      expect(test.selection().state?.['minor-mode']).toContain('loop.active');
      expect(test.execution.session.prompt).toHaveBeenCalledWith('Check status');
      expect(test.execution.client.request).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Choose a loop launcher' }),
      );
    } finally {
      await test.close();
    }
  });
  it('starts the default loop through its activity and lists the active instance', async () => {
    const test = await fixture();
    const start = test.commands.find(({ name }) => name === 'loop');
    const list = test.commands.find(({ name }) => name === 'loops');
    const shutdown = test.hooks.find(({ event }) => event === 'session_shutdown') as
      | DoomHeadlessHook<'session_shutdown'>
      | undefined;
    const resource = test.resources[0];
    if (!start || !list || !shutdown || !resource) throw new Error('Loop registrations were not created');

    expect(start.when).toBeUndefined();
    expect(list.when).toBeUndefined();
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

  it('publishes the instance list the activity dock reads, and a launcher row before loop mode is on', async () => {
    // A cockpit drives this facet and never the Pi runtime, so this is the only
    // thing that can fill the dock's loops group.
    const test = await fixture();
    const start = test.commands.find(({ name }) => name === 'loop');
    const startHook = test.hooks.find(({ event }) => event === 'session_start') as
      | DoomHeadlessHook<'session_start'>
      | undefined;
    if (!start || !startHook) throw new Error('Loop command or session_start hook was not registered');

    // Ungated: the group is a way in, so it exists before loop mode is selected.
    expect(startHook.when).toBeUndefined();
    await startHook.handle({}, test.execution);
    expect(lastLoopView(test.execution.client)).toBeUndefined();

    const stopActivity = await test.activity.start(test.execution);
    await start.execute('', test.execution);
    expect(parseLoopStatusView(lastLoopView(test.execution.client))).toHaveLength(1);

    await stopActivity();
    expect(lastLoopView(test.execution.client)).toBeUndefined();
    await test.close?.();
  });
});

/** The last instance list this facet published for the activity dock. */
function lastLoopView(client: DoomHeadlessExecutionContext['client']): string | undefined {
  const calls = vi.mocked(client.setStatus).mock.calls.filter(([key]) => key === LOOP_VIEW_STATUS_KEY);
  if (calls.length === 0) throw new Error(`The facet never published ${LOOP_VIEW_STATUS_KEY}`);
  return calls[calls.length - 1]?.[1];
}

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
