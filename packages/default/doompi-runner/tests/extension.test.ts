import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupLegacyRunnerStore, reconcileActiveRunners } from '../src/exports/reconcile';
import { formatRunnerFooterContribution, formatRunnerStatus } from '../src/tui/format.ts';
import {
  activeRunnerRecovery,
  appendActiveRunnersToSummary,
  registerRunnerCompactionRecovery,
} from '../src/exports/compaction';
import type { RunnerRecord } from '../src/types/runnerRegistry';

beforeEach(() => {
  vi.clearAllMocks();
});

const active: RunnerRecord = {
  id: 'mep4hd3a-X7qP',
  name: 'api',
  pid: 42,
  command: 'pnpm dev',
  cwd: '/repo',
  logPath: '/logs/runner.log',
  interactive: false,
  sessionId: 'session-a',
  startedAt: '2026-08-03T00:00:00.000Z',
  state: 'running',
  promoted: true,
  backend: 'rmux',
  backendTarget: 'doom-runner-mep4hd3a-X7qP',
  hostPid: 1,
};

describe('runner footer status', () => {
  it('shows a compact active count with a static dot and hides zero', () => {
    expect(formatRunnerStatus(1)).toBe('Runners 1 ●');
    expect(formatRunnerStatus(0)).toBeUndefined();
    expect(formatRunnerFooterContribution(2)).toEqual({ fullText: 'Runner 2', compactText: 'R2' });
    expect(formatRunnerFooterContribution(0)).toBeUndefined();
  });
});

describe('runner reconciliation', () => {
  it('releases an active entry when completed metadata already exists', async () => {
    const completed = {
      ...active,
      state: 'completed' as const,
      exit: {
        reason: 'completed' as const,
        code: 0,
        signal: null,
        finishedAt: '2026-08-03T00:01:00.000Z',
      },
    };
    const release = vi.fn(async () => undefined);
    const list = vi.fn(async () => [active]);

    const result = await reconcileActiveRunners({
      registry: {
        list,
        get: vi.fn(async () => completed),
        release,
      } as never,
      launcher: { stop: vi.fn() } as never,
      rmuxBackend: { readOutcome: vi.fn(), stop: vi.fn() } as never,
      processControl: { isAlive: vi.fn(() => true) } as never,
      currentHostPid: 99,
      startup: false,
      active: [active],
    });

    expect(list).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(active.id);
    expect(result).toEqual({ reclaimed: [active.id], errors: [] });
  });

  it('completes a runner from retained RMUX exit metadata', async () => {
    const complete = vi.fn(async () => undefined);

    const result = await reconcileActiveRunners({
      registry: {
        list: vi.fn(async () => [active]),
        get: vi.fn(async () => active),
        complete,
      } as never,
      launcher: { stop: vi.fn() } as never,
      rmuxBackend: {
        readOutcome: vi.fn(() => ({ code: 0, signal: null })),
        stop: vi.fn(),
      } as never,
      processControl: { isAlive: vi.fn(() => true) } as never,
      currentHostPid: 99,
      startup: false,
    });

    expect(complete).toHaveBeenCalledWith(active.id, { reason: 'completed', code: 0, signal: null }, active.sessionId);
    expect(result.reclaimed).toEqual([active.id]);
  });

  it('stops and completes a runner whose owner process ended', async () => {
    const complete = vi.fn(async () => undefined);
    const stop = vi.fn(async () => true);

    const result = await reconcileActiveRunners({
      registry: {
        list: vi.fn(async () => [active]),
        get: vi.fn(async () => active),
        complete,
      } as never,
      launcher: { stop: vi.fn() } as never,
      rmuxBackend: { readOutcome: vi.fn(), stop } as never,
      processControl: { isAlive: vi.fn((pid: number) => pid === active.pid) } as never,
      currentHostPid: 99,
      startup: false,
    });

    expect(stop).toHaveBeenCalledWith(active.backendTarget, active.pid);
    expect(complete).toHaveBeenCalledWith(
      active.id,
      expect.objectContaining({ reason: 'stopped', stopReason: 'owner session ended' }),
      active.sessionId,
    );
    expect(result.reclaimed).toEqual([active.id]);
  });

  it('marks a dead native runner as backend lost', async () => {
    const native = { ...active, backend: 'native' as const, backendTarget: undefined };
    const complete = vi.fn(async () => undefined);

    const result = await reconcileActiveRunners({
      registry: { list: vi.fn(async () => [native]), get: vi.fn(async () => native), complete } as never,
      launcher: { stop: vi.fn() } as never,
      rmuxBackend: { readOutcome: vi.fn(), stop: vi.fn() } as never,
      processControl: { isAlive: vi.fn(() => false) } as never,
      currentHostPid: 99,
      startup: false,
    });

    expect(complete).toHaveBeenCalledWith(
      native.id,
      { reason: 'backend_lost', code: null, signal: null },
      native.sessionId,
    );
    expect(result.reclaimed).toEqual([native.id]);
  });

  it('leaves a live runner with a live owner active', async () => {
    const complete = vi.fn();
    const result = await reconcileActiveRunners({
      registry: { list: vi.fn(async () => [active]), get: vi.fn(async () => active), complete } as never,
      launcher: { stop: vi.fn() } as never,
      rmuxBackend: { readOutcome: vi.fn(), stop: vi.fn() } as never,
      processControl: { isAlive: vi.fn(() => true) } as never,
      currentHostPid: 99,
      startup: false,
    });

    expect(complete).not.toHaveBeenCalled();
    expect(result).toEqual({ reclaimed: [], errors: [] });
  });

  it.each([
    [{ code: 2, signal: null }, 'failed'],
    [{ code: null, signal: 'SIGTERM' as const }, 'signaled'],
  ])('records non-success RMUX outcomes', async (outcome, reason) => {
    const complete = vi.fn(async () => undefined);
    await reconcileActiveRunners({
      registry: { list: vi.fn(async () => [active]), get: vi.fn(async () => active), complete } as never,
      launcher: { stop: vi.fn() } as never,
      rmuxBackend: { readOutcome: vi.fn(() => outcome), stop: vi.fn() } as never,
      processControl: { isAlive: vi.fn(() => true) } as never,
      currentHostPid: 99,
      startup: false,
    });

    expect(complete).toHaveBeenCalledWith(active.id, expect.objectContaining({ reason }), active.sessionId);
  });

  it('keeps an orphan active when both stop backends fail', async () => {
    const complete = vi.fn();
    const launcherStop = vi.fn(async () => false);
    const result = await reconcileActiveRunners({
      registry: { list: vi.fn(async () => [active]), get: vi.fn(async () => active), complete } as never,
      launcher: { stop: launcherStop } as never,
      rmuxBackend: { readOutcome: vi.fn(), stop: vi.fn(async () => false) } as never,
      processControl: { isAlive: vi.fn((pid: number) => pid === active.pid) } as never,
      currentHostPid: 99,
      startup: false,
    });

    expect(launcherStop).toHaveBeenCalledWith(active.pid);
    expect(complete).not.toHaveBeenCalled();
    expect(result.errors[0]).toContain('Could not stop orphaned runner');
  });

  it('stops a native runner left by the previous runtime on startup', async () => {
    const native = { ...active, backend: 'native' as const, backendTarget: undefined, hostPid: 99 };
    const complete = vi.fn(async () => undefined);
    const stop = vi.fn(async () => true);
    const result = await reconcileActiveRunners({
      registry: { list: vi.fn(async () => [native]), get: vi.fn(async () => native), complete } as never,
      launcher: { stop } as never,
      rmuxBackend: { readOutcome: vi.fn(), stop: vi.fn() } as never,
      processControl: { isAlive: vi.fn(() => true) } as never,
      currentHostPid: 99,
      startup: true,
    });

    expect(stop).toHaveBeenCalledWith(native.pid);
    expect(result.reclaimed).toEqual([native.id]);
  });

  it('reports a registry reconciliation error and continues', async () => {
    const result = await reconcileActiveRunners({
      registry: {
        list: vi.fn(async () => [active]),
        get: vi.fn(async () => Promise.reject(new Error('locked'))),
      } as never,
      launcher: { stop: vi.fn() } as never,
      rmuxBackend: { readOutcome: vi.fn(), stop: vi.fn() } as never,
      processControl: { isAlive: vi.fn() } as never,
      currentHostPid: 99,
      startup: false,
    });

    expect(result.errors[0]).toContain('locked');
  });
});

describe('legacy runner cleanup', () => {
  it('does nothing when there is no legacy store', async () => {
    const result = await cleanupLegacyRunnerStore({
      registry: {} as never,
      launcher: {} as never,
      rmuxBackend: {} as never,
      processControl: {} as never,
      currentHostPid: 99,
      paths: { legacyDirectory: () => undefined } as never,
    });

    expect(result).toEqual({ reclaimed: [], errors: [] });
  });

  it('defers deletion while a foreign live runner uses the legacy store', async () => {
    const legacy = { ...active, logPath: '/repo/.git/doom-runner/logs/api.log' };
    const removeLegacyStore = vi.fn();
    const result = await cleanupLegacyRunnerStore({
      registry: {
        list: vi.fn(async () => [legacy]),
        listAcrossRepositories: vi.fn(async () => [legacy]),
        release: vi.fn(),
      } as never,
      launcher: { stop: vi.fn() } as never,
      rmuxBackend: { stop: vi.fn() } as never,
      processControl: { isAlive: vi.fn(() => true) } as never,
      currentHostPid: 99,
      paths: { legacyDirectory: () => '/repo/.git/doom-runner', removeLegacyStore } as never,
    });

    expect(removeLegacyStore).not.toHaveBeenCalled();
    expect(result).toEqual({ reclaimed: [], errors: [] });
  });

  it('releases dead legacy entries before deleting the store', async () => {
    const legacy = { ...active, logPath: '/repo/.git/doom-runner/logs/api.log' };
    const list = vi.fn(async () => [legacy]);
    const release = vi.fn(async () => undefined);
    const result = await cleanupLegacyRunnerStore({
      registry: { list, listAcrossRepositories: vi.fn(async () => []), release } as never,
      launcher: { stop: vi.fn() } as never,
      rmuxBackend: { stop: vi.fn() } as never,
      processControl: { isAlive: vi.fn(() => false) } as never,
      currentHostPid: 99,
      paths: {
        legacyDirectory: () => '/repo/.git/doom-runner',
        removeLegacyStore: () => '/repo/.git/doom-runner',
      } as never,
    });

    expect(release).toHaveBeenCalledWith(legacy.id);
    expect(result).toEqual({ reclaimed: [legacy.id], errors: [], removed: '/repo/.git/doom-runner' });
  });

  it('keeps a live legacy entry when it cannot be stopped', async () => {
    const legacy = { ...active, hostPid: 99, logPath: '/repo/.git/doom-runner/logs/api.log' };
    const result = await cleanupLegacyRunnerStore({
      registry: {
        list: vi.fn(async () => [legacy]),
        listAcrossRepositories: vi.fn(async () => [legacy]),
        release: vi.fn(),
      } as never,
      launcher: { stop: vi.fn(async () => false) } as never,
      rmuxBackend: { stop: vi.fn(async () => false) } as never,
      processControl: { isAlive: vi.fn(() => true) } as never,
      currentHostPid: 99,
      paths: {
        legacyDirectory: () => '/repo/.git/doom-runner',
        removeLegacyStore: vi.fn(),
      } as never,
    });

    expect(result.errors[0]).toContain('Could not stop legacy runner');
    expect(result.reclaimed).toEqual([]);
  });

  it('reports a failure while releasing a legacy entry', async () => {
    const legacy = { ...active, logPath: '/repo/.git/doom-runner/logs/api.log' };
    const result = await cleanupLegacyRunnerStore({
      registry: {
        list: vi.fn(async () => [legacy]),
        listAcrossRepositories: vi.fn(async () => []),
        release: vi.fn(async () => Promise.reject(new Error('registry locked'))),
      } as never,
      launcher: { stop: vi.fn() } as never,
      rmuxBackend: { stop: vi.fn() } as never,
      processControl: { isAlive: vi.fn(() => false) } as never,
      currentHostPid: 99,
      paths: { legacyDirectory: () => '/repo/.git/doom-runner', removeLegacyStore: vi.fn() } as never,
    });

    expect(result.errors[0]).toContain('registry locked');
  });
});

describe('compaction runner recovery', () => {
  it('adds active runner IDs, logs, and steering commands to a summary', () => {
    const summary = appendActiveRunnersToSummary('Work in progress.', [active]);

    expect(summary).toContain('api (mep4hd3a-X7qP)');
    expect(summary).toContain('/logs/runner.log');
    expect(summary).toContain('doom-runner status mep4hd3a-X7qP');
    expect(summary).toContain('doom-runner logs mep4hd3a-X7qP --follow');
  });

  it('does not duplicate runner recovery text', () => {
    const once = appendActiveRunnersToSummary('Work in progress.', [active]);
    expect(appendActiveRunnersToSummary(once, [active])).toBe(once);
  });

  it('leaves a summary unchanged when no runner is active', () => {
    expect(appendActiveRunnersToSummary('Work in progress.', [])).toBe('Work in progress.');
    expect(activeRunnerRecovery([])).toBe('');
  });

  it('injects session-owned active runner recovery after every compaction event', async () => {
    let handler: (() => Promise<void>) | undefined;
    const sendMessage = vi.fn();
    const pi = {
      on: vi.fn((event: string, registered: () => Promise<void>) => {
        if (event === 'session_compact') handler = registered;
      }),
      sendMessage,
    } as unknown as ExtensionAPI;
    const listBySession = vi.fn(async () => [active]);

    registerRunnerCompactionRecovery(pi, {
      getSessionId: () => 'session-a',
      listBySession,
    });
    await handler?.();

    expect(listBySession).toHaveBeenCalledWith('session-a');
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: 'doom-runner-compaction',
        content: expect.stringContaining('api (mep4hd3a-X7qP)'),
        display: false,
        details: { sessionId: 'session-a', runnerIds: ['mep4hd3a-X7qP'] },
      }),
      { triggerTurn: false, deliverAs: 'steer' },
    );
  });

  it('does not block compaction when runner recovery cannot read the registry', async () => {
    let handler: (() => Promise<void>) | undefined;
    const sendMessage = vi.fn();
    const pi = {
      on: vi.fn((_event: string, registered: () => Promise<void>) => {
        handler = registered;
      }),
      sendMessage,
    } as unknown as ExtensionAPI;

    registerRunnerCompactionRecovery(pi, {
      getSessionId: () => 'session-a',
      listBySession: vi.fn(async () => Promise.reject(new Error('registry unavailable'))),
    });

    await expect(handler?.()).resolves.toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not inject runner context without a session or active runner', async () => {
    const handlers: Array<() => Promise<void>> = [];
    const sendMessage = vi.fn();
    const pi = {
      on: vi.fn((_event: string, handler: () => Promise<void>) => handlers.push(handler)),
      sendMessage,
    } as unknown as ExtensionAPI;
    const dependencies = { getSessionId: () => undefined, listBySession: vi.fn(async () => []) };

    registerRunnerCompactionRecovery(pi, dependencies);
    await handlers[0]?.();
    expect(dependencies.listBySession).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
