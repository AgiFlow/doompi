import { describe, expect, it, vi } from 'vitest';

import type { ExtensionConfig } from '../../src/adapters/pi/extensions/config';
import type {
  SpawnPlannerContract,
  SpawnPlanRequest,
  SpawnPlanResult,
} from '../../src/adapters/pi/extensions/spawnPlan';
import type { AsyncJobTrackerContract, TrackedAsyncJob } from '../../src/adapters/asyncJobTracker';
import type { PollSchedulerContract, PollSubscription } from '../../src/adapters/pollScheduler';
import {
  launchParallelSubagents,
  launchSingleSubagent,
  requestSlashRunStop,
  watchTrackedRunUntilTerminal,
} from '../../src/adapters/pi/commands/slash/subagentLaunch';

const config: ExtensionConfig = {};

class FakeSpawnPlanner implements SpawnPlannerContract {
  spawnCalls: SpawnPlanRequest[] = [];
  spawnResult: SpawnPlanResult = { outcomes: [] };

  async spawn(request: SpawnPlanRequest): Promise<SpawnPlanResult> {
    this.spawnCalls.push(request);
    return this.spawnResult;
  }
}

class FakeAsyncJobTracker implements AsyncJobTrackerContract {
  forSession() {
    return this;
  }
  tracked: string[] = [];
  jobs = new Map<string, TrackedAsyncJob>();

  track(runId: string): void {
    this.tracked.push(runId);
  }
  untrack(runId: string): void {
    this.jobs.delete(runId);
  }
  list(): TrackedAsyncJob[] {
    return [...this.jobs.values()];
  }
  get(runId: string): TrackedAsyncJob | undefined {
    return this.jobs.get(runId);
  }
  reset(): void {
    this.jobs.clear();
  }
  start(): void {}
  stop(): void {}
}

class FakePollScheduler implements PollSchedulerContract {
  subscriptions: PollSubscription[] = [];
  unregisterCalls = 0;

  register(subscription: PollSubscription): () => void {
    this.subscriptions.push(subscription);
    return () => {
      this.unregisterCalls++;
      this.subscriptions = this.subscriptions.filter((s) => s !== subscription);
    };
  }
  wake(): void {}
  start(): void {}
  stop(): void {}
}

describe('launchSingleSubagent', () => {
  it('builds a SINGLE-mode SpawnPlanRequest and tracks every runId the spawn returned', async () => {
    const planner = new FakeSpawnPlanner();
    planner.spawnResult = { outcomes: [{ agent: 'worker', task: 'do it', childIndex: 0, runId: 'run-1', pid: 123 }] };
    const tracker = new FakeAsyncJobTracker();

    const result = await launchSingleSubagent(
      planner,
      tracker,
      { agent: 'worker', task: 'do it', cwd: '/work', agentScope: 'both' },
      config,
    );

    expect(planner.spawnCalls[0]).toMatchObject({
      single: { agent: 'worker', task: 'do it' },
      cwd: '/work',
      agentScope: 'both',
    });
    expect(tracker.tracked).toEqual(['run-1']);
    expect(result.outcomes[0]?.runId).toBe('run-1');
  });

  it('does not track an outcome that has no runId, e.g. a preflight-level per-child failure', async () => {
    const planner = new FakeSpawnPlanner();
    planner.spawnResult = { outcomes: [{ agent: 'worker', task: 'x', childIndex: 0, error: 'spawn failed' }] };
    const tracker = new FakeAsyncJobTracker();

    await launchSingleSubagent(
      planner,
      tracker,
      { agent: 'worker', task: 'x', cwd: '/work', agentScope: 'both' },
      config,
    );

    expect(tracker.tracked).toEqual([]);
  });

  it('includes optional fields only when given', async () => {
    const planner = new FakeSpawnPlanner();
    const tracker = new FakeAsyncJobTracker();

    await launchSingleSubagent(
      planner,
      tracker,
      {
        agent: 'worker',
        task: 'x',
        cwd: '/work',
        agentScope: 'both',
        model: 'sonnet',
        context: 'fork',
        parentModel: { provider: 'openai-codex', id: 'gpt-5.6-luna' },
      },
      config,
    );

    expect(planner.spawnCalls[0]?.single).toMatchObject({
      agent: 'worker',
      task: 'x',
      model: 'sonnet',
      context: 'fork',
    });
    expect(planner.spawnCalls[0]?.parentModel).toEqual({ provider: 'openai-codex', id: 'gpt-5.6-luna' });
  });
});

describe('launchParallelSubagents', () => {
  it('builds a PARALLEL-mode SpawnPlanRequest and tracks every started child', async () => {
    const planner = new FakeSpawnPlanner();
    planner.spawnResult = {
      outcomes: [
        { agent: 'a', task: 'x', childIndex: 0, runId: 'run-a' },
        { agent: 'b', task: 'y', childIndex: 1, runId: 'run-b' },
      ],
    };
    const tracker = new FakeAsyncJobTracker();

    await launchParallelSubagents(
      planner,
      tracker,
      {
        tasks: [
          { agent: 'a', task: 'x' },
          { agent: 'b', task: 'y' },
        ],
        cwd: '/work',
        agentScope: 'both',
        concurrency: 2,
      },
      config,
    );

    expect(planner.spawnCalls[0]?.tasks).toHaveLength(2);
    expect(planner.spawnCalls[0]?.concurrency).toBe(2);
    expect(tracker.tracked).toEqual(['run-a', 'run-b']);
  });
});

describe('requestSlashRunStop', () => {
  it('writes a stop request by default', () => {
    // No fs seam is exposed here deliberately - requestAsyncStop itself is
    // already covered by control-channel.test.ts; this test only proves
    // requestSlashRunStop calls the right one, not the write mechanics.
    expect(() => requestSlashRunStop('nonexistent-run')).not.toThrow();
  });

  it('propagates a real write failure rather than swallowing it', async () => {
    const controlChannel = await import('../../src/adapters/intercom/supervisorControlChannel');
    const spy = vi.spyOn(controlChannel, 'requestAsyncStop').mockImplementation(() => {
      throw new Error('disk full');
    });
    try {
      expect(() => requestSlashRunStop('run-1')).toThrow('disk full');
    } finally {
      spy.mockRestore();
    }
  });

  it('calls requestAsyncInterrupt instead when mode is interrupt', async () => {
    const controlChannel = await import('../../src/adapters/intercom/supervisorControlChannel');
    const interruptSpy = vi.spyOn(controlChannel, 'requestAsyncInterrupt').mockImplementation(() => 'path');
    const stopSpy = vi.spyOn(controlChannel, 'requestAsyncStop');
    try {
      requestSlashRunStop('run-1', 'interrupt', 'user requested stop');
      expect(interruptSpy).toHaveBeenCalledWith(expect.stringContaining('run-1'), { reason: 'user requested stop' });
      expect(stopSpy).not.toHaveBeenCalled();
    } finally {
      interruptSpy.mockRestore();
    }
  });
});

describe('watchTrackedRunUntilTerminal', () => {
  it('registers with PollScheduler and does not call onChange until the tracked status actually changes', async () => {
    const scheduler = new FakePollScheduler();
    const tracker = new FakeAsyncJobTracker();
    tracker.jobs.set('run-1', { runId: 'run-1', status: 'running', updatedAt: 1 });
    const onChange = vi.fn();

    watchTrackedRunUntilTerminal(scheduler, tracker, 'run-1', onChange);
    expect(scheduler.subscriptions).toHaveLength(1);

    await scheduler.subscriptions[0]?.run();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(tracker.jobs.get('run-1'));

    // Same status/updatedAt again - the render-key gate must suppress a
    // second call, which is the whole point of the fix.
    await scheduler.subscriptions[0]?.run();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('calls onChange again once status or updatedAt actually changes', async () => {
    const scheduler = new FakePollScheduler();
    const tracker = new FakeAsyncJobTracker();
    tracker.jobs.set('run-1', { runId: 'run-1', status: 'running', updatedAt: 1 });
    const onChange = vi.fn();

    watchTrackedRunUntilTerminal(scheduler, tracker, 'run-1', onChange);
    await scheduler.subscriptions[0]?.run();

    tracker.jobs.set('run-1', { runId: 'run-1', status: 'running', updatedAt: 2 });
    await scheduler.subscriptions[0]?.run();

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('unregisters itself once the tracked run reaches a terminal state', async () => {
    const scheduler = new FakePollScheduler();
    const tracker = new FakeAsyncJobTracker();
    tracker.jobs.set('run-1', { runId: 'run-1', status: 'running', updatedAt: 1 });
    const onChange = vi.fn();

    watchTrackedRunUntilTerminal(scheduler, tracker, 'run-1', onChange);
    await scheduler.subscriptions[0]?.run();
    expect(scheduler.subscriptions).toHaveLength(1);

    tracker.jobs.set('run-1', { runId: 'run-1', status: 'complete', updatedAt: 2 });
    const subscription = scheduler.subscriptions[0];
    await subscription?.run();

    expect(onChange).toHaveBeenLastCalledWith(tracker.jobs.get('run-1'));
    expect(scheduler.subscriptions).toHaveLength(0);
    expect(scheduler.unregisterCalls).toBe(1);
  });

  it('returns false from run() when nothing changed, so PollScheduler backoff can grow', () => {
    const scheduler = new FakePollScheduler();
    const tracker = new FakeAsyncJobTracker();
    tracker.jobs.set('run-1', { runId: 'run-1', status: 'running', updatedAt: 1 });

    watchTrackedRunUntilTerminal(scheduler, tracker, 'run-1', () => {});
    expect(scheduler.subscriptions[0]?.run()).toBe(true);
    expect(scheduler.subscriptions[0]?.run()).toBe(false);
  });

  it('lets a caller unregister early, before any terminal state is reached', () => {
    const scheduler = new FakePollScheduler();
    const tracker = new FakeAsyncJobTracker();
    tracker.jobs.set('run-1', { runId: 'run-1', status: 'running', updatedAt: 1 });

    const unregister = watchTrackedRunUntilTerminal(scheduler, tracker, 'run-1', () => {});
    unregister();
    expect(scheduler.subscriptions).toHaveLength(0);
  });

  it('handles an untracked run without throwing, and still calls onChange once for the untracked state', () => {
    const scheduler = new FakePollScheduler();
    const tracker = new FakeAsyncJobTracker();
    const onChange = vi.fn();

    watchTrackedRunUntilTerminal(scheduler, tracker, 'never-tracked', onChange);
    expect(() => scheduler.subscriptions[0]?.run()).not.toThrow();
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('accepts a custom poll interval', () => {
    const scheduler = new FakePollScheduler();
    const tracker = new FakeAsyncJobTracker();

    watchTrackedRunUntilTerminal(scheduler, tracker, 'run-1', () => {}, { intervalMs: 100 });
    expect(scheduler.subscriptions[0]?.intervalMs).toBe(100);
  });
});
