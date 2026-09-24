import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DOOM_HEADLESS_HOST_SERVICE,
  DOOM_HEADLESS_OWNER,
  type DoomHeadlessHostService,
  type DoomHeadlessTool,
  type DoomHeadlessToolRestriction,
  type DoomHeadlessActivity,
  type DoomHeadlessCommand,
  type DoomHeadlessHook,
} from '@agimon-ai/doompi-core/headless';
import type { DoomDirectEventBus, DoomHubChannelHost } from '@agimon-ai/doompi-core/hubChannel';
import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-core/packageApi';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-core/serverFacet';
import { DOOM_MINOR_MODE_CATALOG_SERVICE, type DoomHeadlessMinorMode } from '@agimon-ai/doompi-minor-mode';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';

import { facet } from '../../../generated/server';
import { createComputerUseChannel } from '../../../src/services/webComputerUseChannel';

async function fixture(native = true, cwd = '/fixture') {
  const scope = { sessionId: 'session', cwd };
  let selected: string[] = [];
  let available = native;
  let owned = false;
  let enabled = true;
  let snapshot = 0;
  let handler: DoomApiHandler | undefined;
  const claimed = vi.fn();
  const listeners = new Set<() => void>();
  const events = new Map<string, Set<(value: unknown) => void>>();
  const directEvents: DoomDirectEventBus = {
    publish(type, id, value) {
      for (const listener of events.get(`${type}:${id}`) ?? []) listener(value);
    },
    subscribe(type, id, listener) {
      const key = `${type}:${id}`;
      const subscribers = events.get(key) ?? new Set();
      events.set(key, subscribers);
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    close() {
      events.clear();
    },
  };
  const apiContext: DoomApiContext = {
    scope: 'session',
    sessionId: scope.sessionId,
    cwd: scope.cwd,
    directEvents,
    internalToken: 'agent',
    hubToken: 'hub',
    onNotice: vi.fn(),
    ...(native
      ? {
          computerUse: {
            get available() {
              return available;
            },
            get enabled() {
              return enabled;
            },
            authorize: (headers: Headers) => available && headers.get('x-doompi-desktop') === 'native-proof',
            claim: claimed,
            subscribe: (listener: () => void) => {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          },
        }
      : {}),
  };
  const tools: DoomHeadlessTool[] = [];
  const restrictions: DoomHeadlessToolRestriction[] = [];
  const modes: DoomHeadlessMinorMode[] = [];
  const activities: DoomHeadlessActivity[] = [];
  const commands: DoomHeadlessCommand[] = [];
  const hooks: DoomHeadlessHook[] = [];
  const registrationDisposed = vi.fn();
  const activity = vi.fn(async () => ({ isIdle: true, hasPendingMessages: false }));
  const context = {
    ...scope,
    repoRoot: scope.cwd,
    environment: {},
    get selection() {
      return { majorMode: 'copilot', activeLayers: [], domains: [], state: { 'minor-mode': selected } };
    },
    client: { notify: vi.fn(), setStatus: vi.fn(), request: vi.fn() },
    session: { activity },
  } as unknown as DoomHeadlessHostService['context'];
  const registration = () => ({ dispose: registrationDisposed });
  const agent = {
    context,
    assertActive: vi.fn(),
    changeSelection: vi.fn(async ({ values }: { values: string[] }) => {
      selected = values;
    }),
    subscribeSelection: () => () => {},
    registerTool: (tool: DoomHeadlessTool) => {
      tools.push(tool);
      return registration();
    },
    registerToolRestriction: (restriction: DoomHeadlessToolRestriction) => {
      restrictions.push(restriction);
      return registration();
    },
    registerResource: registration,
    registerCommand: (command: DoomHeadlessCommand) => {
      commands.push(command);
      return registration();
    },
    registerHook: (hook: DoomHeadlessHook) => {
      hooks.push(hook);
      return registration();
    },
    registerActivity: (entry: DoomHeadlessActivity) => {
      activities.push(entry);
      return registration();
    },
  } as unknown as DoomHeadlessHostService;
  const root = new Context();
  root.provide(DOOM_HEADLESS_HOST_SERVICE, agent);
  root.provide(DOOM_SERVER_HOST_SERVICE, {
    scope: 'session',
    context: apiContext,
    registerApi(api: DoomApi) {
      handler = api.start(apiContext) as DoomApiHandler;
      return registration();
    },
    registerChannel: registration,
    registerMethod: registration,
    mounted: () => [],
    mountedChannels: () => [],
  } as never);
  root.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, {
    registerOwner(mode: DoomHeadlessMinorMode) {
      modes.push(mode);
      return { publish: vi.fn(), dispose: registrationDisposed };
    },
  } as never);
  const owner = root.extend({ [DOOM_HEADLESS_OWNER]: { packageName: '@agimon-ai/doompi-computer-use' } });
  const release = await facet.apply(owner);
  if (native) await vi.waitFor(() => expect(modes).toHaveLength(1));
  const request = async (pathname: string, body?: unknown, desktop = true, token?: string) => {
    if (!handler) throw new Error('No API mounted');
    return handler.fetch(
      new Request(`http://fixture${pathname}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(desktop ? { 'x-doompi-desktop': 'native-proof' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  };
  const nativeRequest = vi.fn(async (_scope, request) => {
    if (request.operation === 'status') return { ownedBySession: owned };
    if (request.operation === 'activate') {
      owned = true;
      return { grantId: 'grant', expiresAt: Date.now() + 60_000 };
    }
    if (request.operation === 'stop') {
      owned = false;
      return { stopped: true };
    }
    if (request.operation === 'observe')
      return {
        runId: 'run',
        snapshotId: String(snapshot),
        targetGeneration: 'target',
        applicationName: 'Fixture',
        bundleId: 'fixture.app',
        windowTitle: 'Fixture',
        elements: [{ ref: 'button', enabled: true, secure: false, role: 'button', actions: ['press'] }],
        ...(request.payload.includeScreenshot === false ? {} : { screenshot: { mimeType: 'image/png', data: 'cG5n' } }),
      };
    if (request.operation === 'act') {
      expect(request.payload.action.snapshotId).toBe(String(snapshot));
      snapshot += 1;
      return { applied: true };
    }
    return [];
  });
  const channel = createComputerUseChannel();
  const source = channel.start({
    directEvents,
    sessions: () => [scope],
    publish: vi.fn(),
    onNotice: vi.fn(),
    requestSessionApi: (_scope, value) =>
      request(value.path, value.body === undefined ? undefined : JSON.parse(value.body as string), false, 'hub'),
    ...(native
      ? {
          computerUse: {
            get available() {
              return available;
            },
            request: nativeRequest,
          },
        }
      : {}),
  } as DoomHubChannelHost);
  if (native) source.sessionAdded?.(scope);
  const execution = {
    context,
    signal: new AbortController().signal,
    operationId: 'test',
    sessionKind: 'headless' as const,
  };
  return {
    tools,
    modes,
    restrictions,
    claimed,
    nativeRequest,
    activity,
    request,
    channel,
    scope,
    activities,
    commands,
    hooks,
    context,
    execution,
    setEnabled(value: boolean) {
      enabled = value;
      for (const listener of listeners) listener();
    },
    async enable() {
      await modes[0]!.handleAction('activate', {}, execution);
    },
    async activate() {
      await modes[0]!.handleAction('activate', {}, execution);
      const response = await request('/activate', {
        target: { bundleId: 'fixture.app', windowId: 'window' },
        durationMs: 60_000,
      });
      expect(response.status).toBe(202);
      await vi.waitFor(async () =>
        expect(await (await request('/agent/state', undefined, false, 'agent')).json()).toMatchObject({
          phase: 'active',
        }),
      );
    },
    disconnect() {
      available = false;
      for (const listener of listeners) listener();
    },
    async close() {
      source.close();
      await release?.();
      await root.fiber.dispose();
    },
  };
}

describe('real computer-use server facet', () => {
  it('does not register a mode or tools when the host has no Desktop binding', async () => {
    const test = await fixture(false);
    try {
      expect(test.modes).toEqual([]);
      expect(test.tools).toEqual([]);
    } finally {
      await test.close();
    }
  });

  it('owns mode actions, command deactivation, guidance and activity cleanup through the mounted routes', async () => {
    const test = await fixture();
    try {
      const before = test.hooks.find(
        (hook) => hook.event === 'before_agent_start',
      ) as DoomHeadlessHook<'before_agent_start'>;
      expect(await before.handle({ systemPrompt: 'base' }, test.context)).toBeUndefined();
      const exec = test.tools.find((tool) => tool.name === 'computer_exec')!;
      expect(
        await exec.execute('inactive', { scriptPath: 'missing.ts', input: {} }, undefined, undefined, test.context),
      ).toMatchObject({ isError: true });
      await expect(test.modes[0]!.handleAction('unknown', {}, test.execution)).rejects.toThrow(
        'Unknown computer-use action',
      );
      await test.activate();
      const cleanup = await test.activities[0]!.start(test.context);
      expect(await before.handle({ systemPrompt: 'base' }, test.context)).toMatchObject({
        systemPrompt: expect.stringContaining('[COMPUTER USE ACTIVE]'),
      });
      expect(await test.modes[0]!.handleAction('doctor', {}, test.execution)).toMatchObject({
        message: 'Computer use is active.',
      });
      expect(
        await exec.execute('missing', { scriptPath: 'missing.ts', input: {} }, undefined, undefined, test.context),
      ).toMatchObject({ isError: true });
      await test.commands[0]!.execute('status', test.context);
      await test.commands[0]!.execute('deactivate', test.context);
      expect(test.context.selection.state?.['minor-mode']).not.toContain('computer-use');
      await cleanup();
      await test.modes[0]!.handleAction('deactivate', {}, test.execution);
      const shutdown = test.hooks.find(
        (hook) => hook.event === 'session_shutdown',
      ) as DoomHeadlessHook<'session_shutdown'>;
      await shutdown.handle({}, test.context);
    } finally {
      await test.close();
    }
  });

  it('blocks activation when global opt-in is off and withdraws a live grant when it is disabled', async () => {
    const test = await fixture();
    try {
      test.setEnabled(false);
      await expect(test.enable()).rejects.toThrow('global Desktop settings');
      const target = { target: { bundleId: 'fixture.app', windowId: 'window' }, durationMs: 60_000 };
      expect((await test.request('/activate', target)).status).toBe(409);
      test.setEnabled(true);
      await test.activate();
      test.setEnabled(false);
      const action = test.tools.find((tool) => tool.name === 'computer_action')!;
      expect(
        await action.execute(
          'disabled',
          { kind: 'press', snapshotId: '0', elementRef: 'button' },
          undefined,
          undefined,
          test.context,
        ),
      ).toMatchObject({ isError: true });
      await vi.waitFor(() =>
        expect(test.nativeRequest.mock.calls.some(([, request]) => request.operation === 'stop')).toBe(true),
      );
    } finally {
      await test.close();
    }
  });

  it('connects the production session client, broker, and channel without mocking their factory', async () => {
    const test = await fixture();
    try {
      const state = test.tools.find((tool) => tool.name === 'computer_state')!;
      expect(await state.execute('before', {}, undefined, undefined, {} as never)).toMatchObject({ isError: true });
      await test.activate();
      expect(test.claimed).toHaveBeenCalledOnce();
      const observed = await state.execute('state', { includeScreenshot: false }, undefined, undefined, {} as never);
      expect(observed.details).toMatchObject({ snapshotId: '0' });
      const action = test.tools.find((tool) => tool.name === 'computer_action')!;
      expect(
        await action.execute(
          'action',
          { kind: 'press', snapshotId: '0', elementRef: 'button' },
          undefined,
          undefined,
          {} as never,
        ),
      ).toMatchObject({ details: { applied: true } });
      expect((await state.execute('after', {}, undefined, undefined, {} as never)).details).toMatchObject({
        snapshotId: '1',
      });
    } finally {
      await test.close();
    }
  });

  it('executes a composed generated function through the real broker and channel in one tool invocation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'doompi-computer-chain-'));
    const test = await fixture(true, directory);
    try {
      await writeFile(
        path.join(directory, 'press.ts'),
        `
        export async function press(program) {
          const state = await program.observe();
          const button = state.elements.find(element => element.ref === 'button');
          if (!button) throw new Error('The fixture button is missing.');
          await program.act({ kind: 'press', snapshotId: state.snapshotId, elementRef: button.ref });
        }
      `,
      );
      await writeFile(
        path.join(directory, 'chain.ts'),
        `
        import { press } from './press.ts';
        export async function run({context: {program}}) {
          await press(program);
          await press(program);
          return { completed: true, nodeAccess: typeof process };
        }
      `,
      );
      await test.activate();
      const execute = test.tools.find((tool) => tool.name === 'computer_exec')!;
      const result = await execute.execute(
        'chain',
        { scriptPath: 'chain.ts', input: {} },
        undefined,
        undefined,
        {} as never,
      );
      expect(result.isError).not.toBe(true);
      expect(result.details).toMatchObject({
        result: { completed: true, nodeAccess: 'undefined' },
        observation: { snapshotId: '2' },
        metrics: { actions: 2, observations: 3 },
      });
      expect(result.content.every((item) => item.type === 'text')).toBe(true);
      expect(test.nativeRequest.mock.calls.filter(([, request]) => request.operation === 'act')).toHaveLength(2);
      expect(
        test.nativeRequest.mock.calls
          .filter(([, request]) => request.operation === 'observe')
          .every(([, request]) => request.payload.includeScreenshot === false),
      ).toBe(true);
    } finally {
      await test.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects browser activation and raw browser channel commands on the same Desktop server', async () => {
    const test = await fixture();
    try {
      await test.enable();
      expect(
        (
          await test.request(
            '/activate',
            { target: { bundleId: 'fixture.app', windowId: 'window' }, durationMs: 60_000 },
            false,
          )
        ).status,
      ).toBe(404);
      test.nativeRequest.mockClear();
      test.channel.receive?.(test.scope, { action: 'targets' }, { connectionId: 'browser' });
      expect(test.nativeRequest).not.toHaveBeenCalled();
      expect(test.claimed).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it('will not grant control over an agent with an already queued browser prompt', async () => {
    const test = await fixture();
    try {
      await test.enable();
      test.activity.mockResolvedValue({ isIdle: true, hasPendingMessages: true });
      expect(
        (
          await test.request('/activate', {
            target: { bundleId: 'fixture.app', windowId: 'window' },
            durationMs: 60_000,
          })
        ).status,
      ).toBe(409);
      expect(test.nativeRequest.mock.calls.some(([, request]) => request.operation === 'activate')).toBe(false);
    } finally {
      await test.close();
    }
  });

  it('withdraws execution when Desktop disconnects, including tools retained by a caller', async () => {
    const test = await fixture();
    try {
      await test.activate();
      const action = test.tools.find((tool) => tool.name === 'computer_action')!;
      test.disconnect();
      expect(
        await action.execute(
          'late',
          { kind: 'press', snapshotId: '0', elementRef: 'button' },
          undefined,
          undefined,
          {} as never,
        ),
      ).toMatchObject({ isError: true });
    } finally {
      await test.close();
    }
  });
});
