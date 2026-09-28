import type { DoomHubSessionCreateRequest } from '@agimon-ai/doompi-core/hubChannel';
import { describe, expect, it, vi } from 'vitest';

import {
  createStepExecutor,
  readDoompiRunConfig,
  stepEnvironment,
  WORKFLOW_SESSION_PROVENANCE,
} from '../../../src/services/stepExecutor';
import type { StepExecutorDependencies, StepPane } from '../../../src/services/stepExecutor/type';

const STEP_ENV = {
  PATH: '/usr/bin',
  WORKFLOW_NAME: 'dev-fix',
  WORKFLOW_STEP_DISPLAY: 'diagnose > Diagnose the defect',
  WORKFLOW_RUN_DIR: '/runs/r1',
};

function dependencies(overrides: Partial<StepExecutorDependencies> = {}) {
  let settle: () => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const settled = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const created: DoomHubSessionCreateRequest[] = [];
  const sessionService = {
    create: vi.fn(async (request: DoomHubSessionCreateRequest) => {
      created.push(request);
      return { sessionId: 'step-session', cwd: request.cwd };
    }),
    prompt: vi.fn(async () => ({ settled })),
    abort: vi.fn(async () => undefined),
  };
  return {
    deps: {
      sessionService,
      parentSessionId: 'parent',
      hostEnvironment: { PATH: '/usr/bin' },
      createId: () => 'id-1',
      ...overrides,
    } satisfies StepExecutorDependencies,
    sessionService,
    created,
    settle: () => settle(),
    fail: (error: unknown) => fail(error),
  };
}

describe('readDoompiRunConfig', () => {
  it('accepts lists or comma strings and rejects unknown keys', () => {
    expect(readDoompiRunConfig({ majorMode: 'dev', domains: 'engineering, review', minorModes: ['plan'] })).toEqual({
      majorMode: 'dev',
      domains: ['engineering', 'review'],
      minorModes: ['plan'],
    });
    expect(() => readDoompiRunConfig({ majormode: 'dev' })).toThrow('Invalid runConfig');
    expect(() => readDoompiRunConfig({ majorMode: ['a', 'b'] })).toThrow('majorMode');
  });
});

describe('stepEnvironment', () => {
  it('keeps only what the step adds or changes', () => {
    expect(
      stepEnvironment(
        { PATH: '/usr/bin', HOME: '/other', WORKFLOW_RUN_DIR: '/r' },
        { PATH: '/usr/bin', HOME: '/home' },
      ),
    ).toEqual({
      HOME: '/other',
      WORKFLOW_RUN_DIR: '/r',
    });
  });
});

describe('createStepExecutor', () => {
  it('opens a pinned child session, prompts it, and completes when it settles', async () => {
    const harness = dependencies();
    const executor = createStepExecutor(harness.deps);

    const execution = await executor.custom!({
      cwd: '/repo',
      env: STEP_ENV,
      stepName: 'Diagnose the defect',
      customRun: { prompt: 'Diagnose it' },
      runConfig: {
        majorMode: 'examples',
        domains: ['engineering'],
        minorModes: ['plan'],
        model: 'p/m',
        thinking: 'high',
      },
    });

    expect(harness.created).toEqual([
      {
        cwd: '/repo',
        name: 'dev-fix: diagnose > Diagnose the defect',
        parentSessionId: 'parent',
        sessionProvenance: WORKFLOW_SESSION_PROVENANCE,
        selection: { majorMode: 'examples', minorModes: ['plan'], domains: ['engineering'] },
        model: 'p/m',
        thinking: 'high',
        environment: {
          WORKFLOW_NAME: 'dev-fix',
          WORKFLOW_STEP_DISPLAY: 'diagnose > Diagnose the defect',
          WORKFLOW_RUN_DIR: '/runs/r1',
        },
      },
    ]);
    expect(harness.sessionService.prompt).toHaveBeenCalledWith('step-session', 'Diagnose it');
    expect(execution.ref).toEqual({
      kind: 'session',
      id: 'step-session',
      label: 'dev-fix: diagnose > Diagnose the defect',
    });

    harness.settle();
    await expect(execution.completion).resolves.toEqual({ exitCode: 0 });
  });

  it('reports a harness fault as an error outcome and aborts on stop', async () => {
    const harness = dependencies();
    const execution = await createStepExecutor(harness.deps).custom!({
      cwd: '/repo',
      env: STEP_ENV,
      stepName: 'Diagnose',
      customRun: { prompt: 'go' },
    });

    await execution.stop();
    expect(harness.sessionService.abort).toHaveBeenCalledWith('step-session');
    harness.fail(new Error('provider refused'));
    await expect(execution.completion).resolves.toEqual({ error: new Error('provider refused') });
  });

  it('refuses an invalid runConfig before opening a session', async () => {
    const harness = dependencies();
    await expect(
      createStepExecutor(harness.deps).custom!({
        cwd: '/repo',
        env: STEP_ENV,
        stepName: 'Diagnose',
        customRun: { prompt: 'go' },
        runConfig: { mode: 'dev' },
      }),
    ).rejects.toThrow('Invalid runConfig');
    expect(harness.sessionService.create).not.toHaveBeenCalled();
  });

  it('runs commands in a pane and declines when no pane opens', async () => {
    const pane: StepPane = {
      target: '/tmp/workflow-steps/id-1.sock',
      completion: Promise.resolve({ exitCode: 3 }),
      stop: vi.fn(async () => true),
    };
    const launchPane = vi.fn(async () => pane);
    const executor = createStepExecutor(dependencies({ launchPane }).deps);

    const execution = await executor.command!({
      cwd: '/repo',
      env: STEP_ENV,
      stepName: 'Install',
      command: 'pnpm install',
      interactive: false,
    });
    expect(launchPane).toHaveBeenCalledWith({
      id: 'id-1',
      command: 'pnpm install',
      cwd: '/repo',
      env: STEP_ENV,
    });
    expect(execution?.ref).toEqual({ kind: 'pane', id: '/tmp/workflow-steps/id-1.sock', label: 'Install' });
    await expect(execution?.completion).resolves.toEqual({ exitCode: 3 });
    await execution?.stop();
    expect(pane.stop).toHaveBeenCalledTimes(1);

    launchPane.mockResolvedValueOnce(undefined as never);
    await expect(
      executor.command!({ cwd: '/repo', env: STEP_ENV, stepName: 'Install', command: 'x', interactive: true }),
    ).resolves.toBeUndefined();
  });

  it('leaves commands to the engine without a pane launcher', () => {
    expect(createStepExecutor(dependencies().deps).command).toBeUndefined();
  });
});
