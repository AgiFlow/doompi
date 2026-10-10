import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type DoomHubSessionCreateRequest, WORKFLOW_STEP_SESSION_PROVENANCE } from '@agimon-ai/doompi-core/hubChannel';
import type { NativeTerminalService } from '@agimon-ai/workflow-mcp';
import { describe, expect, it, vi } from 'vitest';

import {
  createNativeStepPaneLauncher,
  createStepExecutor,
  readDoompiRunConfig,
  stepEnvironment,
  stepPaneLogPath,
} from '../../../src/services/stepExecutor';
import type { StepExecutorDependencies, StepPane } from '../../../src/services/stepExecutor/type';

const paneServer = vi.hoisted(() => ({
  serve: vi.fn(async () => ({ close: vi.fn(async () => undefined) })),
}));
vi.mock('@agimon-ai/workflow-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agimon-ai/workflow-mcp')>()),
  serveNativeTerminal: paneServer.serve,
}));

const quietState = () => ({ isIdle: true, hasPendingMessages: false, backgroundWork: { items: [], errors: [] } });

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
    readExecutionState: vi.fn(async () => quietState()),
    abort: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
  const telemetry = {
    recordEvent: vi.fn(async () => undefined),
    recordWarning: vi.fn(async () => undefined),
    recordError: vi.fn(async () => undefined),
  };
  return {
    deps: {
      sessionService,
      parentSessionId: 'parent',
      hostEnvironment: { PATH: '/usr/bin' },
      createId: () => 'id-1',
      telemetry,
      ...overrides,
    } satisfies StepExecutorDependencies,
    sessionService,
    telemetry,
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

  it("keeps a templated step's own keys and fails a misspelled one", () => {
    const pi = { name: 'pi', reads: ['majorMode', 'prompt', 'effort'] };
    expect(readDoompiRunConfig({ majorMode: 'dev', effort: 'deep' }, pi)).toEqual({ majorMode: 'dev' });
    expect(() => readDoompiRunConfig({ majormode: 'dev' }, pi)).toThrow(
      'majormode is neither a DoomPi setting nor read by the "pi" command',
    );
    // An engine that does not say what its template reads leaves such keys to it.
    expect(readDoompiRunConfig({ majorMode: 'dev', majormode: 'dev' }, { name: 'pi' })).toEqual({ majorMode: 'dev' });
  });

  it('requires a major mode so a step never runs on the workspace default', () => {
    expect(() => readDoompiRunConfig({ model: 'p/m' })).toThrow('majorMode is required');
    expect(() => readDoompiRunConfig(undefined, { name: 'pi' })).toThrow('majorMode is required');
  });
  it('accepts independent subagent preferences for custom and templated steps', () => {
    const config = {
      majorMode: 'dev',
      model: 'p/step',
      thinking: 'high',
      subagentModel: 'p/child',
      subagentThinking: 'medium',
    };
    expect(readDoompiRunConfig(config)).toEqual(config);
    expect(readDoompiRunConfig(config, { name: 'pi', reads: ['prompt'] })).toEqual(config);
    expect(() => readDoompiRunConfig({ subagentModel: ' ' })).toThrow('subagentModel');
    expect(() => readDoompiRunConfig({ subagentThinking: ['medium'] })).toThrow('subagentThinking');
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
    // Done, the session stops running but stays readable in the workflow's view.
    expect(harness.sessionService.release).toHaveBeenCalledExactlyOnceWith('step-session');
  });

  it('transports subagent preferences without replacing the step model or thinking', async () => {
    const harness = dependencies();
    const config = {
      majorMode: 'dev',
      model: 'p/step',
      thinking: 'high',
      subagentModel: 'p/child',
      subagentThinking: 'medium',
    };
    await createStepExecutor(harness.deps).custom!({
      cwd: '/repo',
      env: { ...STEP_ENV, WORKFLOW_RUN_CONFIG: JSON.stringify(config) },
      stepName: 'Develop',
      customRun: { prompt: 'go' },
      runConfig: config,
    });
    expect(harness.created[0]).toMatchObject({
      model: 'p/step',
      thinking: 'high',
      environment: { WORKFLOW_RUN_CONFIG: JSON.stringify(config) },
    });
  });

  it('overlays empty current config over stale workflow preferences in the host', async () => {
    const harness = dependencies({
      hostEnvironment: { PATH: '/usr/bin', WORKFLOW_RUN_CONFIG: JSON.stringify({ subagentModel: 'p/stale' }) },
    });
    await createStepExecutor(harness.deps).custom!({
      runConfig: { majorMode: 'dev' },
      cwd: '/repo',
      env: { ...STEP_ENV, WORKFLOW_RUN_CONFIG: '{}' },
      stepName: 'Develop',
      customRun: { prompt: 'go' },
    });
    expect(harness.created[0]?.environment?.WORKFLOW_RUN_CONFIG).toBe('{}');
  });

  it("appends the entry's system prompt to the step session", async () => {
    const harness = dependencies();

    await createStepExecutor(harness.deps).custom!({
      cwd: '/repo',
      env: STEP_ENV,
      stepName: 'Develop',
      customRun: { prompt: 'Implement the task', systemPrompt: 'You are running job "development".' },
      runConfig: { majorMode: 'dev', model: 'claude-bridge/claude-opus-5-5', thinking: 'medium' },
    });

    expect(harness.created[0]).toMatchObject({
      model: 'claude-bridge/claude-opus-5-5',
      thinking: 'medium',
      appendSystemPrompt: 'You are running job "development".',
    });
    expect(harness.sessionService.prompt).toHaveBeenCalledWith('step-session', 'Implement the task');
  });

  it('reports a harness fault as an error outcome and releases the session', async () => {
    const harness = dependencies();
    const execution = await createStepExecutor(harness.deps).custom!({
      runConfig: { majorMode: 'dev' },
      cwd: '/repo',
      env: STEP_ENV,
      stepName: 'Diagnose',
      customRun: { prompt: 'go' },
    });

    harness.fail(new Error('provider refused'));
    await expect(execution.completion).resolves.toEqual({ error: new Error('provider refused') });
    expect(harness.sessionService.release).toHaveBeenCalledWith('step-session');
  });

  it('ends the step on stop even when its turn never settles', async () => {
    const harness = dependencies();
    const execution = await createStepExecutor(harness.deps).custom!({
      runConfig: { majorMode: 'dev' },
      cwd: '/repo',
      env: STEP_ENV,
      stepName: 'Diagnose',
      customRun: { prompt: 'go' },
    });

    await execution.stop();
    await expect(execution.completion).resolves.toEqual({ exitCode: 0 });
    expect(harness.sessionService.release).toHaveBeenCalledWith('step-session');
  });

  it('aborts a stopped turn on a host that cannot release sessions', async () => {
    const harness = dependencies();
    const { release: _release, ...withoutRelease } = harness.sessionService;
    const execution = await createStepExecutor({ ...harness.deps, sessionService: withoutRelease }).custom!({
      runConfig: { majorMode: 'dev' },
      cwd: '/repo',
      env: STEP_ENV,
      stepName: 'Diagnose',
      customRun: { prompt: 'go' },
    });

    await execution.stop();
    await execution.completion;
    expect(harness.sessionService.abort).toHaveBeenCalledWith('step-session');
  });

  it('finishes the step when its session will not end, and reports it', async () => {
    const harness = dependencies({ releaseTimeoutMs: 5 });
    harness.sessionService.release.mockImplementation(() => new Promise<undefined>(() => undefined));
    const execution = await createStepExecutor({ ...harness.deps, releaseTimeoutMs: 5 }).custom!({
      runConfig: { majorMode: 'dev' },
      cwd: '/repo',
      env: STEP_ENV,
      stepName: 'Diagnose',
      customRun: { prompt: 'go' },
    });

    harness.settle();
    await expect(execution.completion).resolves.toEqual({ exitCode: 0 });
    expect(harness.telemetry.recordWarning).toHaveBeenCalledWith(
      'doom_workflow.step_session_release_failed',
      expect.any(Error),
      expect.objectContaining({ 'workflow.step.name': 'Diagnose' }),
    );
  });

  it('fails an invalid runConfig with its reason, before opening a session', async () => {
    const harness = dependencies();
    const execution = await createStepExecutor(harness.deps).custom!({
      cwd: '/repo',
      env: STEP_ENV,
      stepName: 'Diagnose',
      customRun: { prompt: 'go' },
      runConfig: { mode: 'dev' },
    });

    await expect(execution.completion).resolves.toEqual({
      error: expect.objectContaining({ message: expect.stringContaining('Invalid runConfig') }),
    });
    expect(harness.sessionService.create).not.toHaveBeenCalled();
    expect(harness.telemetry.recordError).toHaveBeenCalledWith(
      'doom_workflow.step_session_failed',
      expect.any(Error),
      expect.objectContaining({ 'workflow.step.name': 'Diagnose' }),
      { includeException: true },
    );
  });

  it('fails a session that cannot be opened with the reason the host gave', async () => {
    const harness = dependencies();
    harness.sessionService.create.mockRejectedValueOnce(new Error('No configured model matched p/unknown.'));
    const execution = await createStepExecutor(harness.deps).custom!({
      runConfig: { majorMode: 'dev' },
      cwd: '/repo',
      env: STEP_ENV,
      stepName: 'Diagnose',
      customRun: { prompt: 'go' },
    });

    await expect(execution.completion).resolves.toEqual({ error: new Error('No configured model matched p/unknown.') });
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

  it('waits across background work and its completion turn without spending reminders', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'step-wait-'));
    const decisionFile = path.join(directory, 'decision.json');
    const decision = {
      schemaVersion: 1,
      job: 'develop',
      step: 'Develop',
      restartTargets: [],
      required: true,
      nudges: 0,
    };
    fs.writeFileSync(decisionFile, JSON.stringify(decision));
    const harness = dependencies();
    let reads = 0;
    const readExecutionState = vi.fn(async () => {
      expect(JSON.parse(fs.readFileSync(decisionFile, 'utf8')).nudges).toBe(0);
      reads += 1;
      if (reads <= 8)
        return {
          ...quietState(),
          backgroundWork: {
            items: [{ id: 'child', sessionId: 'step-session', provider: 'team-direct-runs' }],
            errors: [],
          },
        };
      if (reads === 9) return { ...quietState(), isIdle: false };
      fs.writeFileSync(decisionFile, JSON.stringify({ ...decision, decision: { decision: 'complete' } }));
      return quietState();
    });
    const execution = await createStepExecutor({
      ...harness.deps,
      sessionService: { ...harness.sessionService, readExecutionState },
      busyRetryMs: 1,
    }).custom!({
      runConfig: { majorMode: 'dev' },
      cwd: '/repo',
      env: { ...STEP_ENV, WORKFLOW_DECISION_FILE: decisionFile },
      stepName: 'Develop',
      customRun: { prompt: 'Implement it' },
    });
    harness.settle();
    await expect(execution.completion).resolves.toEqual({ exitCode: 0 });
    expect(reads).toBe(10);
    expect(harness.sessionService.prompt).toHaveBeenCalledOnce();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('requires inspection support before creating a step session', async () => {
    const harness = dependencies();
    const execution = await createStepExecutor({
      ...harness.deps,
      sessionService: { ...harness.sessionService, readExecutionState: undefined },
    }).custom!({
      cwd: '/repo',
      env: STEP_ENV,
      stepName: 'Develop',
      customRun: { prompt: 'Implement it' },
      runConfig: { majorMode: 'dev' },
    });
    expect(await execution.completion).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining('inspect step execution state') }),
    });
    expect(harness.sessionService.create).not.toHaveBeenCalled();
  });

  it.each(['missing', 'provider-error', 'queued'] as const)(
    'waits cancellably for %s execution state',
    async (kind) => {
      const harness = dependencies();
      const readExecutionState = vi.fn(async () => ({
        isIdle: true,
        hasPendingMessages: kind === 'queued',
        backgroundWork:
          kind === 'missing'
            ? undefined
            : {
                items: [],
                errors: kind === 'provider-error' ? [{ provider: 'doom-runner', message: 'unavailable' }] : [],
              },
      }));
      const execution = await createStepExecutor({
        ...harness.deps,
        sessionService: { ...harness.sessionService, readExecutionState },
        busyRetryMs: 1,
      }).custom!({
        cwd: '/repo',
        env: STEP_ENV,
        stepName: 'Develop',
        customRun: { prompt: 'Implement it' },
        runConfig: { majorMode: 'dev' },
      });
      harness.settle();
      await vi.waitFor(() => expect(readExecutionState.mock.calls.length).toBeGreaterThan(7));
      expect(harness.sessionService.prompt).toHaveBeenCalledOnce();
      await execution.stop();
      await expect(execution.completion).resolves.toEqual({ exitCode: 0 });
    },
  );

  it('fails and releases the child when execution inspection throws', async () => {
    const harness = dependencies();
    const error = new Error('inspection failed');
    const execution = await createStepExecutor({
      ...harness.deps,
      sessionService: {
        ...harness.sessionService,
        readExecutionState: vi.fn(async () => {
          throw error;
        }),
      },
    }).custom!({
      cwd: '/repo',
      env: STEP_ENV,
      stepName: 'Develop',
      customRun: { prompt: 'Implement it' },
      runConfig: { majorMode: 'dev' },
    });
    harness.settle();
    await expect(execution.completion).resolves.toEqual({ error });
    expect(harness.sessionService.release).toHaveBeenCalledOnce();
  });

  it('cancels an unresolved inspection without consuming a reminder', async () => {
    const harness = dependencies();
    const readExecutionState = vi.fn(() => new Promise<ReturnType<typeof quietState>>(() => undefined));
    const execution = await createStepExecutor({
      ...harness.deps,
      sessionService: { ...harness.sessionService, readExecutionState },
      busyRetryMs: 1,
    }).custom!({
      cwd: '/repo',
      env: STEP_ENV,
      stepName: 'Develop',
      customRun: { prompt: 'Implement it' },
      runConfig: { majorMode: 'dev' },
    });
    harness.settle();
    await vi.waitFor(() => expect(readExecutionState).toHaveBeenCalled());
    await execution.stop();
    await expect(execution.completion).resolves.toEqual({ exitCode: 0 });
    expect(harness.sessionService.release).toHaveBeenCalledOnce();
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
      readExecutionState: vi.fn(async () => quietState()),
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
      runConfig: { majorMode: 'dev' },
      template: { name: 'pi', inProcess: true, prompt: 'Implement it' },
    });

    await expect(execution?.completion).resolves.toEqual({ exitCode: 0 });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('has no recorded outcome yet');
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('lets a busy session finish its own turn before reminding it, and skips the reminder once it decided', async () => {
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
    let busyAttempts = 0;
    const sessionService = {
      create: vi.fn(async (request: DoomHubSessionCreateRequest) => ({ sessionId: 's1', cwd: request.cwd })),
      readExecutionState: vi.fn(async () => quietState()),
      // Web guidance started a turn just as the agent settled; that turn records the decision.
      prompt: vi.fn(async (_id: string, text: string) => {
        prompts.push(text);
        if (prompts.length === 1) return { settled: Promise.resolve() };
        busyAttempts += 1;
        if (busyAttempts === 2) write({ nudges: 1, decision: { decision: 'complete' } });
        throw new Error('The session is busy with an agent operation');
      }),
      abort: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const execution = await createStepExecutor({ ...dependencies().deps, sessionService, busyRetryMs: 1 }).command!({
      cwd: '/repo',
      env: { ...STEP_ENV, WORKFLOW_DECISION_FILE: decisionFile },
      stepName: 'Develop',
      command: 'unused',
      interactive: true,
      runConfig: { majorMode: 'dev' },
      template: { name: 'pi', inProcess: true, prompt: 'Implement it' },
    });

    await expect(execution?.completion).resolves.toEqual({ exitCode: 0 });
    expect(busyAttempts).toBe(2);
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

describe('createNativeStepPaneLauncher', () => {
  function terminal(overrides: Partial<Record<keyof NativeTerminalService, unknown>> = {}) {
    let end: (code: number) => void = () => undefined;
    const ended = new Promise<number>((resolve) => {
      end = resolve;
    });
    const service = {
      available: vi.fn(async () => true),
      spawn: vi.fn(async () => undefined),
      attach: vi.fn(async () => ({ snapshot: async () => ['done'], detach: () => undefined })),
      kill: vi.fn(async () => undefined),
      ended: vi.fn(() => ended),
      ...overrides,
    };
    return { service, end: (code: number) => end(code) };
  }

  it('kills a pane whose socket could not be served', async () => {
    const { service } = terminal();
    paneServer.serve.mockRejectedValueOnce(new Error('EADDRINUSE'));
    const launch = createNativeStepPaneLauncher(service as unknown as NativeTerminalService);

    await expect(launch({ id: 'pane-1', command: 'true', cwd: '/repo', env: {} })).rejects.toThrow('EADDRINUSE');
    expect(service.kill).toHaveBeenCalledWith('pane-1');
  });

  it('reports the exit code and still releases the pane when its screen cannot be kept', async () => {
    const { service, end } = terminal();
    const close = vi.fn(async () => undefined);
    paneServer.serve.mockResolvedValueOnce({ close });
    const telemetry = {
      recordEvent: vi.fn(async () => undefined),
      recordWarning: vi.fn(async () => undefined),
      recordError: vi.fn(async () => undefined),
    };
    const writeFile = vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(new Error('ENOSPC'));
    const pane = await createNativeStepPaneLauncher(
      service as unknown as NativeTerminalService,
      telemetry,
    )({
      id: 'pane-2',
      command: 'true',
      cwd: '/repo',
      env: {},
    });

    end(0);
    await expect(pane!.completion).resolves.toEqual({ exitCode: 0, outputTail: 'done' });
    expect(writeFile).toHaveBeenCalledWith(stepPaneLogPath(pane!.target), 'done\n', 'utf8');
    expect(close).toHaveBeenCalled();
    expect(service.kill).toHaveBeenCalledWith('pane-2');
    expect(telemetry.recordWarning).toHaveBeenCalledWith('doom_workflow.step_pane_failed', expect.any(Error), {
      stage: 'keep-screen',
    });
    writeFile.mockRestore();
  });
});
