import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';

import { SUBAGENT_RUN_ID_ENV } from '../../src/exports/env';
import {
  registerRunnerLifecycle,
  type RunnerLifecycleRuntime,
} from '../../src/adapters/pi/extensions/subagentPromptRuntime';
import type { PollSchedulerContract, PollSubscription } from '../../src/adapters/pollScheduler';
import type {
  RunnerBootstrapContract,
  RunnerBootstrapResult,
} from '../../src/adapters/runs/background/runnerBootstrap';
import type {
  RunnerExecutionContract,
  RunnerExecutionHandlers,
} from '../../src/adapters/runs/background/runnerExecution';
import type { ActivityState } from '../../src/types';
import type { RunnerReportingContract } from '../../src/adapters/runs/background/runnerReporting';

/**
 * `registerRunnerLifecycle` is what makes a spawned child report anything at
 * all: it starts the poll scheduler, records the child's transcript path,
 * bootstraps the run (status file, handshake, team membership), opens the
 * control channel for steer/stop/interrupt, and completes the run on
 * `agent_end`.
 *
 * It had no direct coverage: the suites that exercised it were deleted with the
 * deliverable guard, whose write side used to live in the same function. These
 * tests cover only what survived.
 */

class FakeScheduler implements PollSchedulerContract {
  startCalls = 0;
  register(_subscription: PollSubscription): () => void {
    return () => {};
  }
  wake(): void {}
  start(): void {
    this.startCalls += 1;
  }
  stop(): void {}
}

class FakeBootstrap implements RunnerBootstrapContract {
  calls: Array<{ runId: string; sessionFile?: string }> = [];
  result: RunnerBootstrapResult = {
    runId: 'run-1',
    launchConfig: {} as RunnerBootstrapResult['launchConfig'],
    teamContext: undefined,
  };
  bootstrap(runId: string, sessionFile?: string): RunnerBootstrapResult {
    this.calls.push({ runId, ...(sessionFile ? { sessionFile } : {}) });
    return this.result;
  }
}

class FakeExecution implements RunnerExecutionContract {
  startCalls: Array<{ runId: string; handlers?: RunnerExecutionHandlers }> = [];
  completeCalls: Array<{ success: boolean; summary: string }> = [];
  activities: ActivityState[] = [];
  progresses: Array<{ tokens?: number; currentTool?: string; toolCount?: number }> = [];
  start(runId: string, handlers?: RunnerExecutionHandlers): () => void {
    this.startCalls.push({ runId, handlers });
    return () => {};
  }
  setActivity(activity: ActivityState): void {
    this.activities.push(activity);
  }
  setProgress(progress: { tokens?: number; currentTool?: string; toolCount?: number }): void {
    this.progresses.push(progress);
  }
  complete(success: boolean, summary: string): void {
    this.completeCalls.push({ success, summary });
  }
}

class FakeReporting implements Partial<RunnerReportingContract> {
  sessionFiles: string[] = [];
  recordSessionFile(file: string): string {
    this.sessionFiles.push(file);
    return file;
  }
}

interface Fakes {
  scheduler: FakeScheduler;
  bootstrap: FakeBootstrap;
  execution: FakeExecution;
  reporting: FakeReporting;
}

function fakeRuntime(fakes: Fakes): RunnerLifecycleRuntime {
  return {
    pollScheduler: fakes.scheduler,
    bootstrap: fakes.bootstrap,
    execution: fakes.execution,
    reporting: fakes.reporting as Pick<RunnerReportingContract, 'recordSessionFile'>,
  };
}

/** Captures handlers so a test can fire a lifecycle event directly. */
function fakePi(): { pi: ExtensionAPI; fire: (event: string, payload?: unknown, ctx?: ExtensionContext) => void } {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    fire(event, payload = {}, ctx = fakeContext()) {
      handlers.get(event)?.(payload, ctx);
    },
  };
}

/**
 * Takes the value directly rather than defaulting it: `fakeContext(undefined)`
 * against a default parameter would silently produce the default, which is
 * exactly the case the no-transcript test needs to express.
 */
function contextWithSessionFile(sessionFile: string | undefined): ExtensionContext {
  return { sessionManager: { getSessionFile: () => sessionFile } } as unknown as ExtensionContext;
}

function fakeContext(): ExtensionContext {
  return contextWithSessionFile('/tmp/child.jsonl');
}

function makeFakes(): Fakes {
  return {
    scheduler: new FakeScheduler(),
    bootstrap: new FakeBootstrap(),
    execution: new FakeExecution(),
    reporting: new FakeReporting(),
  };
}

const savedRunId = process.env[SUBAGENT_RUN_ID_ENV];

afterEach(() => {
  if (savedRunId === undefined) delete process.env[SUBAGENT_RUN_ID_ENV];
  else process.env[SUBAGENT_RUN_ID_ENV] = savedRunId;
});

describe('registerRunnerLifecycle', () => {
  it('does nothing outside a spawned child, where there is no run to report on', () => {
    delete process.env[SUBAGENT_RUN_ID_ENV];
    const fakes = makeFakes();
    const host = fakePi();

    registerRunnerLifecycle(host.pi, fakeRuntime(fakes));
    host.fire('session_start');

    expect(fakes.bootstrap.calls).toEqual([]);
    expect(fakes.scheduler.startCalls).toBe(0);
  });

  it('bootstraps the run and opens the control channel on session_start', () => {
    process.env[SUBAGENT_RUN_ID_ENV] = 'run-1';
    const fakes = makeFakes();
    const host = fakePi();

    registerRunnerLifecycle(host.pi, fakeRuntime(fakes));
    host.fire('session_start');

    expect(fakes.scheduler.startCalls).toBe(1);
    expect(fakes.bootstrap.calls).toEqual([{ runId: 'run-1', sessionFile: '/tmp/child.jsonl' }]);
    expect(fakes.execution.startCalls[0]?.runId).toBe('run-1');
    // Without an onSteer handler the control channel claims a steer request
    // and then silently drops it before it reaches the child.
    expect(fakes.execution.startCalls[0]?.handlers?.onSteer).toBeTypeOf('function');
  });

  it("records the child's own transcript, which is what a later restore reopens", () => {
    process.env[SUBAGENT_RUN_ID_ENV] = 'run-1';
    const fakes = makeFakes();
    const host = fakePi();

    registerRunnerLifecycle(host.pi, fakeRuntime(fakes));
    host.fire('session_start');

    expect(fakes.reporting.sessionFiles).toEqual(['/tmp/child.jsonl']);
  });

  it('records nothing when the child has no persisted transcript, rather than a placeholder', () => {
    process.env[SUBAGENT_RUN_ID_ENV] = 'run-1';
    const fakes = makeFakes();
    const host = fakePi();

    registerRunnerLifecycle(host.pi, fakeRuntime(fakes));
    host.fire('session_start', {}, contextWithSessionFile(undefined));

    expect(fakes.reporting.sessionFiles).toEqual([]);
  });

  it('bootstraps once, so a second session_start does not restart the run', () => {
    process.env[SUBAGENT_RUN_ID_ENV] = 'run-1';
    const fakes = makeFakes();
    const host = fakePi();

    registerRunnerLifecycle(host.pi, fakeRuntime(fakes));
    host.fire('session_start');
    host.fire('session_start');

    expect(fakes.bootstrap.calls).toEqual([{ runId: 'run-1', sessionFile: '/tmp/child.jsonl' }]);
    expect(fakes.execution.startCalls).toHaveLength(1);
  });

  it('reports canonical total tokens once and streams a live activity trail', () => {
    process.env[SUBAGENT_RUN_ID_ENV] = 'run-1';
    const fakes = makeFakes();
    const host = fakePi();
    registerRunnerLifecycle(host.pi, fakeRuntime(fakes));

    const message = {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Tracing the task state transition' }],
      usage: { totalTokens: 37, input: 1000, output: 2000, cacheRead: 3000, cacheWrite: 4000 },
    };
    host.fire('message_end', { message });
    host.fire('session_start');
    host.fire('message_update', { message });
    host.fire('message_end', { message });
    host.fire('message_end', { message });
    host.fire('tool_execution_start', { toolName: 'Read', args: { path: 'src/task.ts' } });
    host.fire('tool_execution_end', { toolName: 'Read' });

    expect(fakes.execution.progresses).toEqual([
      { currentTool: 'working: Tracing the task state transition' },
      { tokens: 37 },
      { toolCount: 1, currentTool: 'Read (src/task.ts)' },
      { currentTool: 'working' },
    ]);
  });

  it('does not count usage attached to a tool result as model tokens', () => {
    process.env[SUBAGENT_RUN_ID_ENV] = 'run-1';
    const fakes = makeFakes();
    const host = fakePi();
    registerRunnerLifecycle(host.pi, fakeRuntime(fakes));
    host.fire('session_start');

    host.fire('message_end', { message: { role: 'toolResult', usage: { totalTokens: 500 } } });

    expect(fakes.execution.progresses).toEqual([]);
  });

  it("completes the run on agent_end with the assistant's final text", () => {
    process.env[SUBAGENT_RUN_ID_ENV] = 'run-1';
    const fakes = makeFakes();
    const host = fakePi();

    registerRunnerLifecycle(host.pi, fakeRuntime(fakes));
    host.fire('session_start');
    host.fire('agent_end', { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'all done' }] }] });

    expect(fakes.execution.completeCalls).toEqual([{ success: true, summary: 'all done' }]);
  });

  it('does not complete a run that never bootstrapped, which would report on nothing', () => {
    process.env[SUBAGENT_RUN_ID_ENV] = 'run-1';
    const fakes = makeFakes();
    const host = fakePi();

    registerRunnerLifecycle(host.pi, fakeRuntime(fakes));
    host.fire('agent_end', { messages: [] });

    expect(fakes.execution.completeCalls).toEqual([]);
  });
});
