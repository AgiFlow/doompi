import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DOOM_DELEGATION_ACCEPTED_EVENT,
  DOOM_DELEGATION_FINISHED_EVENT,
  DOOM_DELEGATION_UPDATED_EVENT,
  type DelegationRequest,
} from '../../src/exports/delegationApi';
import type { TrackedAsyncJobsContract } from '../../src/services/asyncJobTracker';
import { createDelegationBridge, type DelegationBridgeDeps } from '../../src/services/delegationBridge';
import { TEST_SESSION_SCOPE } from '../support/sessionScope';

interface StoredEvent {
  name: string;
  payload: unknown;
}

const roots: Context[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(roots.splice(0).map((root) => root.fiber.dispose()));
});

describe('createDelegationBridge live metrics', () => {
  it('emits metrics on updates and leaves terminal results token-free', async () => {
    let resolveWait: ((value: { reason: 'completed'; elapsedMs: number; runs: [] }) => void) | undefined;
    const job: {
      runId: string;
      status: string;
      startedAt: number;
      updatedAt: number;
      tokens?: number;
      currentTool: string;
      toolCount: number;
    } = {
      runId: 'run-1',
      status: 'running',
      startedAt: 10,
      updatedAt: 20,
      tokens: 0,
      currentTool: 'Read',
      toolCount: 0,
    };
    const jobs = {
      track: () => {},
      get: () => job,
      list: () => [job],
      untrack: () => {},
      reset: () => {},
    } as unknown as TrackedAsyncJobsContract;
    let schedulerSubscription: { run: () => boolean } | undefined;
    const deps: DelegationBridgeDeps = {
      planner: {
        spawn: async () => ({ outcomes: [{ runId: 'run-1', agent: 'worker', task: 'work', childIndex: 0, pid: 1 }] }),
      } as never,
      management: {
        stop: () => {},
        status: () => ({ status: { state: 'completed', startedAt: 10, endedAt: 30, summary: 'done' } }),
      } as never,
      waiter: {
        wait: () =>
          new Promise((resolve) => {
            resolveWait = resolve as typeof resolveWait;
          }),
      } as never,
      scheduler: {
        register: (subscription: { run: () => boolean }) => {
          schedulerSubscription = subscription;
          return () => {};
        },
        wake: () => {
          schedulerSubscription?.run();
        },
      } as never,
      tracker: { forSession: () => jobs } as never,
      loadConfig: () => ({}) as never,
    };
    const bridge = createDelegationBridge(deps);
    const ctx = new Context();
    roots.push(ctx);
    const events: StoredEvent[] = [];
    ctx.on(DOOM_DELEGATION_ACCEPTED_EVENT, (payload) => {
      events.push({ name: DOOM_DELEGATION_ACCEPTED_EVENT, payload });
    });
    ctx.on(DOOM_DELEGATION_UPDATED_EVENT, (payload) => {
      events.push({ name: DOOM_DELEGATION_UPDATED_EVENT, payload });
    });
    ctx.on(DOOM_DELEGATION_FINISHED_EVENT, (payload) => {
      events.push({ name: DOOM_DELEGATION_FINISHED_EVENT, payload });
    });
    const service = bridge.createService(ctx, {
      sessionId: 'session-1',
      sessionScope: TEST_SESSION_SCOPE,
      availableModels: [],
    });

    const request: DelegationRequest = {
      requestId: 'request-1',
      taskId: 'task-1',
      agent: 'worker',
      prompt: 'work',
      cwd: '/repo',
    };
    const pending = service.request(request);
    await Promise.resolve();
    expect(events[0]).toEqual({
      name: DOOM_DELEGATION_ACCEPTED_EVENT,
      payload: { requestId: 'request-1' },
    });
    schedulerSubscription?.run();
    job.tokens = undefined;
    job.updatedAt = 21;
    schedulerSubscription?.run();
    resolveWait?.({ reason: 'completed', elapsedMs: 20, runs: [] });
    await pending;

    const updates = events.filter((event) => event.name === DOOM_DELEGATION_UPDATED_EVENT);
    expect(updates).toEqual([
      {
        name: DOOM_DELEGATION_UPDATED_EVENT,
        payload: {
          requestId: 'request-1',
          runId: 'run-1',
          status: 'running',
          durationMs: expect.any(Number),
          tokens: 0,
          currentTool: 'Read',
          toolCount: 0,
        },
      },
      {
        name: DOOM_DELEGATION_UPDATED_EVENT,
        payload: {
          requestId: 'request-1',
          runId: 'run-1',
          status: 'running',
          durationMs: expect.any(Number),
          currentTool: 'Read',
          toolCount: 0,
        },
      },
    ]);
    const result = events.find((event) => event.name === DOOM_DELEGATION_FINISHED_EVENT)?.payload;
    expect(result).not.toHaveProperty('tokens');
  });

  it('steers a slow delegation once shortly before its timeout', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let resolveWait: ((value: { reason: 'completed'; elapsedMs: number; runs: [] }) => void) | undefined;
    let schedulerSubscription: { run: () => boolean } | undefined;
    const steer = vi.fn().mockResolvedValue({
      requestId: 'steer-1',
      index: 0,
      state: 'delivered',
      message: 'delivered',
    });
    const job = { runId: 'run-1', status: 'running', startedAt: now, updatedAt: now };
    const jobs = {
      track: () => {},
      get: () => job,
      list: () => [job],
      untrack: () => {},
      reset: () => {},
    } as unknown as TrackedAsyncJobsContract;
    const deps: DelegationBridgeDeps = {
      planner: {
        spawn: async () => ({ outcomes: [{ runId: 'run-1', agent: 'worker', task: 'work', childIndex: 0, pid: 1 }] }),
      } as never,
      management: {
        steer,
        stop: () => {},
        status: () => ({ status: { state: 'completed', startedAt: 1_000, endedAt: 2_000, summary: 'done' } }),
      } as never,
      waiter: {
        wait: () =>
          new Promise((resolve) => {
            resolveWait = resolve as typeof resolveWait;
          }),
      } as never,
      scheduler: {
        register: (subscription: { run: () => boolean }) => {
          schedulerSubscription = subscription;
          return () => {};
        },
        wake: () => {
          schedulerSubscription?.run();
        },
      } as never,
      tracker: { forSession: () => jobs } as never,
      loadConfig: () => ({}) as never,
    };
    const bridge = createDelegationBridge(deps);
    const ctx = new Context();
    roots.push(ctx);
    const service = bridge.createService(ctx, {
      sessionId: 'session-1',
      sessionScope: TEST_SESSION_SCOPE,
      availableModels: [],
    });

    const pending = service.request({
      requestId: 'request-1',
      taskId: 'task-1',
      agent: 'worker',
      prompt: 'work',
      cwd: '/repo',
    });
    await Promise.resolve();
    expect(steer).not.toHaveBeenCalled();

    now = 1_081_000;
    schedulerSubscription?.run();
    schedulerSubscription?.run();
    await Promise.resolve();

    expect(steer).toHaveBeenCalledOnce();
    expect(steer).toHaveBeenCalledWith(
      'run-1',
      expect.stringMatching(/time out in about 120 seconds.*return verified findings and blockers immediately/i),
    );

    resolveWait?.({ reason: 'completed', elapsedMs: 1_200_000, runs: [] });
    await pending;
  });
});

describe('createDelegationBridge fork source', () => {
  const forkDeps = (spawnRequests: Array<Record<string, unknown>>): DelegationBridgeDeps =>
    ({
      planner: {
        spawn: async (request: Record<string, unknown>) => {
          spawnRequests.push(request);
          return {
            outcomes: [{ runId: `run-${spawnRequests.length}`, agent: 'worker', task: 'work', childIndex: 0, pid: 1 }],
          };
        },
      },
      management: {
        stop: () => {},
        status: () => ({ status: { state: 'completed', startedAt: 10, endedAt: 30, summary: 'done' } }),
      },
      waiter: { wait: async () => ({ reason: 'completed', elapsedMs: 20, runs: [] }) },
      scheduler: { register: () => () => {}, wake: () => {} },
      tracker: {
        forSession: () =>
          ({
            track: () => {},
            get: () => undefined,
            list: () => [],
            untrack: () => {},
            reset: () => {},
          }) as unknown as TrackedAsyncJobsContract,
      },
      loadConfig: () => ({}),
    }) as never;

  const forkRequest = (requestId: string): DelegationRequest => ({
    requestId,
    taskId: 'task-1',
    agent: 'worker',
    prompt: 'work',
    cwd: '/repo',
    context: 'fork',
  });

  it('captures the fork source per request instead of reusing a bind-time value', async () => {
    const spawnRequests: Array<Record<string, unknown>> = [];
    const bridge = createDelegationBridge(forkDeps(spawnRequests));
    const ctx = new Context();
    roots.push(ctx);
    let current = {
      sessionFile: '/tmp/parent.jsonl',
      leafId: 'leaf-1',
      terminalSource: {
        kind: 'terminal-pi-fork' as const,
        sourceSessionId: 'session-1',
        sourceLeafId: 'leaf-1',
        snapshotJsonl: '{}\n',
      },
    };
    const service = bridge.createService(ctx, {
      sessionId: 'session-1',
      sessionScope: TEST_SESSION_SCOPE,
      availableModels: [],
      captureForkSource: () => current,
    });

    await service.request(forkRequest('request-1'));
    current = {
      sessionFile: '/tmp/parent.jsonl',
      leafId: 'leaf-2',
      terminalSource: {
        kind: 'terminal-pi-fork',
        sourceSessionId: 'session-1',
        sourceLeafId: 'leaf-2',
        snapshotJsonl: '{}\n',
      },
    };
    await service.request(forkRequest('request-2'));

    expect(spawnRequests.map((request) => request.parentLeafId)).toEqual(['leaf-1', 'leaf-2']);
  });

  it('omits the parent lineage when the session cannot produce a fork source', async () => {
    const spawnRequests: Array<Record<string, unknown>> = [];
    const bridge = createDelegationBridge(forkDeps(spawnRequests));
    const ctx = new Context();
    roots.push(ctx);
    const service = bridge.createService(ctx, {
      sessionId: 'session-1',
      sessionScope: TEST_SESSION_SCOPE,
      availableModels: [],
      captureForkSource: () => undefined,
    });

    await service.request(forkRequest('request-1'));

    expect(spawnRequests[0]).not.toHaveProperty('parentSessionFile');
    expect(spawnRequests[0]).not.toHaveProperty('parentLeafId');
  });

  it('omits the parent lineage when the session declares no fork capture at all', async () => {
    const spawnRequests: Array<Record<string, unknown>> = [];
    const bridge = createDelegationBridge(forkDeps(spawnRequests));
    const ctx = new Context();
    roots.push(ctx);
    const service = bridge.createService(ctx, {
      sessionId: 'session-1',
      sessionScope: TEST_SESSION_SCOPE,
      availableModels: [],
    });

    await service.request(forkRequest('request-1'));

    expect(spawnRequests[0]).not.toHaveProperty('parentSessionFile');
    expect(spawnRequests[0]).not.toHaveProperty('parentLeafId');
  });
});
