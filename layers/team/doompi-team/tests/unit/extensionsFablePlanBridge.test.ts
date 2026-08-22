import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type DoomFablePlanService,
  FABLE_PLAN_MODEL,
  FABLE_PLAN_PROFILE,
  FABLE_PLAN_REQUESTER,
  FABLE_PLAN_RUNTIME,
  type FablePlanStartPayload,
} from '@agimon-ai/doompi-extension-contracts/fable-plan';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFablePlanBridge } from '../../src/adapters/pi/extensions/fablePlanBridge';
import { SubagentCapabilityPolicyStore } from '../../src/schemas/team/capabilityCeiling';
import {
  fableProfileResultPathFor,
  type AsyncSubagentSpawnInput,
  type AsyncSubagentSpawnerContract,
} from '../../src/adapters/runs/background/asyncExecution';
import type { SubagentWaiterContract, WaitOutcome, WaitRequest } from '../../src/adapters/runs/background/subagentWait';
import type { ManagementActionsContract } from '../../src/adapters/pi/extensions/managementActions';

const REQUEST: FablePlanStartPayload = {
  requester: FABLE_PLAN_REQUESTER,
  operationId: 'operation-1',
  runtime: FABLE_PLAN_RUNTIME,
  model: FABLE_PLAN_MODEL,
  profile: FABLE_PLAN_PROFILE,
  packet: {
    goal: ['Produce a secure plan'],
    constraints: ['Use only verified evidence'],
    decisions: [],
    verifiedFindings: [{ path: 'src/file.ts', finding: 'Pi verified this source.' }],
    inferredFindings: [],
    unresolvedQuestions: [],
  },
};

class FakeSpawner implements AsyncSubagentSpawnerContract {
  readonly inputs: AsyncSubagentSpawnInput[] = [];

  async spawn(input: AsyncSubagentSpawnInput) {
    this.inputs.push(input);
    const resultPath = fableProfileResultPathFor(input.runId);
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(resultPath, JSON.stringify({ text: 'draft output' }), { mode: 0o600 });
    return { runId: input.runId, pid: 100 + this.inputs.length };
  }
}

class FakeWaiter implements SubagentWaiterContract {
  calls: WaitRequest[] = [];
  onWait?: (request: WaitRequest) => void;

  async wait(request: WaitRequest): Promise<WaitOutcome> {
    this.calls.push(request);
    this.onWait?.(request);
    return { reason: 'completed', elapsedMs: 1, runs: [{ runId: 'run', status: 'completed' }] };
  }
}

function management(error?: string) {
  return {
    status: vi.fn((id: string) => ({
      runId: id,
      runDir: '/run',
      claimed: false,
      status: error
        ? { state: 'failed', startedAt: 1, lastUpdate: 2, error }
        : { state: 'completed', startedAt: 1, lastUpdate: 2 },
    })),
    list: vi.fn(() => ({ runs: [] })),
    interrupt: vi.fn(),
    stop: vi.fn(() => ({ requestPath: '/stop' })),
    steer: vi.fn(),
  } as unknown as ManagementActionsContract;
}

function grant(policies: SubagentCapabilityPolicyStore): void {
  policies.register(
    {
      owner: '@agimon-ai/doompi-plan',
      allowedTools: ['read'],
      allowedExternalProfiles: [FABLE_PLAN_PROFILE],
      denyExtensions: true,
    },
    'generation-1',
  );
}

let runSequence: number;

const opened: Array<ReturnType<typeof createFablePlanBridge>> = [];

function bind(bridge: ReturnType<typeof createFablePlanBridge>): DoomFablePlanService {
  const service = bridge.createService({ sessionId: 'session-1', cwd: '/repository' });
  opened.push(bridge);
  return service;
}

beforeEach(() => {
  runSequence = 0;
});

afterEach(() => {
  for (const bridge of opened.splice(0)) bridge.abandonAll();
});

describe('Fable plan bridge', () => {
  it('launches one fresh draft run with the fixed profile', async () => {
    const policies = new SubagentCapabilityPolicyStore();
    grant(policies);
    const spawner = new FakeSpawner();
    const waiter = new FakeWaiter();
    const report = vi.fn();
    const bridge = createFablePlanBridge({
      spawner,
      waiter,
      management: management(),
      policies,
      createRunId: () => `run-${++runSequence}`,
      now: () => 10,
      report,
    });
    const service = bind(bridge);

    await expect(service.start(REQUEST, new AbortController().signal)).resolves.toMatchObject({
      status: 'completed',
      draft: 'draft output',
      draftRunId: 'run-1',
    });
    expect(spawner.inputs).toHaveLength(1);
    expect(waiter.calls).toHaveLength(1);
    expect(waiter.calls[0]?.timeoutMs).toBe(25 * 60 * 1_000);
    expect(spawner.inputs[0]).toMatchObject({
      agent: 'fable-draft',
      runtime: 'claude',
      externalProfile: FABLE_PLAN_PROFILE,
      sensitiveTask: true,
      internal: true,
      artifacts: false,
      cwd: '/repository',
    });
    expect(spawner.inputs[0]?.task).toContain('"stage":"draft"');
    expect(spawner.inputs[0]?.task).toContain('Inspect the current repository');
    expect(spawner.inputs[0]?.piArgs).toMatchObject({
      model: 'fable',
      sessionEnabled: false,
      inheritProjectContext: false,
      inheritSkills: false,
    });
    expect(spawner.inputs[0]?.inlineAgent).toBeUndefined();
    expect(report).toHaveBeenCalledWith(
      'doom_team.fable_stage_started',
      expect.objectContaining({ 'operation.id': 'operation-1', 'run.id': 'run-1', stage: 'draft' }),
    );
    expect(report).toHaveBeenCalledWith(
      'doom_team.fable_finished',
      expect.objectContaining({
        'operation.id': 'operation-1',
        'draft.run_id': 'run-1',
        runtime: 'claude',
        model: 'fable',
        'draft.bytes': 12,
        outcome: 'completed',
      }),
    );
    const telemetry = JSON.stringify(report.mock.calls);
    expect(telemetry).not.toContain('review');

    await service.start(REQUEST, new AbortController().signal);
    expect(spawner.inputs).toHaveLength(1);
  });

  it('denies launch without the exact effective capability grant', async () => {
    const policies = new SubagentCapabilityPolicyStore();
    const spawner = new FakeSpawner();
    const bridge = createFablePlanBridge({
      spawner,
      waiter: new FakeWaiter(),
      management: management(),
      policies,
    });
    const service = bind(bridge);

    await expect(service.start(REQUEST, new AbortController().signal)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'capability_denied',
    });
    expect(spawner.inputs).toHaveLength(0);
  });

  it('does not launch a second stage after authorization changes', async () => {
    const policies = new SubagentCapabilityPolicyStore();
    grant(policies);
    const spawner = new FakeSpawner();
    const waiter = new FakeWaiter();
    waiter.onWait = () => policies.clear();
    const bridge = createFablePlanBridge({
      spawner,
      waiter,
      management: management(),
      policies,
      createRunId: () => `run-${++runSequence}`,
    });
    const service = bind(bridge);

    await expect(service.start(REQUEST, new AbortController().signal)).resolves.toMatchObject({
      status: 'completed',
      draft: 'draft output',
    });
    expect(spawner.inputs).toHaveLength(1);
  });

  it.each([
    ['timeout', { reason: 'timeout', elapsedMs: 1, runs: [] }, 'completed', 'timed_out', 'timeout'],
    ['no active run', { reason: 'no-active-runs', elapsedMs: 1, runs: [] }, 'completed', 'failed', 'unavailable'],
    [
      'malformed stream status',
      { reason: 'completed', elapsedMs: 1, runs: [] },
      'stream parse failed',
      'failed',
      'malformed_stream',
    ],
    ['failed child status', { reason: 'completed', elapsedMs: 1, runs: [] }, 'child failed', 'failed', 'unavailable'],
  ] as const)(
    'maps %s to a bounded broker failure',
    async (_label, waitOutcome, statusError, expectedStatus, errorCode) => {
      const policies = new SubagentCapabilityPolicyStore();
      grant(policies);
      const spawner = new FakeSpawner();
      const actions = management(statusError === 'completed' ? undefined : statusError);
      const waiter: SubagentWaiterContract = {
        wait: vi.fn(async () => ({
          reason: waitOutcome.reason,
          elapsedMs: waitOutcome.elapsedMs,
          runs: [...waitOutcome.runs],
        })),
      };
      const bridge = createFablePlanBridge({
        spawner,
        waiter,
        management: actions,
        policies,
        createRunId: () => `run-${++runSequence}`,
      });
      const service = bind(bridge);

      await expect(service.start(REQUEST, new AbortController().signal)).resolves.toMatchObject({
        status: expectedStatus,
        errorCode,
      });
      if (waitOutcome.reason === 'timeout') expect(actions.stop).toHaveBeenCalled();
    },
  );

  it.each([
    ['malformed JSON', 'not-json'],
    ['missing text', JSON.stringify({ value: 'none' })],
    ['empty text', JSON.stringify({ text: '   ' })],
    ['oversized text', JSON.stringify({ text: 'é'.repeat(9 * 1_024) })],
  ])('rejects %s in a profile result and removes the private result file', async (_label, contents) => {
    const policies = new SubagentCapabilityPolicyStore();
    grant(policies);
    const spawner: AsyncSubagentSpawnerContract = {
      spawn: vi.fn(async (input: AsyncSubagentSpawnInput) => {
        const resultPath = fableProfileResultPathFor(input.runId);
        fs.mkdirSync(path.dirname(resultPath), { recursive: true });
        fs.writeFileSync(resultPath, contents);
        return { runId: input.runId, pid: 10 };
      }),
    };
    const bridge = createFablePlanBridge({
      spawner,
      waiter: new FakeWaiter(),
      management: management(),
      policies,
      createRunId: () => `invalid-${++runSequence}`,
    });
    const service = bind(bridge);

    await expect(service.start(REQUEST, new AbortController().signal)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'unavailable',
    });
    expect(fs.existsSync(fableProfileResultPathFor('invalid-1'))).toBe(false);
  });

  it('rejects duplicate binding and honors an already-aborted parent signal', async () => {
    const policies = new SubagentCapabilityPolicyStore();
    grant(policies);
    const bridge = createFablePlanBridge({
      spawner: new FakeSpawner(),
      waiter: new FakeWaiter(),
      management: management(),
      policies,
      createRunId: () => `run-${++runSequence}`,
    });
    const service = bind(bridge);
    expect(() => bridge.createService({ sessionId: 'session-2', cwd: '/repository' })).toThrow('already bound');
    const controller = new AbortController();
    controller.abort(new Error('parent ended'));

    await expect(service.start(REQUEST, controller.signal)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('allows one active operation, deduplicates its id, and stops it on cancel', async () => {
    const policies = new SubagentCapabilityPolicyStore();
    grant(policies);
    const spawner = new FakeSpawner();
    const waiter: SubagentWaiterContract = {
      wait: (request) =>
        new Promise((resolve) => {
          request.signal?.addEventListener(
            'abort',
            () => resolve({ reason: 'aborted', elapsedMs: 1, runs: [{ runId: 'run-1', status: 'running' }] }),
            { once: true },
          );
        }),
    };
    const actions = management();
    const bridge = createFablePlanBridge({
      spawner,
      waiter,
      management: actions,
      policies,
      createRunId: () => `run-${++runSequence}`,
    });
    const service = bind(bridge);
    const first = service.start(REQUEST, new AbortController().signal);
    const duplicate = service.start(REQUEST, new AbortController().signal);
    const competing = service.start({ ...REQUEST, operationId: 'operation-2' }, new AbortController().signal);

    await expect(competing).resolves.toMatchObject({ status: 'failed', errorCode: 'operation_active' });
    service.cancel({ requester: FABLE_PLAN_REQUESTER, operationId: 'operation-1', reason: 'leave Fable' });
    await expect(first).resolves.toMatchObject({ status: 'cancelled' });
    await expect(duplicate).resolves.toMatchObject({ status: 'cancelled' });
    expect(spawner.inputs).toHaveLength(1);
    expect(actions.stop).toHaveBeenCalledWith('run-1', 'leave Fable');
  });

  it('aborts active work and removes provider state on session teardown', async () => {
    const policies = new SubagentCapabilityPolicyStore();
    grant(policies);
    const spawner = new FakeSpawner();
    const actions = management();
    const waiter: SubagentWaiterContract = {
      wait: (request) =>
        new Promise((resolve) => {
          const aborted = () =>
            resolve({ reason: 'aborted', elapsedMs: 1, runs: [{ runId: 'run-1', status: 'running' }] });
          if (request.signal?.aborted) {
            aborted();
            return;
          }
          request.signal?.addEventListener('abort', aborted, { once: true });
        }),
    };
    const bridge = createFablePlanBridge({
      spawner,
      waiter,
      management: actions,
      policies,
      createRunId: () => 'run-1',
    });
    const service = bind(bridge);
    const pending = service.start(REQUEST, new AbortController().signal);

    bridge.abandonAll();
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
    await expect(
      service.start({ ...REQUEST, operationId: 'after-teardown' }, new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'unavailable',
    });
    expect(actions.stop).toHaveBeenCalled();
  });
});
