import * as fs from 'node:fs';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessActivity,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessResource,
  type DoomHeadlessTool,
  type DoomHeadlessToolResult,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { teamHeadlessFacet } from '../../../src/adapters/headless/facet.ts';
import { sessionScopeDir } from '../../../src/adapters/filesystem/paths';
import type { TeamExtensionRuntime } from '../../../src/adapters/pi/teamRuntime';
import { TEST_SESSION_SCOPE } from '../../support/sessionScope';

function fixture(options: { serverHost?: unknown } = {}) {
  const sessionId = TEST_SESSION_SCOPE.rootSessionId;
  const execution = {
    cwd: process.cwd(),
    repoRoot: process.cwd(),
    sessionId,
    environment: {},
    model: { provider: 'openai-codex', id: 'gpt-5.6-luna' },
    client: { notify: vi.fn(), request: vi.fn(), setStatus: vi.fn() },
    session: {
      entries: () => [],
      appendCustomEntry: vi.fn(),
      prompt: vi.fn(),
      abort: vi.fn(),
      compact: vi.fn(),
    },
    selection: { majorMode: 'test', activeLayers: ['team'], domains: [], minorModes: [] },
    shutdown: vi.fn(),
  } as unknown as DoomHeadlessExecutionContext;
  const tools: DoomHeadlessTool[] = [];
  const resources: DoomHeadlessResource[] = [];
  const activities: DoomHeadlessActivity[] = [];
  const disposers: Array<ReturnType<typeof vi.fn>> = [];
  let runtime: TeamExtensionRuntime | undefined;
  let context!: Context;

  const registration = () => {
    const dispose = vi.fn();
    disposers.push(dispose);
    return { dispose };
  };
  const defaultServerHost = {
    scope: 'session' as const,
    context: {
      environment: {},
      directEvents: {
        publish: vi.fn(),
        subscribe: vi.fn(() => () => undefined),
        close: vi.fn(),
      },
    },
  };
  const serverHost = options.serverHost === null ? undefined : (options.serverHost ?? defaultServerHost);
  const host = {
    context: execution,
    registerTool(tool: DoomHeadlessTool) {
      tools.push(tool);
      return registration();
    },
    registerResource(resource: DoomHeadlessResource) {
      resources.push(resource);
      return registration();
    },
    registerActivity(activity: DoomHeadlessActivity) {
      activities.push(activity);
      return registration();
    },
  };
  context = {
    get: (name: string) => {
      if (name === DOOM_HEADLESS_HOST_SERVICE) return host;
      if (name === DOOM_SERVER_HOST_SERVICE) return serverHost;
      return undefined;
    },
    plugin: (
      plugin: (ctx: Context, config: { runtime: TeamExtensionRuntime }) => void,
      config: { runtime: TeamExtensionRuntime },
    ) => {
      runtime = config.runtime;
      plugin(context, config);
    },
    provide: vi.fn(),
    emit: vi.fn(),
  } as unknown as Context;

  const dispose = teamHeadlessFacet.apply(context);
  if (!dispose || !runtime) throw new Error('Team headless facet did not mount');
  return {
    activities,
    client: execution.client,
    context,
    dispose,
    disposers,
    execution,
    resources,
    runtime,
    sessionId,
    tools,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('teamHeadlessFacet', () => {
  it('rejects a missing session server host', () => {
    expect(() => fixture({ serverHost: null })).toThrow('requires a session server host');
  });

  it('rejects a missing host-owned direct event bus', () => {
    expect(() => fixture({ serverHost: { scope: 'session', context: { environment: {} } } })).toThrow(
      'requires host-owned direct events',
    );
  });

  it('rejects a missing admitted session environment', () => {
    expect(() =>
      fixture({
        serverHost: {
          scope: 'session',
          context: {
            directEvents: { publish: vi.fn(), subscribe: vi.fn(() => () => undefined), close: vi.fn() },
          },
        },
      }),
    ).toThrow('requires an admitted session environment');
  });
  it('retains tracked jobs across optional activity disable and re-enable', async () => {
    vi.useFakeTimers();
    const test = fixture();
    const scope = TEST_SESSION_SCOPE;
    let activityStop: (() => void | Promise<void>) | undefined;

    try {
      activityStop = await test.activities[0]!.start(test.execution);
      const jobs = test.runtime.asyncJobTracker.forSession(test.sessionId, scope);
      const intercom = test.tools.find((tool) => tool.name === 'intercom');
      if (!intercom) throw new Error('intercom headless tool was not registered');
      jobs.track('retained-run');
      expect(jobs.list()).toMatchObject([{ runId: 'retained-run', status: undefined }]);
      await expect(
        intercom.execute('active', { action: 'members' }, undefined, undefined, test.execution),
      ).resolves.toMatchObject({
        details: { members: [{ name: 'main', role: 'main' }] },
      });

      await activityStop?.();
      activityStop = undefined;
      await expect(
        intercom.execute('detached', { action: 'members' }, undefined, undefined, test.execution),
      ).rejects.toThrow('Intercom is not active for this session');
      expect(jobs.list()).toHaveLength(1);

      activityStop = await test.activities[0]!.start(test.execution);
      await expect(
        intercom.execute('rebound', { action: 'members' }, undefined, undefined, test.execution),
      ).resolves.toMatchObject({
        details: { members: [{ name: 'main', role: 'main' }] },
      });
      expect(jobs.list()).toMatchObject([{ runId: 'retained-run' }]);
      await activityStop?.();
      activityStop = undefined;
    } finally {
      await activityStop?.();
      test.dispose();
      fs.rmSync(sessionScopeDir(scope), { recursive: true, force: true });
    }
  });

  it('detaches intercom on activity stop and stops every runtime worker on final disposal', async () => {
    vi.useFakeTimers();
    const test = fixture();
    const scope = TEST_SESSION_SCOPE;
    let activityStop: (() => void | Promise<void>) | undefined;
    const intercom = test.tools.find((tool) => tool.name === 'intercom');
    if (!intercom) throw new Error('intercom headless tool was not registered');

    try {
      activityStop = await test.activities[0]!.start(test.execution);
      const jobs = test.runtime.asyncJobTracker.forSession(test.sessionId, scope);
      jobs.track('final-run');
      await activityStop?.();
      activityStop = undefined;
      await expect(
        intercom.execute('detached', { action: 'members' }, undefined, undefined, test.execution),
      ).rejects.toThrow('Intercom is not active for this session');
      expect(jobs.list()).toHaveLength(1);

      test.dispose();
      expect(test.runtime.asyncJobTracker.forSession(test.sessionId, scope).list()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(test.disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);

      test.dispose();
      expect(test.disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    } finally {
      await activityStop?.();
      test.dispose();
      fs.rmSync(sessionScopeDir(scope), { recursive: true, force: true });
    }
  });

  it('dispatches headless subagent actions without a Pi ExtensionAPI', async () => {
    const test = fixture();
    const scope = TEST_SESSION_SCOPE;
    const subagent = test.tools.find((tool) => tool.name === 'subagent');
    if (!subagent) throw new Error('subagent headless tool was not registered');
    const spawn = vi.spyOn(test.runtime.spawnPlanner, 'spawn').mockResolvedValue({
      outcomes: [{ agent: 'mock-agent', task: 'mock task', childIndex: 0, runId: 'mock-run' }],
    });
    const invoke = (params: unknown, onUpdate?: (result: DoomHeadlessToolResult) => void) =>
      subagent.execute('dispatch', params as never, undefined, onUpdate, test.execution);

    try {
      expect(await invoke({ action: 'invalid' })).toMatchObject({ isError: true });
      expect(await invoke({ action: 'agents', cwd: '/tmp', scope: 'project' })).toMatchObject({
        details: { agents: expect.any(Array) },
      });
      expect(await invoke({ action: 'agents', cwd: '/tmp', scope: 'project', name: 'missing-agent' })).toMatchObject({
        isError: true,
      });

      const onUpdate = vi.fn<(result: DoomHeadlessToolResult) => void>();
      expect(
        await invoke(
          { action: 'run', requests: [{ agent: 'mock-agent', task: 'mock task' }], scope: 'project' },
          onUpdate,
        ),
      ).toMatchObject({ details: { outcomes: [{ runId: 'mock-run' }] } });
      expect(spawn.mock.calls[0]?.[0]).toMatchObject({
        availableModels: [{ provider: 'openai-codex', id: 'gpt-5.6-luna', fullId: 'openai-codex/gpt-5.6-luna' }],
        parentModel: { provider: 'openai-codex', id: 'gpt-5.6-luna' },
      });
      expect(onUpdate).toHaveBeenCalledOnce();
      expect(await invoke({ action: 'status' })).toMatchObject({ details: { runs: [{ runId: 'mock-run' }] } });
      expect(await invoke({ action: 'status', id: 'mock-run' })).toMatchObject({ details: { runId: 'mock-run' } });
      expect(await invoke({ action: 'suspended' })).toMatchObject({ details: { suspended: [] } });
      expect(await invoke({ action: 'stop', id: 'mock-run' })).toMatchObject({ isError: true });
      expect(await invoke({ action: 'steer', id: 'mock-run', message: 'continue' })).toMatchObject({ isError: true });
      expect(await invoke({ action: 'restore', id: 'missing-run' })).toMatchObject({ isError: true });
    } finally {
      spawn.mockRestore();
      test.dispose();
      fs.rmSync(sessionScopeDir(scope), { recursive: true, force: true });
    }
  });

  it('attaches completion notifications to the headless client', async () => {
    const test = fixture();
    try {
      await expect(
        test.runtime.completionNotifier.deliver({
          runId: 'headless-completion',
          agent: 'worker',
          success: false,
          summary: 'failed',
        }),
      ).resolves.toBe(true);
      expect(test.client.notify).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining('failed') }),
      );
    } finally {
      test.dispose();
    }
  });
});
