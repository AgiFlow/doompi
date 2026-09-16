import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessTool,
  DoomHeadlessToolResult,
} from '@agimon-ai/doompi-core/headless';
import { describe, expect, it } from 'vitest';

import subagentServerTool from '../../src/extensions/workspaces/sessions/(backend)/tool/subagent.server';
import type {
  AsyncJobTrackerContract,
  TrackedAsyncJob,
  TrackedAsyncJobsContract,
} from '../../src/services/asyncJobTracker';
import type { ControlActionResult, StatusActionResult, SteerActionResult } from '../../src/services/managementActions';
import type { SpawnPlanResult } from '../../src/services/spawnPlan';
import type { AgentConfig } from '../../src/types/agent';
import { TEST_SESSION_SCOPE } from '../support/sessionScope';

/**
 * The headless `subagent` tool's content text is what the MODEL reads; the
 * facet tool shadows the Pi one in a cockpit session, so only this file covers
 * that text. Every other headless assertion reads `details`, which a return to
 * serialized JSON would leave untouched.
 */

const worker: AgentConfig = {
  name: 'worker',
  description: 'Focused worker',
  source: 'project',
  filePath: '/work/worker.md',
  systemPrompt: 'Never show this to the model.',
  systemPromptMode: 'replace',
  inheritProjectContext: true,
  inheritSkills: false,
  tools: ['read', 'write'],
};

const tracked: TrackedAsyncJob[] = [
  { runId: 'run-1', agent: 'worker', status: 'running', startedAt: Date.now(), activityState: 'working' },
];

const jobs: TrackedAsyncJobsContract = {
  track: () => undefined,
  untrack: () => undefined,
  list: () => tracked,
  get: (runId) => tracked.find((job) => job.runId === runId),
  reset: () => undefined,
};

function harness(overrides: { spawn?: SpawnPlanResult; status?: StatusActionResult } = {}) {
  const runtime = {
    asyncJobTracker: { forSession: () => jobs } as unknown as AsyncJobTrackerContract,
    discovery: {
      discover: () => ({ agents: [worker], projectAgentsDir: '/work/.pi/agents' }),
      find: (_cwd: string, _scope: string, name: string) => (name === worker.name ? worker : undefined),
      invalidate: () => undefined,
    },
    spawnPlanner: {
      spawn: async (): Promise<SpawnPlanResult> => overrides.spawn ?? { outcomes: [] },
    },
    management: {
      status: (): StatusActionResult =>
        overrides.status ?? { runId: 'run-1', runDir: undefined, claimed: false, status: undefined },
      stop: async (): Promise<ControlActionResult> => ({ requestId: 'stop-1' }),
      steer: async (): Promise<SteerActionResult> => ({
        requestId: 'steer-1',
        index: 0,
        state: 'delivered',
        message: 'accepted',
      }),
    },
  };
  const execution = {
    cwd: '/work',
    sessionId: TEST_SESSION_SCOPE.rootSessionId,
    environment: {},
  } as unknown as DoomHeadlessExecutionContext;
  // The routed file is declared in its factory form, which the host calls with the scope.
  const tool = (subagentServerTool as (context: unknown) => DoomHeadlessTool)({ root: { runtime, execution } });
  const call = (params: Record<string, unknown>, onUpdate?: (result: DoomHeadlessToolResult) => void) =>
    tool.execute('call-1', params as never, undefined, onUpdate, execution);
  return { call };
}

function textOf(result: DoomHeadlessToolResult): string {
  return result.content.map((block) => ('text' in block ? block.text : '')).join('');
}

describe('the headless subagent tool text', () => {
  it('lists agents as prose, never as serialized details', async () => {
    const result = await harness().call({ action: 'agents' });

    expect(textOf(result)).toBe('Executable agents:\n- worker (project): Focused worker');
    expect(textOf(result)).not.toContain('{');
  });

  it('describes one agent without leaking its prompt or file path', async () => {
    const result = await harness().call({ action: 'agents', name: 'worker' });

    expect(textOf(result)).toBe(
      [
        'Agent: worker (project)',
        'Description: Focused worker',
        'Runtime: pi',
        'Write capable: yes',
        'Tools: read, write',
      ].join('\n'),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Never show this to the model.');
    expect(serialized).not.toContain('/work/worker.md');
  });

  it('reports a launch with its ids and the next step, partial update included', async () => {
    const spawn: SpawnPlanResult = {
      outcomes: [
        { agent: 'worker', task: 'one', childIndex: 0, runId: 'run-7' },
        { agent: 'ghost', task: 'two', childIndex: 1, error: 'no executable agent named ghost' },
      ],
    };
    const updates: DoomHeadlessToolResult[] = [];
    const result = await harness({ spawn }).call(
      {
        action: 'run',
        requests: [
          { agent: 'worker', task: 'one' },
          { agent: 'ghost', task: 'two' },
        ],
      },
      (update) => updates.push(update),
    );

    expect(textOf(result)).toBe(
      [
        'Started 1/2 subagents; 1 failed:',
        '- worker: run-7',
        '- ghost: failed: no executable agent named ghost',
        '',
        'Completion will arrive asynchronously for started runs. Do not resubmit them; retry only corrected failed entries.',
      ].join('\n'),
    );
    expect(result.details).toEqual(spawn);
    expect(textOf(updates[0] as DoomHeadlessToolResult)).toBe('Starting 2 subagents...');
    expect(updates[0]?.details).toEqual({ action: 'run', partial: true });
  });

  it('states the whole launch succeeded when nothing failed', async () => {
    const spawn: SpawnPlanResult = { outcomes: [{ agent: 'worker', task: 'one', childIndex: 0, runId: 'run-7' }] };
    const result = await harness({ spawn }).call({ action: 'run', requests: [{ agent: 'worker', task: 'one' }] });

    expect(textOf(result)).toBe(
      [
        'Started 1 subagent:',
        '- worker: run-7',
        '',
        'Completion will arrive asynchronously. Continue only non-overlapping work, or end your turn.',
      ].join('\n'),
    );
  });

  it('renders the fleet and one run as the status views word them', async () => {
    const fleet = await harness().call({ action: 'status' });
    expect(textOf(fleet)).toContain('1 active run:');
    expect(textOf(fleet)).toContain('- run-1 · running · ');

    const pending = await harness().call({ action: 'status', id: 'run-1' });
    expect(textOf(pending)).toBe("Run 'run-1' has no status yet.");

    const running = await harness({
      status: {
        runId: 'run-1',
        runDir: undefined,
        claimed: false,
        status: { version: 1, runId: 'run-1', agent: 'worker', state: 'running', startedAt: 1, lastUpdate: 2 },
      },
    }).call({ action: 'status', id: 'run-1' });
    expect(textOf(running)).toBe("Run 'run-1': running");
  });

  it('says so plainly when no run is suspended', async () => {
    expect(textOf(await harness().call({ action: 'suspended' }))).toBe('No suspended subagents in this session.');
  });

  it('confirms stop and steer in one line each', async () => {
    expect(textOf(await harness().call({ action: 'stop', id: 'run-1' }))).toBe("Stop requested for 'run-1'.");
    expect(textOf(await harness().call({ action: 'steer', id: 'run-1', message: 'keep going' }))).toBe(
      "Steer request 'steer-1' for 'run-1' is delivered: accepted",
    );
  });

  it('returns the failure message itself, not a serialized error', async () => {
    const result = await harness().call({ action: 'agents', name: 'missing' });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toBe(
      [
        "[agent_not_found] No executable agent matches 'missing'.",
        'Recovery: Call subagent({"action":"agents"}) and retry with an exact agent name.',
      ].join('\n'),
    );
  });
});
