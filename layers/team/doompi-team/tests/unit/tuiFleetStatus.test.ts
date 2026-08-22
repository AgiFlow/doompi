import { agentIdentityColor } from '@agimon-ai/doompi-ui/theme';
import { describe, expect, it, vi } from 'vitest';
import type { AsyncJobTrackerContract, TrackedAsyncJob } from '../../src/adapters/asyncJobTracker';
import {
  AGENT_PULSE_FRAMES,
  activeAgentCount,
  agentFleetStatus,
  agentStatusText,
  FLEET_STATUS_KEY,
  publishAgentStatus,
} from '../../src/adapters/pi/tui/fleetStatus';

class FakeTracker implements AsyncJobTrackerContract {
  forSession() {
    return this;
  }
  jobs: TrackedAsyncJob[] = [];
  track(): void {}
  untrack(): void {}
  list(): TrackedAsyncJob[] {
    return this.jobs;
  }
  get(runId: string): TrackedAsyncJob | undefined {
    return this.jobs.find((job) => job.runId === runId);
  }
  reset(): void {
    this.jobs = [];
  }
  start(): void {}
  stop(): void {}
}

describe('agent fleet status', () => {
  it('hides the group when no tracked agents exist', () => {
    const tracker = new FakeTracker();

    expect(activeAgentCount(tracker)).toBe(0);
    expect(agentStatusText(tracker)).toBeUndefined();
  });

  it('counts only non-terminal work and renders explicit lifecycle glyphs', () => {
    const tracker = new FakeTracker();
    tracker.jobs = [
      { runId: 'queued', status: 'queued' },
      { runId: 'running', status: 'running' },
      { runId: 'unknown', status: undefined },
      { runId: 'done', status: 'complete' },
      { runId: 'failed', status: 'failed' },
      { runId: 'paused', status: 'paused' },
    ];

    expect(activeAgentCount(tracker)).toBe(3);
    expect(agentStatusText(tracker)).toBe('Agents ○○○✓✗■');
    expect(agentFleetStatus(tracker)?.footer.compactText).toBe('A ○○○✓✗■');
  });

  it('preserves tracker insertion order even when timestamps disagree', () => {
    const tracker = new FakeTracker();
    tracker.jobs = [
      { runId: 'inserted-first', status: 'running', startedAt: 20 },
      { runId: 'inserted-second', status: 'running', startedAt: 10 },
    ];

    const segments = agentFleetStatus(tracker)?.footer.compactSegments;

    expect(segments?.[1]?.color).toBe(agentIdentityColor('inserted-first'));
    expect(segments?.[2]?.color).toBe(agentIdentityColor('inserted-second'));
  });

  it('uses stable run instance colors, pulses active work, and renders attention as a warning', () => {
    const tracker = new FakeTracker();
    tracker.jobs = [
      {
        runId: 'run-working',
        agent: 'researcher',
        status: 'running',
        activityState: 'working',
        startedAt: 1,
      },
      {
        runId: 'run-waiting',
        agent: 'researcher',
        status: 'running',
        activityState: 'waiting_for_reply',
        startedAt: 2,
      },
      {
        runId: 'run-attention',
        agent: 'planner',
        status: 'running',
        activityState: 'needs_attention',
        startedAt: 3,
      },
    ];

    const frames = [0, 1, 2].map((frame) => agentFleetStatus(tracker, frame)!);
    const workingGlyphs = frames.map((status) => status.footer.compactSegments?.[1]?.text);

    expect(new Set(workingGlyphs)).toEqual(new Set(AGENT_PULSE_FRAMES));
    expect(frames[0]?.footer.compactSegments?.[1]?.color).toBe(agentIdentityColor('run-working'));
    expect(frames[0]?.footer.compactSegments?.[2]).toEqual({
      text: '○',
      color: agentIdentityColor('run-waiting'),
    });
    expect(agentIdentityColor('run-working')).not.toBe(agentIdentityColor('run-waiting'));
    expect(frames[0]?.footer.compactSegments?.[3]).toEqual({ text: '!', color: 'warning' });
  });

  it('uses a bounded overflow suffix when active dots exceed compact footer capacity', () => {
    const tracker = new FakeTracker();
    tracker.jobs = Array.from({ length: 30 }, (_, index) => ({
      runId: `run-${index}`,
      agent: `agent-${index}`,
      status: 'running',
    }));

    const status = agentFleetStatus(tracker)!;

    expect(status.footer.compactText.length).toBeLessThanOrEqual(24);
    expect(status.footer.compactText).toMatch(/^A ○+…\+\d+$/u);
  });

  it('publishes active and completed states, then clears an empty tracker', () => {
    const tracker = new FakeTracker();
    const setStatus = vi.fn();
    const ctx = { hasUI: true, ui: { setStatus } } as never;

    tracker.jobs = [{ runId: 'running', status: 'running' }];
    publishAgentStatus(ctx, tracker);
    tracker.jobs = [{ runId: 'done', status: 'completed' }];
    publishAgentStatus(ctx, tracker);
    tracker.jobs = [];
    publishAgentStatus(ctx, tracker);

    expect(setStatus).toHaveBeenNthCalledWith(1, FLEET_STATUS_KEY, 'Agents ○');
    expect(setStatus).toHaveBeenNthCalledWith(2, FLEET_STATUS_KEY, 'Agents ✓');
    expect(setStatus).toHaveBeenNthCalledWith(3, FLEET_STATUS_KEY, undefined);
  });
});
