import fs from 'node:fs';
import path from 'node:path';

import type { Logger, WorkflowRunRecord, WorkflowRunRegistration } from '@agimon-ai/workflow-mcp';
import type { CallToolResult } from '@modelcontextprotocol/server';

import { WORKFLOW_LAUNCH_ID_ENV } from '../../constants/workflow';
import type { StepTelemetry } from '../stepExecutor/type';
import {
  createWorkflowLaunchExecutor,
  type WorkflowLaunchContext,
  type WorkflowLaunchInput,
} from '../workflowExecution';
import { withoutAnsi as plain } from '../workflowRuns';
import type { ServerLaunchDependencies, ServerLauncher } from './type';

/** Beside the run's own files, so the run's artifacts list and its deletion both include it. */
export const RUN_LOG_FILENAME = 'engine.log';
/** Exit codes a run ends with when nothing went wrong: finished, or skipped by its triggers. */
const SUCCESS_EXIT_CODES = new Set([0, 2]);
/** Lines kept before a run has a directory to write them to. */
const PENDING_LINE_LIMIT = 500;
/** How much of a failed run's output its telemetry keeps. */
const FAILURE_TAIL_LINES = 20;
/** How long closing a session waits for its in-process runs to stop. */
const STOP_TIMEOUT_MS = 10_000;
const SESSION_CLOSED_REASON = 'The session that runs this workflow closed.';
const RUNNING_STAGE = 'running';

const LAUNCH_REQUESTED_EVENT = 'doom_workflow.launch_requested';
const RUN_STARTED_EVENT = 'doom_workflow.run_started';
const RUN_FINISHED_EVENT = 'doom_workflow.run_finished';
const RUN_FAILED_EVENT = 'doom_workflow.run_failed';
const ENGINE_ERROR_EVENT = 'doom_workflow.engine_error';
const ENGINE_WARNING_EVENT = 'doom_workflow.engine_warning';
const RUN_LOG_FAILED_EVENT = 'doom_workflow.run_log_failed';
const RUN_STOP_FAILED_EVENT = 'doom_workflow.run_stop_failed';

function delay(ms: number): Promise<void> {
  return new Promise((settle) => {
    const timer = setTimeout(settle, ms);
    timer.unref?.();
  });
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/** An engine log for one run: its lines as they are written, then in the run directory. */
interface RunLog {
  readonly logger: Logger;
  /** Writes what was held so far into `file`, and every later line after it. */
  attach(file: string): void;
  /** Settles once every line written so far has reached the file. */
  flushed(): Promise<void>;
}

/**
 * The engine's log for one run, where a reader can find it.
 *
 * The engine writes why a step failed as a log line. Without a logger, those
 * lines exist only in the output the run returns at its end, so a run that is
 * still going, or one read later, has nothing to say about its failures. Here
 * every line goes to the run directory's `engine.log`, and errors and warnings
 * also go to telemetry, with the line as the exception so the text survives.
 */
function createRunLog(telemetry: StepTelemetry | undefined): RunLog {
  const pending: string[] = [];
  let file: string | undefined;
  let writing = Promise.resolve();
  const reportLogFailure = (error: unknown): Promise<void> =>
    telemetry?.recordWarning(RUN_LOG_FAILED_EVENT, error) ?? Promise.resolve();
  const append = (line: string): void => {
    if (file === undefined) {
      pending.push(line);
      if (pending.length > PENDING_LINE_LIMIT) pending.shift();
      return;
    }
    const target = file;
    writing = writing.then(() => fs.promises.appendFile(target, `${line}\n`, 'utf8')).catch(reportLogFailure);
  };
  return {
    logger: {
      info: (message) => append(plain(message)),
      warn: (message) => {
        const line = plain(message);
        append(line);
        void telemetry?.recordWarning(ENGINE_WARNING_EVENT, new Error(line.trim()));
      },
      error: (message) => {
        const line = plain(message);
        append(line);
        void telemetry?.recordError(ENGINE_ERROR_EVENT, new Error(line.trim()), {}, { includeException: true });
      },
    },
    attach(target) {
      file = target;
      const held = pending.splice(0);
      if (held.length === 0) return;
      writing = writing
        .then(() => fs.promises.appendFile(target, held.map((line) => `${line}\n`).join(''), 'utf8'))
        .catch(reportLogFailure);
    },
    flushed: () => writing,
  };
}

/** A run this launcher started and has not seen end. */
interface ActiveRun {
  registration?: WorkflowRunRegistration;
  settled: Promise<void>;
}

/**
 * Runs workflows inside the DoomPi server for one session.
 *
 * It is the same launch the Pi extension runs, through the same executor:
 * the same Agiflow checks, capacity limit and runner check, and the same
 * answer once the run registers. What the server adds is where the run
 * happens, in this process with the host's step executor, and what it keeps:
 * each run's engine log, telemetry for its start and end, a notice when a run
 * fails after its launch already answered, and a stop for every run still
 * going when the session closes.
 */
export function createServerLauncher(dependencies: ServerLaunchDependencies): ServerLauncher {
  const { feature, telemetry } = dependencies;
  const active = new Map<string, ActiveRun>();

  const runInProcess = async (input: WorkflowLaunchInput): Promise<CallToolResult> => {
    const launchId = input.env?.[WORKFLOW_LAUNCH_ID_ENV];
    if (launchId === undefined) throw new Error('An in-process launch needs its launch id.');
    const log = createRunLog(telemetry);
    const run: ActiveRun = { settled: Promise.resolve() };
    active.set(launchId, run);
    const runner = input.runner ?? input.cliAgent;
    const execution = (async (): Promise<CallToolResult> => {
      try {
        const result = await feature.createRunService({ logger: log.logger }).run({
          ...input,
          ...(runner === undefined ? {} : { runner }),
          // In this process the host's step executor reaches the run; a terminal launcher would not.
          skipLaunch: true,
          onRegistered: (registration) => {
            run.registration = registration;
            log.attach(path.join(registration.runDir, RUN_LOG_FILENAME));
            void telemetry?.recordEvent(RUN_STARTED_EVENT, { outcome: 'started' });
            dependencies.onRunsChanged?.();
          },
        });
        if (SUCCESS_EXIT_CODES.has(result.exitCode)) {
          void telemetry?.recordEvent(RUN_FINISHED_EVENT, { outcome: 'success', exit_code: result.exitCode });
          return textResult(plain(result.output) || 'Workflow completed.');
        }
        const tail = plain(result.output).trim().split('\n').slice(-FAILURE_TAIL_LINES).join('\n');
        void telemetry?.recordError(
          RUN_FAILED_EVENT,
          new Error(tail || `The workflow exited with code ${String(result.exitCode)}.`),
          { exit_code: result.exitCode },
          { includeException: true },
        );
        // The engine's output is colored for a terminal; a notice or a tool result is not one.
        return textResult(`Workflow failed (exit code ${String(result.exitCode)}):\n\n${plain(result.output)}`, true);
      } catch (error) {
        void telemetry?.recordError(RUN_FAILED_EVENT, error, { outcome: 'error' }, { includeException: true });
        throw error;
      } finally {
        await log.flushed();
        active.delete(launchId);
        dependencies.onRunsChanged?.();
      }
    })();
    run.settled = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  };

  const executor = createWorkflowLaunchExecutor<WorkflowLaunchContext>({
    environment: dependencies.environment,
    activeRunCount: async () => active.size,
    ...(dependencies.rejectRunner === undefined ? {} : { rejectRunner: dependencies.rejectRunner }),
    runTool: { execute: runInProcess },
    // Every run is tracked in `active` by runInProcess itself.
    trackPendingRun: (pending) => pending,
    findLaunchedRun: async ({ launchId }): Promise<WorkflowRunRecord | undefined> => {
      const registration = active.get(launchId)?.registration;
      if (registration === undefined) return undefined;
      return feature.registry.readRunByKey(registration.workspace, RUNNING_STAGE, registration.runKey);
    },
    onLateFailure: (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      void dependencies.notify(`Workflow launch failed after it was reported started.\n${detail}`, 'warning');
    },
    onLaunch: () => {
      void telemetry?.recordEvent(LAUNCH_REQUESTED_EVENT, { outcome: 'requested' });
      dependencies.onRunsChanged?.();
    },
    ...(dependencies.launchAckPollMs === undefined ? {} : { launchAckPollMs: dependencies.launchAckPollMs }),
    ...(dependencies.launchAckTimeoutMs === undefined ? {} : { launchAckTimeoutMs: dependencies.launchAckTimeoutMs }),
  });
  const context: WorkflowLaunchContext = { sessionManager: { getSessionId: () => dependencies.sessionId } };

  return {
    launch: (input) => executor.execute(input, context),
    activeRunCount: () => active.size,
    async dispose() {
      const runs = [...active.values()];
      if (runs.length === 0) return;
      // The same stop the web panel and the workflow tool request; the engine reads it between steps.
      await Promise.all(
        runs.map(async ({ registration }) => {
          if (registration === undefined) return;
          try {
            await feature.registry.requestStop(
              registration.workspace,
              registration.runKey,
              SESSION_CLOSED_REASON,
              registration.runId,
            );
          } catch (error) {
            await telemetry?.recordWarning(RUN_STOP_FAILED_EVENT, error);
          }
        }),
      );
      await Promise.race([
        Promise.all(runs.map((run) => run.settled)),
        delay(dependencies.stopTimeoutMs ?? STOP_TIMEOUT_MS),
      ]);
    },
  };
}
