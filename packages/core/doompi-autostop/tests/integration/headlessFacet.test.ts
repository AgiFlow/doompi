import {
  DOOM_BACKGROUND_WORK_SERVICE,
  type BackgroundWorkItem,
  type DoomBackgroundWorkService,
} from '@agimon-ai/doompi-core/background-work';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHook,
  type DoomHeadlessHostService,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_AUTO_STOP_DELAYS } from '../../src/exports';
import { autoStopServerFacet as autoStopHeadlessFacet } from '../../src/extensions/server';

async function fixture(
  states: Array<{ hasPendingMessages: boolean; isIdle: boolean }>,
  backgroundWork?: DoomBackgroundWorkService,
) {
  const hooks: DoomHeadlessHook[] = [];
  const shutdown = vi.fn();
  const activity = vi.fn(async () => states.shift() ?? { hasPendingMessages: false, isIdle: true });
  const execution = {
    cwd: '/repo',
    repoRoot: '/repo',
    sessionId: 'autostop-test',
    environment: {},
    selection: { majorMode: 'development', activeLayers: [], domains: [], state: {} },
    client: { notify: vi.fn(), request: vi.fn(), setStatus: vi.fn() },
    session: {
      entries: () => [],
      appendCustomEntry: vi.fn(),
      prompt: vi.fn(),
      abort: vi.fn(),
      compact: vi.fn(),
      activity,
    },
    shutdown,
  } as DoomHeadlessExecutionContext;
  const host = {
    context: execution,
    registerHook: (hook: DoomHeadlessHook) => {
      hooks.push(hook);
      return { dispose: vi.fn() };
    },
  } as unknown as DoomHeadlessHostService;
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, { scope: 'session' });
  context.provide(DOOM_HEADLESS_HOST_SERVICE, host);
  if (backgroundWork) context.provide(DOOM_BACKGROUND_WORK_SERVICE, backgroundWork);
  const dispose = await autoStopHeadlessFacet.apply(context);
  const hook = <E extends DoomHeadlessHook['event']>(event: E): Extract<DoomHeadlessHook, { event: E }> => {
    const found = hooks.find((candidate) => candidate.event === event);
    if (!found) throw new Error(`Missing ${event} hook`);
    return found as Extract<DoomHeadlessHook, { event: E }>;
  };
  return { activity, dispose, execution, hook, shutdown };
}

describe('headless auto-stop activity checks', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('cancels a pending cooldown when the server plugin is disposed', async () => {
    const test = await fixture([{ hasPendingMessages: false, isIdle: true }]);
    await test.hook('agent_settled').handle({}, test.execution);
    expect(vi.getTimerCount()).toBe(1);
    await test.dispose?.();
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(test.shutdown).not.toHaveBeenCalled();
  });

  it('cancels a scheduled shutdown when a new run starts', async () => {
    const test = await fixture([{ hasPendingMessages: false, isIdle: true }]);
    await test.hook('agent_settled').handle({}, test.execution);
    await test.hook('agent_start').handle({}, test.execution);
    await vi.runAllTimersAsync();
    expect(test.shutdown).not.toHaveBeenCalled();
    await test.dispose?.();
  });

  it('stands down when queued work appears during the cooldown', async () => {
    const test = await fixture([
      { hasPendingMessages: false, isIdle: true },
      { hasPendingMessages: true, isIdle: false },
    ]);
    await test.hook('agent_settled').handle({}, test.execution);
    await vi.runAllTimersAsync();
    expect(test.shutdown).not.toHaveBeenCalled();
    expect(test.activity).toHaveBeenCalledTimes(2);
    await test.dispose?.();
  });

  it('rechecks an active lane and shuts down only after it becomes idle', async () => {
    const test = await fixture([
      { hasPendingMessages: false, isIdle: true },
      { hasPendingMessages: false, isIdle: false },
      { hasPendingMessages: false, isIdle: true },
    ]);
    await test.hook('agent_settled').handle({}, test.execution);
    await vi.runAllTimersAsync();
    expect(test.shutdown).toHaveBeenCalledTimes(1);
    expect(test.activity).toHaveBeenCalledTimes(3);
    await test.dispose?.();
  });

  it('waits for headless runners and agents before shutting down', async () => {
    let items: BackgroundWorkItem[] = [
      { provider: 'doom-runner', id: 'runner-1', sessionId: 'autostop-test' },
      { provider: 'team-direct-runs', id: 'agent-1', sessionId: 'autostop-test' },
    ];
    const backgroundWork = {
      generation: 'headless-autostop-test',
      register: vi.fn(),
      snapshot: (sessionId?: string) => ({
        items: items.filter((item) => sessionId === undefined || item.sessionId === sessionId),
        errors: [],
      }),
    } as unknown as DoomBackgroundWorkService;
    const test = await fixture([{ hasPendingMessages: false, isIdle: true }], backgroundWork);

    await test.hook('agent_settled').handle({}, test.execution);
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTO_STOP_DELAYS.cooldownMs);
    expect(test.shutdown).not.toHaveBeenCalled();

    items = items.filter((item) => item.provider !== 'doom-runner');
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTO_STOP_DELAYS.cooldownMs);
    expect(test.shutdown).not.toHaveBeenCalled();

    items = [];
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTO_STOP_DELAYS.cooldownMs);
    expect(test.shutdown).toHaveBeenCalledTimes(1);
    await test.dispose?.();
  });

  it('does not arm shutdown when work is already queued at settle', async () => {
    const test = await fixture([{ hasPendingMessages: true, isIdle: true }]);
    await test.hook('agent_settled').handle({}, test.execution);
    await vi.runAllTimersAsync();
    expect(test.shutdown).not.toHaveBeenCalled();
    expect(test.activity).toHaveBeenCalledTimes(1);
    await test.dispose?.();
  });

  it('uses authoritative activity when the session tree changes during cooldown', async () => {
    const idle = await fixture([
      { hasPendingMessages: false, isIdle: true },
      { hasPendingMessages: false, isIdle: true },
    ]);
    await idle.hook('agent_settled').handle({}, idle.execution);
    await idle.hook('session_tree').handle({}, idle.execution);
    expect(idle.shutdown).toHaveBeenCalledTimes(1);
    await idle.hook('agent_start').handle({}, idle.execution);
    await idle.dispose?.();

    const queued = await fixture([
      { hasPendingMessages: false, isIdle: true },
      { hasPendingMessages: true, isIdle: false },
    ]);
    await queued.hook('agent_settled').handle({}, queued.execution);
    await queued.hook('session_tree').handle({}, queued.execution);
    await vi.runAllTimersAsync();
    expect(queued.shutdown).not.toHaveBeenCalled();
    await queued.dispose?.();

    const active = await fixture([
      { hasPendingMessages: false, isIdle: true },
      { hasPendingMessages: false, isIdle: false },
    ]);
    await active.hook('agent_settled').handle({}, active.execution);
    await active.hook('session_tree').handle({}, active.execution);
    await active.hook('agent_start').handle({}, active.execution);
    await vi.runAllTimersAsync();
    expect(active.shutdown).not.toHaveBeenCalled();
    await active.dispose?.();
  });
});
