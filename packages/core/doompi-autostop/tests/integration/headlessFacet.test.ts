import type { Context } from '@deepseek-ai/cordis';
import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessHook,
  DoomHeadlessHostService,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoStopHeadlessFacet } from '../../src/adapters/headless/facet.ts';

function fixture(states: Array<{ hasPendingMessages: boolean; isIdle: boolean }>) {
  const hooks: DoomHeadlessHook[] = [];
  const shutdown = vi.fn();
  const activity = vi.fn(async () => states.shift() ?? { hasPendingMessages: false, isIdle: true });
  const execution = {
    cwd: '/repo',
    repoRoot: '/repo',
    sessionId: 'autostop-test',
    environment: {},
    selection: { majorMode: 'development', activeLayers: [], domains: [], minorModes: [] },
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
  const dispose = autoStopHeadlessFacet.apply({ get: () => host } as unknown as Context);
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

  it('cancels a scheduled shutdown when a new run starts', async () => {
    const test = fixture([{ hasPendingMessages: false, isIdle: true }]);
    await test.hook('agent_settled').handle({}, test.execution);
    await test.hook('agent_start').handle({}, test.execution);
    await vi.runAllTimersAsync();
    expect(test.shutdown).not.toHaveBeenCalled();
    test.dispose();
  });

  it('stands down when queued work appears during the cooldown', async () => {
    const test = fixture([
      { hasPendingMessages: false, isIdle: true },
      { hasPendingMessages: true, isIdle: false },
    ]);
    await test.hook('agent_settled').handle({}, test.execution);
    await vi.runAllTimersAsync();
    expect(test.shutdown).not.toHaveBeenCalled();
    expect(test.activity).toHaveBeenCalledTimes(2);
    test.dispose();
  });

  it('rechecks an active lane and shuts down only after it becomes idle', async () => {
    const test = fixture([
      { hasPendingMessages: false, isIdle: true },
      { hasPendingMessages: false, isIdle: false },
      { hasPendingMessages: false, isIdle: true },
    ]);
    await test.hook('agent_settled').handle({}, test.execution);
    await vi.runAllTimersAsync();
    expect(test.shutdown).toHaveBeenCalledTimes(1);
    expect(test.activity).toHaveBeenCalledTimes(3);
    test.dispose();
  });

  it('does not arm shutdown when work is already queued at settle', async () => {
    const test = fixture([{ hasPendingMessages: true, isIdle: true }]);
    await test.hook('agent_settled').handle({}, test.execution);
    await vi.runAllTimersAsync();
    expect(test.shutdown).not.toHaveBeenCalled();
    expect(test.activity).toHaveBeenCalledTimes(1);
    test.dispose();
  });

  it('uses authoritative activity when the session tree changes during cooldown', async () => {
    const idle = fixture([
      { hasPendingMessages: false, isIdle: true },
      { hasPendingMessages: false, isIdle: true },
    ]);
    await idle.hook('agent_settled').handle({}, idle.execution);
    await idle.hook('session_tree').handle({}, idle.execution);
    expect(idle.shutdown).toHaveBeenCalledTimes(1);
    await idle.hook('agent_start').handle({}, idle.execution);
    idle.dispose();

    const queued = fixture([
      { hasPendingMessages: false, isIdle: true },
      { hasPendingMessages: true, isIdle: false },
    ]);
    await queued.hook('agent_settled').handle({}, queued.execution);
    await queued.hook('session_tree').handle({}, queued.execution);
    await vi.runAllTimersAsync();
    expect(queued.shutdown).not.toHaveBeenCalled();
    queued.dispose();

    const active = fixture([
      { hasPendingMessages: false, isIdle: true },
      { hasPendingMessages: false, isIdle: false },
    ]);
    await active.hook('agent_settled').handle({}, active.execution);
    await active.hook('session_tree').handle({}, active.execution);
    await active.hook('agent_start').handle({}, active.execution);
    await vi.runAllTimersAsync();
    expect(active.shutdown).not.toHaveBeenCalled();
    active.dispose();
  });
});
