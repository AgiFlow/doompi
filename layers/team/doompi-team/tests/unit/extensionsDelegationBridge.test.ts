import {
  DOOM_DELEGATION_ACCEPTED_EVENT,
  DOOM_DELEGATION_FINISHED_EVENT,
  DOOM_DELEGATION_UPDATED_EVENT,
  type DelegationRequest,
} from '@agimon-ai/doompi-extension-contracts/delegation';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it } from 'vitest';

import { createDelegationBridge, type DelegationBridgeDeps } from '../../src/adapters/pi/extensions/delegationBridge';
import type { TrackedAsyncJobsContract } from '../../src/adapters/asyncJobTracker';

interface StoredEvent {
  name: string;
  payload: unknown;
}

const roots: Context[] = [];

afterEach(async () => {
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
    const service = bridge.createService(ctx, { sessionId: 'session-1', availableModels: [] });

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
    let current = { sessionFile: '/tmp/parent.jsonl', leafId: 'leaf-1' };
    const service = bridge.createService(ctx, {
      sessionId: 'session-1',
      availableModels: [],
      captureForkSource: () => current,
    });

    await service.request(forkRequest('request-1'));
    current = { sessionFile: '/tmp/parent.jsonl', leafId: 'leaf-2' };
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
    const service = bridge.createService(ctx, { sessionId: 'session-1', availableModels: [] });

    await service.request(forkRequest('request-1'));

    expect(spawnRequests[0]).not.toHaveProperty('parentSessionFile');
    expect(spawnRequests[0]).not.toHaveProperty('parentLeafId');
  });
});
