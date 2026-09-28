import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type DoomHubSessionCreateRequest, WORKFLOW_STEP_SESSION_PROVENANCE } from '@agimon-ai/doompi-core/hubChannel';
import { describe, expect, it, vi } from 'vitest';

import { createStepExecutor, readDoompiRunConfig, stepEnvironment } from '../../../src/services/stepExecutor';
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
        sessionProvenance: WORKFLOW_STEP_SESSION_PROVENANCE,
        selection: { majorMode: 'examples', minorModes: ['plan'], domains: ['engineering'] },
        model: 'p/m',
        thinking: 'high',
        environment: {
          WORKFLOW_NAME: 'dev-fix',
          WORKFLOW_STEP_DISPLAY: 'diagnose > Diagnose the defect',
          WORKFLOW_RUN_DIR: '/runs/r1',
          WORKFLOW_DECISION_STEERING: 'host',
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

  it("appends the entry's system prompt to the step session", async () => {
    const harness = dependencies();

    await createStepExecutor(harness.deps).custom!({
      cwd: '/repo',
      env: STEP_ENV,
      stepName: 'Develop',
      customRun: { prompt: 'Implement the task', systemPrompt: 'You are running job "development".' },
      runConfig: { model: 'claude-bridge/claude-opus-5-5', thinking: 'medium' },
    });

    expect(harness.created[0]).toMatchObject({
      model: 'claude-bridge/claude-opus-5-5',
      thinking: 'medium',
      appendSystemPrompt: 'You are running job "development".',
    });
    expect(harness.sessionService.prompt).toHaveBeenCalledWith('step-session', 'Implement the task');
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

  it('leaves commands to the engine without a pane launcher', async () => {
    await expect(
      createStepExecutor(dependencies().deps).command!({
        cwd: '/repo',
        env: STEP_ENV,
        stepName: 'Install',
        command: 'pnpm install',
        interactive: false,
      }),
    ).resolves.toBeUndefined();
  });

  it('runs an in-process templated command as a step session from its values', async () => {
    const launchPane = vi.fn();
    const harness = dependencies({ launchPane });
    const execution = await createStepExecutor(harness.deps).command!({
      cwd: '/repo',
      env: { ...STEP_ENV, WORKFLOW_STATUS_FILE: '/tmp/step.status' },
      stepName: 'Develop',
      command: "./pi.sh --model 'p/m' 'Implement it'",
      interactive: true,
      runConfig: { majorMode: 'dev', domains: ['development'], model: 'p/m', thinking: 'xhigh', script: 'custom' },
      template: { name: 'pi', inProcess: true, choice: 'deep', prompt: 'Implement it', systemPrompt: 'Decide.' },
    });

    expect(launchPane).not.toHaveBeenCalled();
    expect(harness.created[0]).toMatchObject({
      selection: { majorMode: 'dev', domains: ['development'] },
      model: 'p/m',
      thinking: 'xhigh',
      appendSystemPrompt: 'Decide.',
    });
    // The host ends the step, so hooks in the session get no status file and stand down.
    expect(harness.created[0]?.environment).not.toHaveProperty('WORKFLOW_STATUS_FILE');
    expect(harness.created[0]?.environment).toMatchObject({ WORKFLOW_DECISION_STEERING: 'host' });
    expect(harness.sessionService.prompt).toHaveBeenCalledWith('step-session', 'Implement it');
    expect(execution?.ref).toMatchObject({ kind: 'session', id: 'step-session' });
  });

  it('sends a templated command without in-process to a pane', async () => {
    const pane: StepPane = { target: '/tmp/p.sock', completion: Promise.resolve({ exitCode: 0 }), stop: vi.fn() };
    const launchPane = vi.fn(async () => pane);
    const harness = dependencies({ launchPane });
    await createStepExecutor(harness.deps).command!({
      cwd: '/repo',
      env: STEP_ENV,
      stepName: 'Review',
      command: "./claude.sh 'Review it'",
      interactive: true,
      template: { name: 'claude', inProcess: false, prompt: 'Review it' },
    });
    expect(launchPane).toHaveBeenCalledOnce();
    expect(harness.sessionService.create).not.toHaveBeenCalled();
  });

  it('prompts an idle session that has not decided, until it records a decision', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'step-decision-'));
    const decisionFile = path.join(directory, 'decision.json');
    const write = (extra: Record<string, unknown> = {}) =>
      fs.writeFileSync(
        decisionFile,
        JSON.stringify({
          schemaVersion: 1,
          job: 'develop',
          step: 'Develop',
          restartTargets: [],
          required: true,
          nudges: 0,
          ...extra,
        }),
      );
    write();
    const prompts: string[] = [];
    const sessionService = {
      create: vi.fn(async (request: DoomHubSessionCreateRequest) => ({ sessionId: 's1', cwd: request.cwd })),
      // The agent settles at once; on its second turn it records a decision.
      prompt: vi.fn(async (_id: string, text: string) => {
        prompts.push(text);
        if (prompts.length === 2) write({ nudges: 1, decision: { decision: 'complete' } });
        return { settled: Promise.resolve() };
      }),
      abort: vi.fn(async () => undefined),
    };
    const execution = await createStepExecutor({ ...dependencies().deps, sessionService }).command!({
      cwd: '/repo',
      env: { ...STEP_ENV, WORKFLOW_DECISION_FILE: decisionFile },
      stepName: 'Develop',
      command: 'unused',
      interactive: true,
      template: { name: 'pi', inProcess: true, prompt: 'Implement it' },
    });

    await expect(execution?.completion).resolves.toEqual({ exitCode: 0 });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('has no recorded outcome yet');
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
