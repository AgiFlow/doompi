import * as fs from 'node:fs';

import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessActivity,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessResource,
  type DoomHeadlessTool,
  type DoomHeadlessToolResult,
} from '@agimon-ai/doompi-core/headless';
import type { DoomApi } from '@agimon-ai/doompi-core/package-api';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-core/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TEAM_API_BASE_PATH } from '../../../src/controllers/teamSessionApi';
import { teamServerFacet as teamHeadlessFacet } from '../../../src/extensions/server';
import { sessionScopeDir } from '../../../src/services/sessionPaths';
import * as runtimeModule from '../../../src/services/teamRuntime';
import type { TeamExtensionRuntime } from '../../../src/services/teamRuntime';
import { TEST_SESSION_SCOPE } from '../../support/sessionScope';

async function fixture(options: { serverHost?: unknown } = {}) {
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
      forkSource: vi.fn(async () => ({
        kind: 'v4-fork' as const,
        sessionFile: '/sessions/parent.sqlite',
        branch: 'main',
      })),
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
    registerApi: vi.fn(() => registration()),
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
    effect: () => undefined,
    plugin: (plugin: (ctx: Context) => void) => {
      plugin(context);
      return { dispose: vi.fn() };
    },
    provide: vi.fn(),
    emit: vi.fn(),
  } as unknown as Context;

  const runtimeSpy = vi.spyOn(runtimeModule, 'createTeamExtensionRuntime');
  let dispose: Awaited<ReturnType<typeof teamHeadlessFacet.apply>>;
  try {
    dispose = await teamHeadlessFacet.apply(context);
    runtime = runtimeSpy.mock.results.at(-1)?.value as TeamExtensionRuntime | undefined;
  } finally {
    runtimeSpy.mockRestore();
  }
  if (!dispose || !runtime) throw new Error('Team headless facet did not mount');
  return {
    serverHost: defaultServerHost,
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
  it('rejects a missing session server host', async () => {
    await expect(fixture({ serverHost: null })).rejects.toThrow('The Doom server host is unavailable');
  });
  it('rejects a missing host-owned direct event bus', async () => {
    await expect(fixture({ serverHost: { scope: 'session', context: { environment: {} } } })).rejects.toThrow(
      'requires host-owned direct events',
    );
  });
  it('rejects a missing admitted session environment', async () => {
    await expect(
      fixture({
        serverHost: {
          scope: 'session',
          context: { directEvents: { publish: vi.fn(), subscribe: vi.fn(() => () => undefined), close: vi.fn() } },
        },
      }),
    ).rejects.toThrow('requires an admitted session environment');
  });
  it('retains tracked jobs across optional activity disable and re-enable', async () => {
    vi.useFakeTimers();
    const test = await fixture();
    expect(test.serverHost.registerApi).toHaveBeenCalledWith(expect.objectContaining({ basePath: TEAM_API_BASE_PATH }));
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
      await test.dispose();
      fs.rmSync(sessionScopeDir(scope), { recursive: true, force: true });
    }
  });

  it('launches a catalog agent through the session API without prompting the parent', async () => {
    const test = await fixture();
    const spawn = vi.spyOn(test.runtime.spawnPlanner, 'spawn').mockResolvedValue({
      outcomes: [{ agent: 'mock-agent', task: 'Review', childIndex: 0, runId: 'web-run' }],
    });
    const registered = (test.serverHost.registerApi.mock.calls[0] as unknown as [DoomApi] | undefined)?.[0];
    if (!registered) throw new Error('Team session API was not registered');
    const handler = registered.start({
      scope: 'session',
      cwd: test.execution.cwd,
      environment: test.execution.environment,
      onNotice: vi.fn(),
    });
    try {
      const response = await handler.fetch(
        new Request('http://session/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent: 'mock-agent', task: 'Review', fork: true }),
        }),
      );
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual({ runId: 'web-run' });
      expect(spawn.mock.calls[0]?.[0]).toMatchObject({
        single: { agent: 'mock-agent', task: 'Review', context: 'fork' },
        parentForkSource: { kind: 'v4-fork', sessionFile: '/sessions/parent.sqlite', branch: 'main' },
      });
      expect(test.execution.session.prompt).not.toHaveBeenCalled();
    } finally {
      handler.close();
      spawn.mockRestore();
      await test.dispose();
    }
  });

  it('detaches intercom on activity stop and stops every runtime worker on final disposal', async () => {
    vi.useFakeTimers();
    const test = await fixture();
    expect(test.serverHost.registerApi).toHaveBeenCalledWith(expect.objectContaining({ basePath: TEAM_API_BASE_PATH }));
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

      await test.dispose();
      expect(test.runtime.asyncJobTracker.forSession(test.sessionId, scope).list()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(test.disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);

      await test.dispose();
      expect(test.disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    } finally {
      await activityStop?.();
      await test.dispose();
      fs.rmSync(sessionScopeDir(scope), { recursive: true, force: true });
    }
  });

  it('dispatches headless subagent actions without a Pi ExtensionAPI', async () => {
    const test = await fixture();
    expect(test.serverHost.registerApi).toHaveBeenCalledWith(expect.objectContaining({ basePath: TEAM_API_BASE_PATH }));
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
      await test.dispose();
      fs.rmSync(sessionScopeDir(scope), { recursive: true, force: true });
    }
  });

  it('attaches completion notifications to the headless client', async () => {
    const test = await fixture();
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
      await test.dispose();
    }
  });
});
