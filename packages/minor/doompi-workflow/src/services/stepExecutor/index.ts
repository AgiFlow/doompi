import fs from 'node:fs';

import type { DoomHubSessionSelection } from '@agimon-ai/doompi-core/hubChannel';
import {
  NativeTerminalService,
  serveNativeTerminal,
  type StepExecutionOutcome,
  type StepExecutor,
  terminalSocketPath,
} from '@agimon-ai/workflow-mcp';

import { type DoompiRunConfig, doompiRunConfigSchema } from '../../schemas/runConfig';
import { STEP_PANE_REF_KIND, STEP_SESSION_REF_KIND } from '../../types/webWorkflows';
import type { StepExecutorDependencies, StepPaneLauncher } from './type';

/** Marks sessions a workflow step opened, so the rail can tell them from ones a person started. */
export const WORKFLOW_SESSION_PROVENANCE = 'workflow';
const STEP_DISPLAY_ENV = 'WORKFLOW_STEP_DISPLAY';
const WORKFLOW_NAME_ENV = 'WORKFLOW_NAME';

/** A step's `runConfig`, validated against the keys DoomPi understands. */
export function readDoompiRunConfig(runConfig: unknown): DoompiRunConfig {
  const parsed = doompiRunConfigSchema.safeParse(runConfig ?? {});
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
  return {
    async custom(request) {
      const config = readDoompiRunConfig(request.runConfig);
      const prompt = sessionService.prompt?.bind(sessionService);
      if (prompt === undefined)
        throw new Error('This host cannot prompt sessions, so customRun steps cannot run here.');
      const name = stepSessionName(request.env, request.stepName);
      const scope = await sessionService.create({
        cwd: request.cwd,
        name,
        parentSessionId: dependencies.parentSessionId,
        sessionProvenance: WORKFLOW_SESSION_PROVENANCE,
        selection: sessionSelection(config),
        ...(config.model === undefined ? {} : { model: config.model }),
        ...(config.thinking === undefined ? {} : { thinking: config.thinking }),
        environment: stepEnvironment(request.env, dependencies.hostEnvironment),
      });
      const receipt = await prompt(scope.sessionId, request.customRun.prompt);
      return {
        ref: { kind: STEP_SESSION_REF_KIND, id: scope.sessionId, label: name },
        completion: receipt.settled.then(
          (): StepExecutionOutcome => ({ exitCode: 0 }),
          (error: unknown): StepExecutionOutcome => ({ error: asError(error) }),
        ),
        // The session stays open once its turn ends, so the run can be read or continued.
        stop: async () => {
          await sessionService.abort?.(scope.sessionId);
        },
      };
    },
    ...(launchPane === undefined
      ? {}
      : {
          async command(request) {
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
        }),
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
    let finishing: Promise<void> | undefined;
    const finish = (): Promise<void> =>
      (finishing ??= (async () => {
        const screen = await lastScreen(service, request.id);
        if (screen !== undefined) await fs.promises.writeFile(stepPaneLogPath(target), screen, 'utf8');
        await server.close();
        await service.kill(request.id);
      })());
    return {
      target,
      completion: service.ended(request.id).then(async (exitCode) => {
        await finish();
        return { exitCode };
      }),
      stop: async () => {
        await finish();
        return true;
      },
    };
  };
}
