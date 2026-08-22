import { describe, expect, it, vi } from 'vitest';

import { NativeTeamChannelService } from '../../src/adapters/intercom/nativeTeamChannel';
import { createTeamPromptRuntime } from '../../src/adapters/pi/promptRuntime';
import { createTeamExtensionRuntime } from '../../src/adapters/pi/teamRuntime';
import { PollScheduler } from '../../src/adapters/pollScheduler';
import { SubagentToolService } from '../../src/adapters/pi/extensions/subagentTool';
import { AgentDiscoveryService } from '../../src/adapters/agents/discovery';
import { RunnerBootstrap } from '../../src/adapters/runs/background/runnerBootstrap';
import { RunnerExecution } from '../../src/adapters/runs/background/runnerExecution';

describe('explicit Team runtime composition', () => {
  it('builds the parent services once and forwards the concurrency reporter', () => {
    const reportConcurrencyEvent = vi.fn();
    const runtime = createTeamExtensionRuntime(reportConcurrencyEvent);

    expect(runtime.pollScheduler).toBeInstanceOf(PollScheduler);
    expect(runtime.discovery).toBeInstanceOf(AgentDiscoveryService);
    expect(runtime.teamChannel).toBeInstanceOf(NativeTeamChannelService);
    expect(runtime.subagentTool).toBeInstanceOf(SubagentToolService);
    expect(runtime.reportConcurrencyEvent).toBe(reportConcurrencyEvent);
    expect(Object.isFrozen(runtime)).toBe(true);
  });

  it('creates a fresh parent graph for every Cordis adapter fiber', () => {
    const first = createTeamExtensionRuntime();
    const second = createTeamExtensionRuntime();

    expect(second).not.toBe(first);
    expect(second.pollScheduler).not.toBe(first.pollScheduler);
    expect(second.discovery).not.toBe(first.discovery);
    expect(second.teamChannel).not.toBe(first.teamChannel);
  });

  it('builds the child runner graph without the parent tool surface', () => {
    const runtime = createTeamPromptRuntime();

    expect(runtime.pollScheduler).toBeInstanceOf(PollScheduler);
    expect(runtime.bootstrap).toBeInstanceOf(RunnerBootstrap);
    expect(runtime.execution).toBeInstanceOf(RunnerExecution);
    expect(runtime.teamChannel).toBeInstanceOf(NativeTeamChannelService);
    expect('subagentTool' in runtime).toBe(false);
    expect('discovery' in runtime).toBe(false);
    expect(Object.isFrozen(runtime)).toBe(true);
  });

  it('creates a fresh child graph for every spawned Pi runtime', () => {
    const first = createTeamPromptRuntime();
    const second = createTeamPromptRuntime();

    expect(second).not.toBe(first);
    expect(second.pollScheduler).not.toBe(first.pollScheduler);
    expect(second.reporting).not.toBe(first.reporting);
    expect(second.teamChannel).not.toBe(first.teamChannel);
  });
});
