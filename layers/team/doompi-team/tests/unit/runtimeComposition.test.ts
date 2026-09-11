import { describe, expect, it, vi } from 'vitest';
import { NativeTeamChannelService } from '../../src/adapters/intercom/nativeTeamChannel';
import { createTeamExtensionRuntime } from '../../src/adapters/pi/teamRuntime';
import { PollScheduler } from '../../src/adapters/pollScheduler';
import { SubagentToolService } from '../../src/adapters/pi/extensions/subagentTool';
import { AgentDiscoveryService } from '../../src/adapters/agents/discovery';

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
});
