import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { readDoomBackgroundWorkService } from '@agimon-ai/doompi-extension-contracts/background-work';
import {
  DOOM_DELEGATION_FINISHED_EVENT,
  DOOM_DELEGATION_STARTED_EVENT,
  type DelegationResult,
  readDoomDelegationService,
} from '@agimon-ai/doompi-extension-contracts/delegation';
import {
  DOOM_CORDIS_SESSION_SERVICE,
  type DoomCordisSessionService,
} from '@agimon-ai/doompi-extension-contracts/cordis-host';
import {
  createDoomReadinessCoordinator,
  DOOM_READINESS_SERVICE,
  type DoomReadinessCoordinator,
} from '@agimon-ai/doompi-extension-contracts/readiness';
import { readDoomSubagentPolicyService } from '@agimon-ai/doompi-extension-contracts/subagent-policy';
import { subscribeTelemetryRecords } from '@agimon-ai/doompi-telemetry';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installTeamRuntime } from '../../src/adapters/pi/extension';
import {
  clearCurrentSessionScope,
  setCurrentSessionScope,
  tryCurrentSessionScope,
} from '../../src/adapters/filesystem/paths';
import * as scopeOwner from '../../src/adapters/scopeOwner';

const PACKAGE_SOURCE = '@agimon-ai/doompi-team';
type RegisteredTool = Parameters<ExtensionAPI['registerTool']>[0];

/**
 * The parent composition root. Every assertion here is about REACHABILITY:
 * whether activating this extension leaves a session with working tools,
 * commands, renderers and running background services.
 *
 * WHY THAT IS THE BAR:
 * Every service this file wires was already built and unit-tested in
 * isolation, and every one of them was still unreachable - no caller existed.
 * A test that only proved the services work would have passed throughout that
 * entire period. So these tests assert against a REAL container
 * (`createExtensionContainer()`, built by the activation itself), with only
 * the host faked, rather than asserting that the root called some mock.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED:
 * Nothing here waits for a poll tick, a filesystem watch, or a spawned child.
 * Those are the timing-dependent shapes that make a suite fail because the
 * machine was busy. Activation is synchronous; asynchronous session startup
 * is awaited explicitly before lifecycle behavior is asserted.
 */

interface FakeHost {
  pi: ExtensionAPI;
  tools: string[];
  toolDefinitions: Map<string, RegisteredTool>;
  commands: string[];
  renderers: string[];
  handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
  context: unknown;
  fire: (event: string, ctx?: unknown) => void;
  fireAsync: (event: string, ctx?: unknown) => Promise<void>;
  readinessFor: (ctx?: unknown) => DoomReadinessCoordinator | undefined;
}

const activeHosts: FakeHost[] = [];
const activeRuntimes: Array<{
  pi: ExtensionAPI;
  cordis: Context;
  runtime: ReturnType<typeof installTeamRuntime>;
}> = [];
const activeReadinessBindings: Array<{
  coordinator: DoomReadinessCoordinator;
  fiber: { dispose(): Promise<void> };
  pi: ExtensionAPI;
}> = [];

interface TestSessionPluginConfig {
  readonly context: ExtensionContext;
  readonly coordinator: DoomReadinessCoordinator;
}

function testSessionPlugin(cordis: Context, { context, coordinator }: TestSessionPluginConfig): void {
  cordis.provide(
    DOOM_CORDIS_SESSION_SERVICE,
    Object.freeze({
      sessionId: context.sessionManager.getSessionId(),
      generation: `doom-team-test:${randomUUID()}`,
      reason: 'startup' as DoomCordisSessionService['reason'],
      context,
    }),
  );
  cordis.provide(DOOM_READINESS_SERVICE, coordinator);
  cordis.effect(() => () => coordinator.dispose(), `${PACKAGE_SOURCE}/test-readiness`);
}

function activateTeamForTest(pi: ExtensionAPI): ReturnType<typeof installTeamRuntime> {
  const cordis = new Context();
  const runtime = installTeamRuntime(cordis, pi);
  pi.on('session_shutdown', () => cordis.fiber.dispose());
  activeRuntimes.push({ pi, cordis, runtime });
  return runtime;
}

function runtimeFor(pi: ExtensionAPI): ReturnType<typeof installTeamRuntime> {
  const runtime = activeRuntimes.findLast((candidate) => candidate.pi === pi);
  if (!runtime) throw new Error('Expected the Team runtime to be active.');
  return runtime.runtime;
}

function cordisFor(pi: ExtensionAPI): Context {
  const active = activeRuntimes.findLast((candidate) => candidate.pi === pi);
  if (!active) throw new Error('Expected the Team Cordis root to be active.');
  return active.cordis;
}

function fakePi(): FakeHost {
  const tools: string[] = [];
  const toolDefinitions = new Map<string, RegisteredTool>();
  const commands: string[] = [];
  const renderers: string[] = [];
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const eventHandlers = new Map<string, Array<(value: unknown) => void>>();

  const pi = {
    registerTool: (tool: RegisteredTool) => {
      tools.push(tool.name);
      toolDefinitions.set(tool.name, tool);
    },
    getTool: (name: string) => toolDefinitions.get(name),
    registerCommand: (name: string) => {
      commands.push(name);
    },
    registerMessageRenderer: (customType: string) => {
      renderers.push(customType);
    },
    sendMessage: () => {},
    events: {
      emit: (event: string, value: unknown) => {
        for (const handler of eventHandlers.get(event) ?? []) handler(value);
      },
      on: (event: string, handler: (value: unknown) => void) => {
        const list = eventHandlers.get(event) ?? [];
        list.push(handler);
        eventHandlers.set(event, list);
        return () => {
          const current = eventHandlers.get(event) ?? [];
          eventHandlers.set(
            event,
            current.filter((candidate) => candidate !== handler),
          );
        };
      },
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: '/tmp',
    hasUI: false,
    doom: { leader: { register: () => () => undefined } },
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
    },
    modelRegistry: {
      getAvailable: () => [],
      hasConfiguredAuth: () => false,
    },
    sessionManager: {
      getSessionId: () => 'session-under-test',
      getSessionFile: () => undefined,
    },
  } as unknown as ExtensionContext;
  const readinessBySession = new WeakMap<object, DoomReadinessCoordinator>();
  const bindReadiness = async (context: ExtensionContext): Promise<void> => {
    const activeRuntime = activeRuntimes.findLast((candidate) => candidate.pi === pi);
    if (!activeRuntime) return;
    const previousBinding = activeReadinessBindings.findLast((candidate) => candidate.pi === pi);
    if (previousBinding) {
      await previousBinding.fiber.dispose();
      activeReadinessBindings.splice(activeReadinessBindings.indexOf(previousBinding), 1);
    }
    if (activeRuntime.cordis.get(DOOM_READINESS_SERVICE)) return;
    const coordinator = createDoomReadinessCoordinator();
    const fiber = activeRuntime.cordis.plugin(testSessionPlugin, { context, coordinator });
    await fiber;
    readinessBySession.set(context.sessionManager, coordinator);
    activeReadinessBindings.push({ coordinator, fiber, pi });
  };
  const fire = (event: string, override?: unknown): void => {
    const context = (override ?? ctx) as ExtensionContext;
    for (const handler of handlers.get(event) ?? []) handler({}, context);
  };
  const fireAsync = async (event: string, override?: unknown): Promise<void> => {
    const context = (override ?? ctx) as ExtensionContext;
    if (event === 'session_start') await bindReadiness(context);
    for (const handler of handlers.get(event) ?? []) await handler({}, context);
  };

  const host = {
    pi,
    tools,
    toolDefinitions,
    commands,
    renderers,
    handlers,
    context: ctx,
    fire,
    fireAsync,
    readinessFor: (context: unknown = ctx) => readinessBySession.get((context as ExtensionContext).sessionManager),
  };
  activeHosts.push(host);
  return host;
}

async function waitForTeamReadiness(host: FakeHost, context: unknown = host.context): Promise<void> {
  await vi.waitFor(
    () => {
      const snapshot = host.readinessFor(context)?.read(PACKAGE_SOURCE);
      expect(snapshot?.state).toBe('ready');
    },
    { timeout: 2_000 },
  );
}

function deferredScopeOwner(): {
  readonly promise: Promise<scopeOwner.ScopeOwnerRecord>;
  readonly resolve: () => void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<scopeOwner.ScopeOwnerRecord>((settle) => {
    resolve = () =>
      settle({ version: 1, rootSessionId: 'session-under-test', hostPid: process.pid, startedAt: Date.now() });
  });
  return { promise, resolve };
}

function resetRuntimeState(): void {
  if (activeRuntimes.length > 0) throw new Error('A prior Team test did not release its runtime.');
}

afterEach(async () => {
  for (const host of activeHosts.splice(0)) await host.fireAsync('session_shutdown');
  for (const runtime of activeRuntimes.splice(0)) await runtime.cordis.fiber.dispose();
  for (const binding of activeReadinessBindings.splice(0)) {
    await binding.fiber.dispose();
  }
  vi.restoreAllMocks();
});

describe('Team standard runtime', () => {
  it('registers the subagent tool, so a session can actually spawn', () => {
    resetRuntimeState();
    const host = fakePi();

    activateTeamForTest(host.pi);

    expect(host.tools).toContain('subagent');
    expect(host.tools).not.toContain('subagent_wait');
  });

  it('registers exactly the two Doom Team model-facing tools', () => {
    resetRuntimeState();
    const host = fakePi();

    activateTeamForTest(host.pi);

    expect(host.tools.toSorted((left, right) => left.localeCompare(right))).toEqual(['intercom', 'subagent']);
  });

  it('registers the catalog and fleet commands', () => {
    resetRuntimeState();
    const host = fakePi();

    activateTeamForTest(host.pi);

    expect(host.commands).toContain('subagents-list');
    expect(host.commands).toContain('subagents-fleet');
  });

  it('registers slash commands beyond the fleet command', () => {
    resetRuntimeState();
    const host = fakePi();

    activateTeamForTest(host.pi);

    expect(host.commands.length).toBeGreaterThan(1);
  });

  it('registers the completion renderer, so a finished run renders as more than raw markdown', () => {
    resetRuntimeState();
    const host = fakePi();

    activateTeamForTest(host.pi);

    expect(host.renderers).toContain('subagent-notify');
  });

  /**
   * The host imports and ACTIVATES every extension before it fires
   * `session_start`, so activation runs with no session scope at all. That is
   * not a hypothetical: activation used to call `ResultWatcher.start()`, which
   * reads `currentRunsDir()`, and every `pi` launch died on
   * "No session scope is set" before the TUI appeared.
   *
   * Nothing else in this suite can catch that, because `tests/setup.ts` sets a
   * worker-wide scope so the scoped path helpers work in unit tests. These two
   * cases clear it on purpose, and MUST restore it - the scope is per worker,
   * not per test, so leaking an unset one breaks every file that runs after.
   */
  it('activates with no session scope set, as the host does before session_start', async () => {
    resetRuntimeState();
    const host = fakePi();
    const previous = tryCurrentSessionScope();
    clearCurrentSessionScope();

    try {
      expect(() => activateTeamForTest(host.pi)).not.toThrow();
      await expect(host.fireAsync('session_start')).resolves.toBeUndefined();
      await waitForTeamReadiness(host);
    } finally {
      if (previous) setCurrentSessionScope(previous);
    }
  });

  it('activates with no scope while stale team environment is still set', () => {
    resetRuntimeState();
    const host = fakePi();
    const previous = tryCurrentSessionScope();
    // A parent puts these on its OWN process.env when it binds as team member
    // `main` (`applyNativeTeamRootEnvironment`), and they outlive an extension
    // reload. `registerClient` runs at activation and used to resolve a scoped
    // team directory just to decide it was not a child.
    const rootSessionId = 'stale-root-session';
    // Same derivation as the package's private `teamIdForSession`. Duplicated
    // because the guard bails early on a team id that does not match the root
    // session, and this case is only meaningful once it gets past that.
    const teamId = `session-${createHash('sha256').update(rootSessionId).digest('hex').slice(0, 32)}`;
    process.env.PI_SUBAGENT_TEAM_ID = teamId;
    process.env.PI_SUBAGENT_TEAM_ROOT_SESSION = rootSessionId;
    process.env.PI_SUBAGENT_TEAM_MAIN_MEMBER = 'main';
    clearCurrentSessionScope();

    try {
      expect(() => activateTeamForTest(host.pi)).not.toThrow();
    } finally {
      delete process.env.PI_SUBAGENT_TEAM_ID;
      delete process.env.PI_SUBAGENT_TEAM_ROOT_SESSION;
      delete process.env.PI_SUBAGENT_TEAM_MAIN_MEMBER;
      if (previous) setCurrentSessionScope(previous);
    }
  });

  it('subscribes to session_start and session_shutdown', () => {
    resetRuntimeState();
    const host = fakePi();

    activateTeamForTest(host.pi);

    expect(host.handlers.has('session_start')).toBe(true);
    expect(host.handlers.has('session_shutdown')).toBe(true);
  });

  it('binds main intercom membership against the host session id', async () => {
    resetRuntimeState();
    const host = fakePi();
    activateTeamForTest(host.pi);

    // Main membership is created only once a session id exists, so binding is
    // driven from session_start rather than activation.
    await expect(host.fireAsync('session_start')).resolves.toBeUndefined();
    await waitForTeamReadiness(host);
  });

  it('returns from session_start while scope restoration continues under package readiness', async () => {
    resetRuntimeState();
    const host = fakePi();
    const scopeWrite = deferredScopeOwner();
    const writeScopeOwner = vi.spyOn(scopeOwner, 'writeScopeOwnerAsync').mockReturnValueOnce(scopeWrite.promise);
    activateTeamForTest(host.pi);

    await expect(host.fireAsync('session_start')).resolves.toBeUndefined();
    await vi.waitFor(() => expect(writeScopeOwner).toHaveBeenCalledOnce());

    expect(host.readinessFor()?.read(PACKAGE_SOURCE)?.state).toBe('pending');
    scopeWrite.resolve();
    await waitForTeamReadiness(host);
  });

  it('publishes readiness through the active host-owned Cordis session', async () => {
    resetRuntimeState();
    const host = fakePi();
    const context = host.context as ExtensionContext;
    const cordis = new Context();
    const coordinator = createDoomReadinessCoordinator();
    cordis.provide(DOOM_READINESS_SERVICE, coordinator);
    cordis.provide(
      DOOM_CORDIS_SESSION_SERVICE,
      Object.freeze({
        sessionId: context.sessionManager.getSessionId(),
        generation: 'doom-team-test:1',
        reason: 'startup' as DoomCordisSessionService['reason'],
        context,
      }),
    );
    const runtime = installTeamRuntime(cordis, host.pi);
    host.pi.on('session_shutdown', () => cordis.fiber.dispose());
    activeRuntimes.push({ pi: host.pi, cordis, runtime });
    await cordis.fiber.await();

    await host.fireAsync('session_start');
    await vi.waitFor(() => expect(coordinator.read(PACKAGE_SOURCE)?.state).toBe('ready'));

    expect(host.readinessFor()?.read(PACKAGE_SOURCE)).toBeUndefined();
  });

  it('registers tools immediately but waits for Team readiness before executing them', async () => {
    resetRuntimeState();
    const host = fakePi();
    const scopeWrite = deferredScopeOwner();
    vi.spyOn(scopeOwner, 'writeScopeOwnerAsync').mockReturnValueOnce(scopeWrite.promise);
    activateTeamForTest(host.pi);
    await host.fireAsync('session_start');
    const tool = host.toolDefinitions.get('subagent');
    if (!tool) throw new Error('Expected the subagent tool to be registered synchronously.');

    let settled = false;
    const execution = tool.execute(
      'readiness-call',
      { action: 'agents' },
      undefined,
      undefined,
      host.context as ExtensionContext,
    );
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    scopeWrite.resolve();
    await waitForTeamReadiness(host);
    await expect(execution).resolves.toEqual(expect.objectContaining({ content: expect.any(Array) }));
  });

  it('routes concurrency events through the session-owned telemetry lifecycle', async () => {
    resetRuntimeState();
    const host = fakePi();
    const events: string[] = [];
    const unsubscribe = subscribeTelemetryRecords((record) => events.push(record.event));
    activateTeamForTest(host.pi);
    const runtime = runtimeFor(host.pi);

    try {
      await host.fireAsync('session_start');
      const report = runtime.reportConcurrencyEvent;
      report('doom_team.concurrency_started', { 'team.task_count': 2 });

      expect(events).toContain('doom_team.concurrency_started');
    } finally {
      unsubscribe();
    }
  });

  it('keeps each Pi session in its own tracked fleet', async () => {
    resetRuntimeState();
    const host = fakePi();
    activateTeamForTest(host.pi);
    const runtime = runtimeFor(host.pi);
    const tracker = runtime.asyncJobTracker;

    await host.fireAsync('session_start');
    await waitForTeamReadiness(host);
    const firstSession = tracker.forSession('session-under-test');
    firstSession.track('run-from-first-session');
    expect(firstSession.list().map((job) => job.runId)).toEqual(['run-from-first-session']);

    const secondContext = {
      modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => false },
      cwd: '/tmp',
      hasUI: false,
      ui: { notify: () => undefined, setStatus: () => undefined },
      sessionManager: {
        getSessionId: () => 'second-session',
        getSessionFile: () => undefined,
      },
    };
    await host.fireAsync('session_start', secondContext);
    await waitForTeamReadiness(host, secondContext);

    expect(tracker.forSession('second-session').list()).toEqual([]);
    expect(firstSession.list().map((job) => job.runId)).toEqual(['run-from-first-session']);
  });

  it('publishes direct runs for the exact active session and invalidates on tracker changes', async () => {
    resetRuntimeState();
    const host = fakePi();
    activateTeamForTest(host.pi);
    const tracker = runtimeFor(host.pi).asyncJobTracker;
    const cordis = cordisFor(host.pi);
    const invalidations: string[] = [];
    cordis.on('doom/background-work/changed', (event) => invalidations.push(event.kind));

    await host.fireAsync('session_start');
    await waitForTeamReadiness(host);
    const service = readDoomBackgroundWorkService(cordis);
    if (!service) throw new Error('Expected Team to provide doom/background-work.');

    tracker.forSession('other-session').track('other-run');
    tracker.forSession('session-under-test').track('direct-run');

    expect(service.snapshot()).toEqual({
      items: [{ provider: 'team-direct-runs', id: 'direct-run', sessionId: 'session-under-test' }],
      errors: [],
    });
    expect(invalidations).toContain('updated');
  });
  it('serves the typed delegation lifecycle through the session Cordis service', async () => {
    resetRuntimeState();
    const host = fakePi();
    activateTeamForTest(host.pi);
    const runtime = runtimeFor(host.pi);

    const planner = runtime.spawnPlanner;
    const waiter = runtime.subagentWaiter;
    const management = runtime.management;
    vi.spyOn(planner, 'spawn').mockResolvedValue({
      outcomes: [{ agent: 'explorer', task: 'Inspect the package', childIndex: 0, runId: 'run-1', pid: 42 }],
    });
    vi.spyOn(waiter, 'wait').mockResolvedValue({ reason: 'completed', elapsedMs: 12, runs: [] });
    vi.spyOn(management, 'status').mockReturnValue({
      runId: 'run-1',
      runDir: '/tmp/run-1',
      claimed: false,
      status: {
        runId: 'run-1',
        agent: 'explorer',
        state: 'completed',
        startedAt: 10,
        lastUpdate: 20,
        endedAt: 22,
        nudgeTarget: { kind: 'none' },
        summary: 'Inspection complete.',
      },
    } as never);

    const parentSessionFile = `/tmp/doom-team-delegation-parent-${Math.random().toString(36).slice(2)}.jsonl`;
    fs.writeFileSync(parentSessionFile, '{}\n');
    const delegationContext = {
      ...(host.context as object),
      sessionManager: {
        getSessionId: () => 'session-under-test',
        getSessionFile: () => parentSessionFile,
        getLeafId: () => 'active-assistant',
        getLeafEntry: () => ({
          type: 'message',
          id: 'active-assistant',
          parentId: 'safe-user-leaf',
          message: { role: 'assistant', content: [] },
        }),
      },
    };
    await host.fireAsync('session_start', delegationContext);
    await waitForTeamReadiness(host, delegationContext);
    const cordis = cordisFor(host.pi);
    const service = readDoomDelegationService(cordis);
    if (!service) throw new Error('Expected Team to provide doom/delegation.');
    const started: string[] = [];
    const finished: DelegationResult[] = [];
    const disposeStarted = cordis.on(DOOM_DELEGATION_STARTED_EVENT, (payload) => {
      started.push(payload.runId);
    });
    const disposeFinished = cordis.on(DOOM_DELEGATION_FINISHED_EVENT, (payload) => {
      finished.push(payload);
    });

    await service.request({
      requestId: 'request-1',
      taskId: 'task-1',
      agent: 'explorer',
      inlineAgent: { systemPrompt: 'Inspect without writing.' },
      prompt: 'Inspect the package',
      cwd: '/tmp',
    });

    expect(started).toEqual(['run-1']);
    expect(finished).toEqual([
      expect.objectContaining({
        requestId: 'request-1',
        runId: 'run-1',
        status: 'completed',
        output: 'Inspection complete.',
        durationMs: 12,
      }),
    ]);
    expect(planner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        single: expect.objectContaining({
          agent: 'explorer',
          inlineAgent: { systemPrompt: 'Inspect without writing.' },
        }),
      }),
      expect.any(Object),
    );
    expect(planner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'session-under-test',
        parentSessionFile,
        parentLeafId: 'safe-user-leaf',
      }),
      expect.any(Object),
    );

    fs.rmSync(parentSessionFile, { force: true });
    disposeStarted();
    disposeFinished();
  });

  it('resolves the fork source when the transcript is persisted after the session binds', async () => {
    resetRuntimeState();
    const host = fakePi();
    activateTeamForTest(host.pi);
    const runtime = runtimeFor(host.pi);

    const planner = runtime.spawnPlanner;
    vi.spyOn(planner, 'spawn').mockResolvedValue({
      outcomes: [{ agent: 'explorer', task: 'Inspect the package', childIndex: 0, runId: 'run-1', pid: 42 }],
    });
    vi.spyOn(runtime.subagentWaiter, 'wait').mockResolvedValue({ reason: 'completed', elapsedMs: 12, runs: [] });

    // Pi does not write a transcript until the session's first assistant message,
    // so this path is absent while the session binds and appears before the tool
    // call that issues the delegation.
    const parentSessionFile = `/tmp/doom-team-late-parent-${Math.random().toString(36).slice(2)}.jsonl`;
    const delegationContext = {
      ...(host.context as object),
      sessionManager: {
        getSessionId: () => 'session-under-test',
        getSessionFile: () => parentSessionFile,
        getLeafId: () => 'active-assistant',
        getLeafEntry: () => ({
          type: 'message',
          id: 'active-assistant',
          parentId: 'safe-user-leaf',
          message: { role: 'assistant', content: [] },
        }),
      },
    };
    await host.fireAsync('session_start', delegationContext);
    await waitForTeamReadiness(host, delegationContext);

    fs.writeFileSync(parentSessionFile, '{}\n');

    const service = readDoomDelegationService(cordisFor(host.pi));
    if (!service) throw new Error('Expected Team to provide doom/delegation.');
    await service.request({
      requestId: 'request-1',
      taskId: 'task-1',
      agent: 'explorer',
      inlineAgent: { systemPrompt: 'Inspect without writing.' },
      prompt: 'Inspect the package',
      cwd: '/tmp',
      context: 'fork',
    });

    expect(planner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ parentSessionFile, parentLeafId: 'safe-user-leaf' }),
      expect.any(Object),
    );

    fs.rmSync(parentSessionFile, { force: true });
  });

  it('follows the session leaf as it moves between delegation requests', async () => {
    resetRuntimeState();
    const host = fakePi();
    activateTeamForTest(host.pi);
    const runtime = runtimeFor(host.pi);

    const planner = runtime.spawnPlanner;
    const spawn = vi.spyOn(planner, 'spawn').mockResolvedValue({
      outcomes: [{ agent: 'explorer', task: 'Inspect the package', childIndex: 0, runId: 'run-1', pid: 42 }],
    });
    vi.spyOn(runtime.subagentWaiter, 'wait').mockResolvedValue({ reason: 'completed', elapsedMs: 12, runs: [] });

    const parentSessionFile = `/tmp/doom-team-moving-parent-${Math.random().toString(36).slice(2)}.jsonl`;
    fs.writeFileSync(parentSessionFile, '{}\n');
    let settledLeaf = 'first-user-leaf';
    const delegationContext = {
      ...(host.context as object),
      sessionManager: {
        getSessionId: () => 'session-under-test',
        getSessionFile: () => parentSessionFile,
        getLeafId: () => 'active-assistant',
        getLeafEntry: () => ({
          type: 'message',
          id: 'active-assistant',
          parentId: settledLeaf,
          message: { role: 'assistant', content: [] },
        }),
      },
    };
    await host.fireAsync('session_start', delegationContext);
    await waitForTeamReadiness(host, delegationContext);

    const service = readDoomDelegationService(cordisFor(host.pi));
    if (!service) throw new Error('Expected Team to provide doom/delegation.');
    const requestFork = async (requestId: string): Promise<void> => {
      await service.request({
        requestId,
        taskId: 'task-1',
        agent: 'explorer',
        inlineAgent: { systemPrompt: 'Inspect without writing.' },
        prompt: 'Inspect the package',
        cwd: '/tmp',
        context: 'fork',
      });
    };

    await requestFork('request-1');
    settledLeaf = 'later-user-leaf';
    await requestFork('request-2');

    expect(spawn.mock.calls.map(([request]) => (request as { parentLeafId?: string }).parentLeafId)).toEqual([
      'first-user-leaf',
      'later-user-leaf',
    ]);

    fs.rmSync(parentSessionFile, { force: true });
  });

  it('collects typed subagent policies for every central spawn path', async () => {
    resetRuntimeState();
    const host = fakePi();
    activateTeamForTest(host.pi);
    const runtime = runtimeFor(host.pi);
    const policies = runtime.capabilityPolicies;
    await host.fireAsync('session_start');
    await waitForTeamReadiness(host);
    const service = readDoomSubagentPolicyService(cordisFor(host.pi));
    if (!service) throw new Error('Expected Team to provide doom/subagent-policy.');
    const handle = service.register({
      owner: '@agimon-ai/doompi-plan',
      allowedTools: ['read', 'grep'],
      denyExtensions: true,
    });

    expect(policies.resolve()).toEqual({
      version: 2,
      allowedTools: ['grep', 'read'],
      allowedExternalProfiles: [],
      denyExtensions: true,
      sources: ['@agimon-ai/doompi-plan'],
    });
    handle.dispose();
    expect(policies.resolve()).toBeUndefined();
  });

  it('creates a fresh package-local container after Pi replaces the runtime', async () => {
    resetRuntimeState();
    const firstHost = fakePi();
    const firstContainer = activateTeamForTest(firstHost.pi);
    await firstHost.fireAsync('session_shutdown');

    const secondHost = fakePi();
    const secondContainer = activateTeamForTest(secondHost.pi);

    expect(secondContainer).not.toBe(firstContainer);
    expect(secondHost.commands).toEqual(expect.arrayContaining(['subagents-list', 'subagents-fleet']));
  });

  it('releases every Cordis-owned effect during session shutdown', async () => {
    resetRuntimeState();
    const host = fakePi();
    activateTeamForTest(host.pi);
    const runtime = activeRuntimes.find((candidate) => candidate.pi === host.pi);
    if (!runtime) throw new Error('Expected the Team runtime to be active.');

    await host.fireAsync('session_shutdown');

    expect(runtime.cordis.fiber.getEffects()).toEqual([]);
  });

  it('runs package cleanup only once when shutdown is delivered twice', async () => {
    resetRuntimeState();
    const host = fakePi();
    const runtime = activateTeamForTest(host.pi);
    const scheduler = runtime.pollScheduler;
    const stop = vi.spyOn(scheduler, 'stop');

    await host.fireAsync('session_shutdown');
    await expect(host.fireAsync('session_shutdown')).resolves.toBeUndefined();

    expect(stop).toHaveBeenCalledOnce();
  });
});
