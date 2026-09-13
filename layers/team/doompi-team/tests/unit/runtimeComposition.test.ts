import { describe, expect, it, vi } from 'vitest';

import { AgentDiscoveryService } from '../../src/services/agentDiscovery';
import { ExternalProcessIpc, type ExternalProcessEventListener } from '../../src/services/externalProcessIpc';
import { NativeTeamChannelService } from '../../src/services/nativeTeamChannel';
import { PollScheduler } from '../../src/services/pollScheduler';
import { createSessionScope } from '../../src/services/sessionPaths';
import { SubagentToolService } from '../../src/services/subagentTool';
import { createTeamExtensionRuntime } from '../../src/services/teamRuntime';

const ENVIRONMENT = Object.freeze({ PATH: '/test/bin' });

describe('explicit Team runtime composition', () => {
  it('builds the parent services once and forwards the concurrency reporter', () => {
    const reportConcurrencyEvent = vi.fn();
    const runtime = createTeamExtensionRuntime(reportConcurrencyEvent, { environment: ENVIRONMENT });

    expect(runtime.pollScheduler).toBeInstanceOf(PollScheduler);
    expect(runtime.discovery).toBeInstanceOf(AgentDiscoveryService);
    expect(runtime.teamChannel).toBeInstanceOf(NativeTeamChannelService);
    expect(runtime.subagentTool).toBeInstanceOf(SubagentToolService);
    expect(runtime.reportConcurrencyEvent).toBe(reportConcurrencyEvent);
    expect(Object.isFrozen(runtime)).toBe(true);
    runtime.dispose();
  });

  it('creates a fresh parent graph for every Cordis adapter fiber', () => {
    const first = createTeamExtensionRuntime(undefined, { environment: ENVIRONMENT });
    const second = createTeamExtensionRuntime(undefined, { environment: ENVIRONMENT });

    expect(second).not.toBe(first);
    expect(second.pollScheduler).not.toBe(first.pollScheduler);
    expect(second.discovery).not.toBe(first.discovery);
    expect(second.teamChannel).not.toBe(first.teamChannel);
    first.dispose();
    second.dispose();
  });

  it('routes external status, error, result, and exit events through the parent tracker', async () => {
    let listener: ExternalProcessEventListener | undefined;
    const subscribe = vi.spyOn(ExternalProcessIpc.prototype, 'subscribe').mockImplementation((callback) => {
      listener = callback;
      return () => undefined;
    });
    const runtime = createTeamExtensionRuntime(undefined, { environment: ENVIRONMENT });
    const scope = createSessionScope('runtime-events');
    const upsert = vi.spyOn(runtime.asyncJobTracker, 'upsertExternal');
    const fail = vi.spyOn(runtime.asyncJobTracker, 'markExternalFailed');
    const accept = vi.spyOn(runtime.asyncJobTracker, 'acceptExternalResult').mockReturnValue(true);
    const deliver = vi.spyOn(runtime.completionNotifier, 'deliver').mockResolvedValue(true);
    const acknowledge = vi.spyOn(runtime.asyncJobTracker, 'acknowledgeHandoff');
    const base = {
      channel: 'doompi-team-external',
      version: 1,
      direction: 'runner',
      runId: 'run-1',
      scopeKey: scope.scopeKey,
    } as const;
    try {
      listener!({
        scope,
        message: {
          ...base,
          kind: 'status',
          status: {
            runId: 'run-1',
            agent: 'writer',
            task: 'write',
            cwd: '/project',
            runtime: 'pi',
            state: 'running',
            startedAt: 1,
            updatedAt: 2,
          },
        },
      });
      expect(upsert).toHaveBeenCalledOnce();
      listener!({ scope, message: { ...base, kind: 'error', error: 'runner failed' } });
      expect(fail).toHaveBeenCalledWith(scope.rootSessionId, scope, 'run-1', 'runner failed');
      listener!({ scope, message: { ...base, kind: 'result', result: { summary: 'done' } } });
      expect(accept).toHaveBeenCalledOnce();
      expect(deliver).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2));
      listener!({ scope, runId: 'unknown', code: 1, signal: null });
    } finally {
      runtime.dispose();
      subscribe.mockRestore();
    }
  });
});
