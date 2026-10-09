import fs from 'node:fs';

import { BACKGROUND_WORK_HOLDING_PROVIDERS, holdsSettledSession } from '@agimon-ai/doompi-core/backgroundWork';
import { type DoomHubSessionSelection, WORKFLOW_STEP_SESSION_PROVENANCE } from '@agimon-ai/doompi-core/hubChannel';
import {
  gateStepDecision,
  NativeTerminalService,
  readStepDecision,
  serveNativeTerminal,
  type StepExecution,
  type StepExecutionOutcome,
  type StepExecutor,
  terminalSocketPath,
  WORKFLOW_DECISION_FILE_ENV,
  WORKFLOW_DECISION_STEERING_ENV,
  WORKFLOW_DECISION_STEERING_HOST,
} from '@agimon-ai/workflow-mcp';

import {
  DOOMPI_RUN_CONFIG_KEYS,
  type DoompiRunConfig,
  doompiRunConfigSchema,
  doompiTemplateRunConfigSchema,
} from '../../schemas/runConfig';
import { STEP_PANE_REF_KIND, STEP_SESSION_REF_KIND } from '../../types/webWorkflows';
import type { StepExecutorDependencies, StepPaneLauncher, StepTelemetry } from './type';

const STEP_DISPLAY_ENV = 'WORKFLOW_STEP_DISPLAY';
const WORKFLOW_NAME_ENV = 'WORKFLOW_NAME';
/** The engine's completion signal for terminal agents; a session this host steers never uses it. */
const WORKFLOW_STATUS_FILE_ENV = 'WORKFLOW_STATUS_FILE';
/** How long a busy step session is left to finish a turn it was given elsewhere, such as web guidance. */
const BUSY_RETRY_MS = 2_000;
/** How long ending a step's session may take before the step stops waiting for it. */
const RELEASE_TIMEOUT_MS = 10_000;
/** What the runtime says when a turn is already running; the reminder then waits for it. */
const BUSY_SESSION_PATTERN = /\bbusy\b|LaneBusy/i;

const STEP_SESSION_STARTED_EVENT = 'doom_workflow.step_session_started';
const STEP_SESSION_FAILED_EVENT = 'doom_workflow.step_session_failed';
const STEP_REMINDER_EVENT = 'doom_workflow.step_reminder';
const STEP_SESSION_RELEASE_FAILED_EVENT = 'doom_workflow.step_session_release_failed';
const STEP_PANE_FAILED_EVENT = 'doom_workflow.step_pane_failed';

/** The command template a templated step runs through: its name, and the values it reads. */
export interface RunConfigTemplate {
  readonly name: string;
  readonly reads?: readonly string[];
}

const DOOMPI_KEYS: ReadonlySet<string> = new Set(DOOMPI_RUN_CONFIG_KEYS);

/**
 * A step's `runConfig`, validated against the keys DoomPi understands.
 *
 * A templated step's may also carry keys its command template reads. A key
 * that is neither, such as `majormode`, fails the step rather than running it
 * on workspace defaults. An engine that does not say what its template reads
 * leaves such keys unchecked.
 */
export function readDoompiRunConfig(runConfig: unknown, template?: RunConfigTemplate): DoompiRunConfig {
  const parsed = (template === undefined ? doompiRunConfigSchema : doompiTemplateRunConfigSchema).safeParse(
    runConfig ?? {},
  );
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'runConfig'}: ${issue.message}`);
    throw new Error(`Invalid runConfig: ${problems.join('; ')}`);
  }
  if (template?.reads !== undefined && typeof runConfig === 'object' && runConfig !== null) {
    const reads = new Set(template.reads);
    const unknown = Object.keys(runConfig).filter((key) => !DOOMPI_KEYS.has(key) && !reads.has(key));
    if (unknown.length > 0) {
      throw new Error(
        `Invalid runConfig: ${unknown.join(', ')} is neither a DoomPi setting nor read by the "${template.name}" command.`,
      );
    }
  }
  return parsed.data;
}

/** The selection a step session is pinned to; unset keys keep the workspace defaults. */
export function sessionSelection(config: DoompiRunConfig): DoomHubSessionSelection {
  return {
    ...(config.majorMode === undefined ? {} : { majorMode: config.majorMode }),
    ...(config.minorModes === undefined ? {} : { minorModes: config.minorModes }),
    ...(config.profile === undefined ? {} : { profile: config.profile }),
    ...(config.domains === undefined ? {} : { domains: config.domains }),
  };
}

/**
 * What a step adds to the host environment.
 *
 * The step environment is the whole process environment plus the run's own
 * keys. Handing all of it to the session would pin a copy of the host's
 * variables into it; the difference is the part the agent actually needs, such
 * as WORKFLOW_RUN_DIR for the artifacts its prompt names.
 */
export function stepEnvironment(
  env: Readonly<Record<string, string>>,
  host: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => host[key] !== value));
}

function stepSessionName(env: Readonly<Record<string, string>>, stepName: string): string {
  const display = env[STEP_DISPLAY_ENV] ?? stepName;
  const workflow = env[WORKFLOW_NAME_ENV];
  return workflow ? `${workflow}: ${display}` : display;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function delay(ms: number): Promise<void> {
  return new Promise((settle) => {
    const timer = setTimeout(settle, ms);
    timer.unref?.();
  });
}

/** A promise settled by `settle`, so a stop can end a wait that nothing else would. */
function signal(): { promise: Promise<void>; settle: () => void } {
  let settle: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/**
 * An execution that already failed, with why.
 *
 * Returned instead of throwing: the engine reports a thrown start as a spawn
 * error about shells and permissions, while a failed completion keeps this
 * message as the step's reason.
 */
function failedExecution(error: unknown): StepExecution {
  return { completion: Promise.resolve({ error: asError(error) }), stop: async () => undefined };
}

/** What one step session runs: its settings, what it is asked, and the step it reports on. */
interface StepSessionRequest {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stepName: string;
  readonly runConfig: unknown;
  readonly prompt: string;
  readonly systemPrompt?: string;
  /** A templated step's command: its runConfig also feeds that command's template. */
  readonly template?: RunConfigTemplate;
}

/**
 * Runs workflow steps inside DoomPi instead of a shell.
 *
 * A customRun step becomes a child session of the launching session, with the
 * step's major mode, minor modes, profile, domains and model, so its messages
 * stream like any other conversation. Command steps go to their own terminal
 * pane when a launcher is available and fall back to the engine's spawn when
 * it is not.
 */
export function createStepExecutor(dependencies: StepExecutorDependencies): StepExecutor {
  const { sessionService, launchPane, telemetry } = dependencies;
  const prompt = sessionService.prompt?.bind(sessionService);

  /**
   * Run a step as a child session of the launching session, with the step's
   * major mode, minor modes, profile, domains and model.
   *
   * The session keeps going until the step has what the workflow needs: each
   * time the agent settles, the engine's decision gate is asked, and while
   * the step still lacks a decision (or its declared artifacts) the session is
   * prompted with the gate's reminder. The gate counts reminders against its
   * cap, so a stuck agent ends and the engine fails the step.
   */
  async function runSession(request: StepSessionRequest): Promise<StepExecution> {
    if (prompt === undefined) return failedExecution('This host cannot prompt sessions, so this step cannot run here.');
    const readExecutionState = sessionService.readExecutionState?.bind(sessionService);
    if (readExecutionState === undefined)
      return failedExecution('This host cannot inspect step execution state, so this step cannot run here.');
    const attributes = { 'workflow.step.name': request.stepName, templated: request.template !== undefined };
    let scope: Awaited<ReturnType<typeof sessionService.create>>;
    let name: string;
    try {
      const config = readDoompiRunConfig(request.runConfig, request.template);
      name = stepSessionName(request.env, request.stepName);
      const environment = stepEnvironment(request.env, dependencies.hostEnvironment);
      // This host ends the step when the agent settles and steers it itself, so
      // hooks inside the session must neither end the step nor nudge the agent.
      delete environment[WORKFLOW_STATUS_FILE_ENV];
      environment[WORKFLOW_DECISION_STEERING_ENV] = WORKFLOW_DECISION_STEERING_HOST;
      scope = await sessionService.create({
        cwd: request.cwd,
        name,
        parentSessionId: dependencies.parentSessionId,
        // Keeps the session out of the rail: its conversation is read in the workflow's view.
        sessionProvenance: WORKFLOW_STEP_SESSION_PROVENANCE,
        selection: sessionSelection(config),
        ...(config.model === undefined ? {} : { model: config.model }),
        ...(config.thinking === undefined ? {} : { thinking: config.thinking }),
        ...(request.systemPrompt === undefined ? {} : { appendSystemPrompt: request.systemPrompt }),
        environment,
      });
    } catch (error) {
      void telemetry?.recordError(STEP_SESSION_FAILED_EVENT, error, attributes, { includeException: true });
      return failedExecution(error);
    }
    void telemetry?.recordEvent(STEP_SESSION_STARTED_EVENT, { ...attributes, outcome: 'started' });
    const sessionId = scope.sessionId;
    const stopped = signal();
    let stopRequested = false;
    const decided = (): boolean => {
      const path = request.env[WORKFLOW_DECISION_FILE_ENV];
      return path !== undefined && readStepDecision(path) !== undefined;
    };

    /**
     * Give the agent the gate's reminder. A session busy with a turn it was
     * given elsewhere, like web guidance, is left to finish it, then reminded
     * unless it decided meanwhile. Undefined means the step needs no more turns.
     */
    const remind = async (message: string): Promise<{ settled: Promise<void> } | undefined> => {
      for (;;) {
        try {
          return await prompt(sessionId, message);
        } catch (error) {
          if (!BUSY_SESSION_PATTERN.test(asError(error).message)) throw error;
          void telemetry?.recordEvent(STEP_REMINDER_EVENT, { ...attributes, outcome: 'busy' });
          await Promise.race([delay(dependencies.busyRetryMs ?? BUSY_RETRY_MS), stopped.promise]);
          if (stopRequested || decided()) return undefined;
        }
      }
    };

    /**
     * End the session once the step is over. Released, it stays readable in the
     * workflow's view without holding a model, tools and extensions in the host.
     * A host that cannot release it is asked to abort a stopped turn instead.
     */
    const endSession = async (): Promise<void> => {
      const ending = sessionService.release
        ? sessionService.release(sessionId)
        : stopRequested
          ? (sessionService.abort?.(sessionId) ?? Promise.resolve())
          : Promise.resolve();
      const timeout = delay(dependencies.releaseTimeoutMs ?? RELEASE_TIMEOUT_MS).then(() => {
        throw new Error(
          `The step session did not end within ${String(dependencies.releaseTimeoutMs ?? RELEASE_TIMEOUT_MS)}ms.`,
        );
      });
      try {
        await Promise.race([ending, timeout]);
      } catch (error) {
        // The step's outcome is already decided; a session left running is reported, not fatal.
        void telemetry?.recordWarning(STEP_SESSION_RELEASE_FAILED_EVENT, error, attributes);
      }
    };

    const untilQuiet = async (): Promise<void> => {
      let reported = false;
      while (!stopRequested) {
        const state = await Promise.race([readExecutionState(sessionId), stopped.promise.then(() => undefined)]);
        if (stopRequested || state === undefined) return;
        const snapshot = state.backgroundWork;
        const items = snapshot?.items.filter(holdsSettledSession) ?? [];
        const errors =
          snapshot?.errors.filter((error) => BACKGROUND_WORK_HOLDING_PROVIDERS.includes(error.provider)) ?? [];
        if (
          state.isIdle &&
          !state.hasPendingMessages &&
          snapshot !== undefined &&
          items.length === 0 &&
          errors.length === 0
        )
          return;
        if (!reported) {
          reported = true;
          void telemetry?.recordEvent('doom_workflow.step_waiting', {
            ...attributes,
            items: items.map((item) => `${item.provider}:${item.id}`).join(', '),
            errors: errors.map((error) => `${error.provider}: ${error.message}`).join(', '),
            coordinator: snapshot === undefined ? 'missing' : 'available',
          });
        }
        await Promise.race([delay(dependencies.busyRetryMs ?? BUSY_RETRY_MS), stopped.promise]);
      }
    };

    const completion = async (): Promise<StepExecutionOutcome> => {
      let receipt: { settled: Promise<void> } | undefined = await prompt(sessionId, request.prompt);
      while (receipt !== undefined) {
        // A stop ends the wait even when the turn itself never settles.
        await Promise.race([receipt.settled, stopped.promise]);
        if (stopRequested) return { exitCode: 0 };
        await untilQuiet();
        if (stopRequested) return { exitCode: 0 };
        const gate = await gateStepDecision(request.env);
        if (gate.action === 'allow') return { exitCode: 0 };
        void telemetry?.recordEvent(STEP_REMINDER_EVENT, { ...attributes, outcome: 'sent' });
        receipt = await remind(gate.message);
      }
      return { exitCode: 0 };
    };
    return {
      ref: { kind: STEP_SESSION_REF_KIND, id: sessionId, label: name },
      completion: completion()
        .catch((error: unknown): StepExecutionOutcome => ({ error: asError(error) }))
        .then(async (outcome) => {
          await endSession();
          return outcome;
        }),
      stop: async () => {
        stopRequested = true;
        stopped.settle();
      },
    };
  }

  return {
    async custom(request) {
      return runSession({
        cwd: request.cwd,
        env: request.env,
        stepName: request.stepName,
        runConfig: request.runConfig,
        prompt: request.customRun.prompt,
        ...(request.customRun.systemPrompt === undefined ? {} : { systemPrompt: request.customRun.systemPrompt }),
      });
    },
    async command(request) {
      // A templated command that allows it runs in-process from its values;
      // its rendered shell command is only the fallback for other hosts.
      const template = request.template;
      if (template?.inProcess && prompt !== undefined) {
        return runSession({
          cwd: request.cwd,
          env: request.env,
          stepName: request.stepName,
          runConfig: request.runConfig,
          template: { name: template.name, ...(template.reads === undefined ? {} : { reads: template.reads }) },
          prompt: template.prompt,
          ...(template.systemPrompt === undefined ? {} : { systemPrompt: template.systemPrompt }),
        });
      }
      if (launchPane === undefined) return undefined;
      let pane: Awaited<ReturnType<StepPaneLauncher>>;
      try {
        pane = await launchPane({
          id: dependencies.createId(),
          command: request.command,
          cwd: request.cwd,
          env: request.env,
        });
      } catch (error) {
        void telemetry?.recordError(
          STEP_PANE_FAILED_EVENT,
          error,
          { 'workflow.step.name': request.stepName },
          {
            includeException: true,
          },
        );
        return failedExecution(error);
      }
      if (pane === undefined) return undefined;
      return {
        ref: { kind: STEP_PANE_REF_KIND, id: pane.target, label: request.stepName },
        completion: pane.completion.then(
          (result): StepExecutionOutcome => result,
          (error: unknown): StepExecutionOutcome => ({ error: asError(error) }),
        ),
        stop: async () => {
          await pane.stop();
        },
      };
    },
  };
}

/** The shell a command step runs in, the same one the engine spawns it with. */
const STEP_SHELL = '/bin/zsh';
/** Namespace for step pane sockets, apart from whole-run terminal sockets. */
const STEP_PANE_SOCKET_SCOPE = 'doompi-workflow-steps';
const PANE_LOG_SUFFIX = '.log';
const PANE_CAPTURE_COLUMNS = 120;
const PANE_CAPTURE_ROWS = 40;

/** Where a finished step pane's last screen is kept: beside the socket that served it. */
export function stepPaneLogPath(socketPath: string): string {
  return `${socketPath}${PANE_LOG_SUFFIX}`;
}

/** The pane's current screen, or undefined once there is no pane left to read. */
async function lastScreen(service: NativeTerminalService, key: string): Promise<string | undefined> {
  try {
    const viewer = await service.attach(key, PANE_CAPTURE_COLUMNS, PANE_CAPTURE_ROWS);
    const lines = await viewer.snapshot();
    viewer.detach();
    return `${lines.join('\n')}\n`;
  } catch {
    // Nothing is left to read; the step's outcome does not depend on its last screen.
    return undefined;
  }
}

/**
 * Opens each command step in its own RMUX pane, through workflow-mcp's terminal host.
 *
 * The pane gets the step's whole environment, which is what lets an agent's
 * Stop hook end an interactive step through WORKFLOW_STATUS_FILE. A unix
 * socket serves the pane to the run terminal in any scope; the socket path is
 * the pane's target. When the step ends or is stopped, its last screen is kept
 * beside the socket and the pane is released, whatever fails on the way.
 */
export function createNativeStepPaneLauncher(
  service = new NativeTerminalService(),
  telemetry?: StepTelemetry,
): StepPaneLauncher {
  const report = (stage: string) => (error: unknown) =>
    telemetry?.recordWarning(STEP_PANE_FAILED_EVENT, error, { stage }) ?? Promise.resolve();
  return async (request) => {
    if (!(await service.available())) return undefined;
    await service.spawn({
      command: STEP_SHELL,
      args: ['-c', request.command],
      cwd: request.cwd,
      env: { ...request.env },
      runKey: request.id,
    });
    const target = terminalSocketPath(STEP_PANE_SOCKET_SCOPE, request.id);
    let server: Awaited<ReturnType<typeof serveNativeTerminal>>;
    try {
      server = await serveNativeTerminal({ service, runKey: request.id, socketPath: target });
    } catch (error) {
      // A pane nobody can reach must not keep running its command untracked.
      await service.kill(request.id).catch(report('kill'));
      throw error;
    }
    let finishing: Promise<string | undefined> | undefined;
    const finish = (): Promise<string | undefined> =>
      (finishing ??= (async () => {
        let screen: string | undefined;
        try {
          screen = await lastScreen(service, request.id);
          if (screen !== undefined) await fs.promises.writeFile(stepPaneLogPath(target), screen, 'utf8');
        } catch (error) {
          // Keeping the last screen is a courtesy; the step's outcome is its exit code.
          await report('keep-screen')(error);
        } finally {
          await server.close().catch(report('close-socket'));
          await service.kill(request.id).catch(report('kill'));
        }
        return screen;
      })());
    return {
      target,
      // The last screen is the step's output tail, the reason a failing restart-from check reports.
      completion: service.ended(request.id).then(async (exitCode) => {
        const screen = (await finish())?.trimEnd();
        return screen ? { exitCode, outputTail: screen } : { exitCode };
      }),
      stop: async () => {
        await finish();
        return true;
      },
    };
  };
}
