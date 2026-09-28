import fs from 'node:fs';

import { type DoomHubSessionSelection, WORKFLOW_STEP_SESSION_PROVENANCE } from '@agimon-ai/doompi-core/hubChannel';
import {
  gateStepDecision,
  NativeTerminalService,
  serveNativeTerminal,
  type StepExecution,
  type StepExecutionOutcome,
  type StepExecutor,
  terminalSocketPath,
  WORKFLOW_DECISION_STEERING_ENV,
  WORKFLOW_DECISION_STEERING_HOST,
} from '@agimon-ai/workflow-mcp';

import { type DoompiRunConfig, doompiRunConfigSchema, doompiTemplateRunConfigSchema } from '../../schemas/runConfig';
import { STEP_PANE_REF_KIND, STEP_SESSION_REF_KIND } from '../../types/webWorkflows';
import type { StepExecutorDependencies, StepPaneLauncher } from './type';

const STEP_DISPLAY_ENV = 'WORKFLOW_STEP_DISPLAY';
const WORKFLOW_NAME_ENV = 'WORKFLOW_NAME';
/** The engine's completion signal for terminal agents; a session this host steers never uses it. */
const WORKFLOW_STATUS_FILE_ENV = 'WORKFLOW_STATUS_FILE';

/**
 * A step's `runConfig`, validated against the keys DoomPi understands. A
 * templated step's may carry keys for its command template, which are ignored.
 */
export function readDoompiRunConfig(runConfig: unknown, templated = false): DoompiRunConfig {
  const parsed = (templated ? doompiTemplateRunConfigSchema : doompiRunConfigSchema).safeParse(runConfig ?? {});
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'runConfig'}: ${issue.message}`);
  throw new Error(`Invalid runConfig: ${problems.join('; ')}`);
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

/** What one step session runs: its settings, what it is asked, and the step it reports on. */
interface StepSessionRequest {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stepName: string;
  readonly runConfig: unknown;
  readonly prompt: string;
  readonly systemPrompt?: string;
  /** A templated step: its runConfig also feeds the command template. */
  readonly templated: boolean;
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
  const { sessionService, launchPane } = dependencies;
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
    if (prompt === undefined) throw new Error('This host cannot prompt sessions, so this step cannot run here.');
    const config = readDoompiRunConfig(request.runConfig, request.templated);
    const name = stepSessionName(request.env, request.stepName);
    const environment = stepEnvironment(request.env, dependencies.hostEnvironment);
    // This host ends the step when the agent settles and steers it itself, so
    // hooks inside the session must neither end the step nor nudge the agent.
    delete environment[WORKFLOW_STATUS_FILE_ENV];
    environment[WORKFLOW_DECISION_STEERING_ENV] = WORKFLOW_DECISION_STEERING_HOST;
    const scope = await sessionService.create({
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
    let stopped = false;
    const completion = async (): Promise<StepExecutionOutcome> => {
      let receipt = await prompt(scope.sessionId, request.prompt);
      for (;;) {
        await receipt.settled;
        if (stopped) return { exitCode: 0 };
        const gate = await gateStepDecision(request.env);
        if (gate.action === 'allow') return { exitCode: 0 };
        receipt = await prompt(scope.sessionId, gate.message);
      }
    };
    return {
      ref: { kind: STEP_SESSION_REF_KIND, id: scope.sessionId, label: name },
      completion: completion().catch((error: unknown): StepExecutionOutcome => ({ error: asError(error) })),
      // The session stays open once its turn ends, so the run can be read or continued.
      stop: async () => {
        stopped = true;
        await sessionService.abort?.(scope.sessionId);
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
        templated: false,
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
          templated: true,
          prompt: template.prompt,
          ...(template.systemPrompt === undefined ? {} : { systemPrompt: template.systemPrompt }),
        });
      }
      if (launchPane === undefined) return undefined;
      const pane = await launchPane({
        id: dependencies.createId(),
        command: request.command,
        cwd: request.cwd,
        env: request.env,
      });
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
 * beside the socket and the pane is released.
 */
export function createNativeStepPaneLauncher(service = new NativeTerminalService()): StepPaneLauncher {
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
    const server = await serveNativeTerminal({ service, runKey: request.id, socketPath: target });
    let finishing: Promise<string | undefined> | undefined;
    const finish = (): Promise<string | undefined> =>
      (finishing ??= (async () => {
        const screen = await lastScreen(service, request.id);
        if (screen !== undefined) await fs.promises.writeFile(stepPaneLogPath(target), screen, 'utf8');
        await server.close();
        await service.kill(request.id);
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
