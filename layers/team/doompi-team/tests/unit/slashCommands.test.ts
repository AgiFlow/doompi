import * as fs from 'node:fs';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import type { AgentConfig, AgentDiscoveryContract } from '../../src/adapters/agents/types';
import type { ExtensionConfig } from '../../src/adapters/pi/extensions/config';
import type {
  SpawnPlannerContract,
  SpawnPlanRequest,
  SpawnPlanResult,
} from '../../src/adapters/pi/extensions/spawnPlan';
import type { AsyncJobTrackerContract, TrackedAsyncJob } from '../../src/adapters/asyncJobTracker';
import type { PollSchedulerContract, PollSubscription } from '../../src/adapters/pollScheduler';
import {
  registerSlashCommands,
  type SlashCommandDeps,
  startSingleAgentRun,
} from '../../src/adapters/pi/commands/slash/slashCommands';

interface FakeHost {
  pi: ExtensionAPI;
  messages: Array<{ customType?: string; content?: unknown; display?: unknown; details?: unknown }>;
  commands: Map<string, { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
}

function makeHost(): FakeHost {
  const messages: FakeHost['messages'] = [];
  const commands: FakeHost['commands'] = new Map();
  const pi = {
    sendMessage: (message: unknown) => messages.push(message as FakeHost['messages'][number]),
    registerCommand: (name: string, definition: unknown) =>
      commands.set(name, definition as FakeHost['commands'] extends Map<string, infer V> ? V : never),
  } as unknown as ExtensionAPI;
  return { pi, messages, commands };
}

interface FakeCtx {
  ctx: ExtensionContext;
  notifications: Array<{ message: string; kind: string }>;
  statuses: Array<string | undefined>;
}

function makeCtx(hasUI = true): FakeCtx {
  const notifications: FakeCtx['notifications'] = [];
  const statuses: FakeCtx['statuses'] = [];
  const ctx = {
    cwd: '/work',
    hasUI,
    modelRegistry: {
      getAvailable: () => [],
      hasConfiguredAuth: () => false,
    },
    sessionManager: {
      getSessionFile: () => '/sessions/session-under-test.jsonl',
      getSessionId: () => 'session-under-test',
    },
    ui: {
      notify: (message: string, kind: string) => notifications.push({ message, kind }),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
    },
  } as unknown as ExtensionContext;
  return { ctx, notifications, statuses };
}

function agent(name: string): AgentConfig {
  return {
    name,
    description: name,
    systemPrompt: '',
    source: 'project',
    filePath: `/agents/${name}.md`,
    systemPromptMode: 'append',
    inheritProjectContext: true,
    inheritSkills: true,
  };
}

class FakeDiscovery implements AgentDiscoveryContract {
  agents: AgentConfig[] = [agent('worker'), agent('planner'), agent('scout')];
  discover() {
    return { agents: this.agents, projectAgentsDir: null };
  }
  find(_cwd: string, _scope: unknown, name: string) {
    return this.agents.find((a) => a.name === name);
  }
  invalidate() {}
}

class FakeSpawnPlanner implements SpawnPlannerContract {
  spawnCalls: SpawnPlanRequest[] = [];
  spawnResult: SpawnPlanResult = { outcomes: [] };

  async spawn(request: SpawnPlanRequest): Promise<SpawnPlanResult> {
    this.spawnCalls.push(request);
    return this.spawnResult;
  }
}

class FakeAsyncJobTracker implements AsyncJobTrackerContract {
  tracked: string[] = [];
  jobs = new Map<string, TrackedAsyncJob>();
  forSession() {
    return this;
  }
  track(runId: string) {
    this.tracked.push(runId);
  }
  untrack(runId: string) {
    this.jobs.delete(runId);
  }
  list() {
    return [...this.jobs.values()];
  }
  get(runId: string) {
    return this.jobs.get(runId);
  }
  reset() {
    this.jobs.clear();
  }
  start() {}
  stop() {}
}

class FakePollScheduler implements PollSchedulerContract {
  subscriptions: PollSubscription[] = [];
  register(subscription: PollSubscription): () => void {
    this.subscriptions.push(subscription);
    return () => {
      this.subscriptions = this.subscriptions.filter((s) => s !== subscription);
    };
  }
  wake() {}
  start() {}
  stop() {}
}

function makeDeps(overrides: Partial<SlashCommandDeps> = {}): {
  deps: SlashCommandDeps;
  spawnPlanner: FakeSpawnPlanner;
  tracker: FakeAsyncJobTracker;
  scheduler: FakePollScheduler;
  discovery: FakeDiscovery;
} {
  const spawnPlanner = new FakeSpawnPlanner();
  const tracker = new FakeAsyncJobTracker();
  const scheduler = new FakePollScheduler();
  const discovery = new FakeDiscovery();
  const config: ExtensionConfig = {};
  // `skills` and `management` are only reached by /subagents-doctor and
  // /subagents-stop respectively; the tests that exercise those pass real
  // fakes through `overrides`. Every other command must not touch them, and
  // a stub that throws on use is what keeps that honest.
  const unusedByThisCommand = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`Unexpected dependency access: ${String(property)}`);
      },
    },
  );
  return {
    deps: {
      spawnPlanner,
      tracker,
      scheduler,
      discovery,
      skills: unusedByThisCommand as SlashCommandDeps['skills'],
      management: unusedByThisCommand as SlashCommandDeps['management'],
      loadConfig: () => config,
      ...overrides,
    },
    spawnPlanner,
    tracker,
    scheduler,
    discovery,
  };
}

function register(
  host: FakeHost,
  state: { baseCwd: string | undefined } = { baseCwd: '/work' },
  deps?: ReturnType<typeof makeDeps>,
) {
  const resolved = deps ?? makeDeps();
  registerSlashCommands(host.pi, state, resolved.deps);
  return resolved;
}

describe('registerSlashCommands', () => {
  it('registers run and parallel', () => {
    const host = makeHost();
    register(host);
    expect(host.commands.has('run')).toBe(true);
    expect(host.commands.has('parallel')).toBe(true);
  });

  it('no longer registers chain, which the package does not implement', () => {
    const host = makeHost();
    register(host);
    expect(host.commands.has('chain')).toBe(false);
  });
});

describe('startSingleAgentRun', () => {
  it('spawns and reports a started run for a caller that cannot await it', async () => {
    const host = makeHost();
    const deps = makeDeps();
    deps.spawnPlanner.spawnResult = {
      outcomes: [{ agent: 'worker', task: 'do the thing', childIndex: 0, runId: 'run-1' }],
    };
    const { ctx } = makeCtx();

    startSingleAgentRun(host.pi, ctx, { baseCwd: '/work' }, deps.deps, { agent: 'worker', task: 'do the thing' });
    await vi.waitFor(() => expect(deps.tracker.tracked).toEqual(['run-1']));

    expect(deps.spawnPlanner.spawnCalls[0]?.single).toMatchObject({ agent: 'worker', task: 'do the thing' });
    expect(host.messages[0]?.content).toContain('worker (run-1)');
  });

  it('notifies a validation failure itself, since the caller has already closed', async () => {
    const host = makeHost();
    const deps = makeDeps();
    const { ctx, notifications } = makeCtx();

    startSingleAgentRun(host.pi, ctx, { baseCwd: '/work' }, deps.deps, { agent: 'nonexistent', task: 'do it' });

    await vi.waitFor(() => expect(notifications[0]?.message).toBe('Unknown agent: nonexistent'));
    expect(deps.spawnPlanner.spawnCalls).toHaveLength(0);
  });
});

describe('/run', () => {
  it('rejects empty input without spawning', async () => {
    const host = makeHost();
    const { spawnPlanner } = register(host);
    const { ctx, notifications } = makeCtx();

    await host.commands.get('run')?.handler('', ctx);

    expect(spawnPlanner.spawnCalls).toHaveLength(0);
    expect(notifications[0]?.message).toContain('Usage');
  });

  it('rejects an unknown agent without spawning', async () => {
    const host = makeHost();
    const { spawnPlanner } = register(host);
    const { ctx, notifications } = makeCtx();

    await host.commands.get('run')?.handler('nonexistent do the thing', ctx);

    expect(spawnPlanner.spawnCalls).toHaveLength(0);
    expect(notifications[0]?.message).toBe('Unknown agent: nonexistent');
  });

  it('spawns a SINGLE request for a known agent, tracks the result, and sends a started message', async () => {
    const host = makeHost();
    const { spawnPlanner, tracker } = register(host);
    spawnPlanner.spawnResult = { outcomes: [{ agent: 'worker', task: 'do the thing', childIndex: 0, runId: 'run-1' }] };
    const { ctx } = makeCtx();

    await host.commands.get('run')?.handler('worker do the thing', ctx);

    expect(spawnPlanner.spawnCalls[0]?.single).toMatchObject({ agent: 'worker', task: 'do the thing' });
    expect(tracker.tracked).toEqual(['run-1']);
    expect(host.messages[0]?.content).toContain('worker (run-1)');
    // The renderer reads `details`; content stays the fallback for a reader
    // without one (see `slashRunNotice.ts`).
    expect(host.messages[0]?.details).toEqual([{ agent: 'worker', runId: 'run-1', status: 'started' }]);
  });

  it('reports a not-yet-supported inline-config key as an error rather than spawning', async () => {
    const host = makeHost();
    const { spawnPlanner } = register(host);
    const { ctx, notifications } = makeCtx();

    await host.commands.get('run')?.handler('worker[skill=x] do the thing', ctx);

    expect(spawnPlanner.spawnCalls).toHaveLength(0);
    expect(notifications[0]?.message).toContain('not supported yet');
  });

  it('passes fork context with the settled parent leaf when --fork is given', async () => {
    const host = makeHost();
    const { spawnPlanner } = register(host);
    const { ctx } = makeCtx();
    const sessionFile = `/tmp/doom-team-slash-parent-${Math.random().toString(36).slice(2)}.jsonl`;
    fs.writeFileSync(sessionFile, '{}\n');
    const forkCtx = {
      ...ctx,
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => 'session-under-test',
        getLeafId: () => 'settled-leaf',
        getLeafEntry: () => ({
          type: 'message',
          id: 'settled-leaf',
          parentId: 'prior-leaf',
          message: { role: 'assistant', content: [] },
        }),
      },
    } as unknown as ExtensionContext;

    try {
      await host.commands.get('run')?.handler('worker do it --fork', forkCtx);
    } finally {
      fs.rmSync(sessionFile, { force: true });
    }

    expect(spawnPlanner.spawnCalls[0]).toMatchObject({
      single: { context: 'fork' },
      parentSessionId: 'session-under-test',
      parentSessionFile: sessionFile,
      parentLeafId: 'settled-leaf',
    });
  });

  it('notifies rather than throwing when a spawned outcome itself failed to start', async () => {
    const host = makeHost();
    const { spawnPlanner } = register(host);
    spawnPlanner.spawnResult = { outcomes: [{ agent: 'worker', task: 'x', childIndex: 0, error: 'boom' }] };
    const { ctx, notifications } = makeCtx();

    await host.commands.get('run')?.handler('worker do it', ctx);

    expect(notifications.some((n) => n.message.includes('boom'))).toBe(true);
  });

  it('notifies when baseCwd is not initialized', async () => {
    const host = makeHost();
    const { spawnPlanner } = register(host, { baseCwd: undefined });
    const { ctx, notifications } = makeCtx();

    await host.commands.get('run')?.handler('worker do it', ctx);

    expect(spawnPlanner.spawnCalls).toHaveLength(0);
    expect(notifications[0]?.message).toContain('not initialized');
  });
});

describe('/parallel', () => {
  it('spawns a PARALLEL request with every parsed task and tracks every started run', async () => {
    const host = makeHost();
    const { spawnPlanner, tracker } = register(host);
    spawnPlanner.spawnResult = {
      outcomes: [
        { agent: 'worker', task: 'a', childIndex: 0, runId: 'run-a' },
        { agent: 'planner', task: 'b', childIndex: 1, runId: 'run-b' },
      ],
    };
    const { ctx } = makeCtx();

    await host.commands.get('parallel')?.handler('worker "a" -> planner "b"', ctx);

    expect(spawnPlanner.spawnCalls[0]?.tasks).toHaveLength(2);
    expect(tracker.tracked).toEqual(['run-a', 'run-b']);
  });

  it('rejects when no step has a task', async () => {
    const host = makeHost();
    const { spawnPlanner } = register(host);
    const { ctx, notifications } = makeCtx();

    await host.commands.get('parallel')?.handler('worker -> planner', ctx);

    expect(spawnPlanner.spawnCalls).toHaveLength(0);
    expect(notifications[0]?.message).toContain('At least one step must have a task');
  });
});

describe('watchAndFinalize (indirectly, via a poll tick after /run)', () => {
  it('updates the status bar and finalizes the message once the tracked run reaches a terminal state', async () => {
    const host = makeHost();
    const { spawnPlanner, tracker, scheduler } = register(host);
    spawnPlanner.spawnResult = { outcomes: [{ agent: 'worker', task: 'x', childIndex: 0, runId: 'run-1' }] };
    const { ctx, statuses } = makeCtx();

    await host.commands.get('run')?.handler('worker do it', ctx);
    expect(scheduler.subscriptions).toHaveLength(1);

    tracker.jobs.set('run-1', { runId: 'run-1', status: 'running', updatedAt: 1 });
    await scheduler.subscriptions[0]?.run();
    expect(statuses.at(-1)).toContain('running');

    tracker.jobs.set('run-1', { runId: 'run-1', status: 'complete', updatedAt: 2 });
    await scheduler.subscriptions[0]?.run();

    expect(statuses.at(-1)).toBeUndefined();
    expect(scheduler.subscriptions).toHaveLength(0);
    expect(host.messages.at(-1)?.content).toContain('completed');
  });

  it('includes the run error in the finalized message when the terminal run failed', async () => {
    const host = makeHost();
    const { spawnPlanner, tracker, scheduler } = register(host);
    spawnPlanner.spawnResult = { outcomes: [{ agent: 'worker', task: 'x', childIndex: 0, runId: 'run-1' }] };
    const { ctx } = makeCtx();

    await host.commands.get('run')?.handler('worker do it', ctx);
    tracker.jobs.set('run-1', { runId: 'run-1', status: 'failed', updatedAt: 1, error: 'disk full' });
    await scheduler.subscriptions[0]?.run();

    expect(host.messages.at(-1)?.content).toContain('disk full');
  });
});

describe('/subagents-stop', () => {
  /** Records stop requests and can simulate an unresolvable id, which is what `ManagementActions.stop` throws for. */
  class FakeManagement {
    stopCalls: string[] = [];
    stopError: Error | undefined;

    stop(id: string): { requestPath: string } {
      if (this.stopError) throw this.stopError;
      this.stopCalls.push(id);
      return { requestPath: `/tmp/${id}/stop.json` };
    }
  }

  function registerWithManagement(host: FakeHost, management: FakeManagement) {
    const resolved = makeDeps({ management: management as unknown as SlashCommandDeps['management'] });
    resolved.tracker.jobs.set('run-1', { runId: 'run-1', status: 'running' });
    registerSlashCommands(host.pi, { baseCwd: '/work' }, resolved.deps);
    return resolved;
  }

  it('is registered', () => {
    const host = makeHost();
    register(host);

    expect(host.commands.has('subagents-stop')).toBe(true);
  });

  it('requests a stop for an explicit run id', async () => {
    const host = makeHost();
    const management = new FakeManagement();
    registerWithManagement(host, management);
    const { ctx } = makeCtx();

    await host.commands.get('subagents-stop')?.handler('run-1', ctx);

    expect(management.stopCalls).toEqual(['run-1']);
  });

  /**
   * Stop is asynchronous here: the request is a file the child claims on a
   * later tick. Reporting "stopped" would assert something this process has
   * not observed, so the wording must stay a request, not an outcome.
   */
  it('reports the stop as requested, not as completed', async () => {
    const host = makeHost();
    const management = new FakeManagement();
    registerWithManagement(host, management);
    const { ctx, notifications } = makeCtx();

    await host.commands.get('subagents-stop')?.handler('run-1', ctx);

    expect(notifications.at(-1)?.message).toContain('Stop requested');
    // Phrased as a pending request whose outcome the RUN reports, never as a
    // completed one this process witnessed.
    expect(notifications.at(-1)?.message).toContain('acknowledges');
  });

  it('surfaces an unresolvable id as an error instead of silently doing nothing', async () => {
    const host = makeHost();
    const management = new FakeManagement();
    management.stopError = new Error("No active run found for 'nope'.");
    registerWithManagement(host, management);
    const { ctx, notifications } = makeCtx();

    await host.commands.get('subagents-stop')?.handler('nope', ctx);

    expect(notifications.at(-1)?.message).toContain('No current-session run found');
  });

  it('lists the runs that can be stopped when given no id', async () => {
    const host = makeHost();
    const management = new FakeManagement();
    const { tracker } = registerWithManagement(host, management);
    tracker.jobs.set('run-1', { runId: 'run-1', status: 'running', updatedAt: 1 });
    tracker.jobs.set('run-2', { runId: 'run-2', status: 'complete', updatedAt: 1 });
    const { ctx } = makeCtx();

    await host.commands.get('subagents-stop')?.handler('', ctx);

    const listing = host.messages.at(-1)?.content ?? '';
    expect(listing).toContain('run-1');
    expect(listing).not.toContain('run-2'); // already terminal, nothing to stop
    expect(management.stopCalls).toHaveLength(0);
  });

  it('says so plainly when nothing is running', async () => {
    const host = makeHost();
    const { tracker } = registerWithManagement(host, new FakeManagement());
    tracker.jobs.clear();
    const { ctx } = makeCtx();

    await host.commands.get('subagents-stop')?.handler('', ctx);

    expect(host.messages.at(-1)?.content).toContain('No running subagents');
  });
});
