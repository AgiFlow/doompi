import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isAbsolute, relative, resolve } from 'node:path';

import { resolveRootSessionId } from '@agimon-ai/doompi-core/childProcess';
import {
  type DoomHeadlessExecutionContext,
  type DoomHeadlessContent,
  type DoomHeadlessToolResult,
} from '@agimon-ai/doompi-core/headless';
import { createDoomNotificationEntryData, DOOM_NOTIFICATION_ENTRY_TYPE } from '@agimon-ai/doompi-core/notification';
import { serverMinorModes } from '@agimon-ai/doompi-minor-mode';
import { defineMinorMode, type MinorModeOwner, type MinorModeState } from '@agimon-ai/doompi-minor-mode';
import { createDoomTelemetry } from '@agimon-ai/doompi-telemetry';
import { createEmbeddedWorkflowFeature } from '@agimon-ai/workflow-mcp';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  WORKFLOW_LAUNCHER_SESSION_ENV,
  WORKFLOW_SESSION_PROVENANCE,
  WORKFLOW_SESSION_RELEASE_TYPE,
  WORKFLOW_TOOLS_TOOL_NAME,
} from '../../constants/workflow';
import { workflowToolsInputSchema } from '../../schemas/workflowPi';
import { registerRunProvider, type RunProviderHandle } from '../../services/backgroundWork';
import { resolveMaxConcurrent } from '../../services/piToolBridge';
import { createServerLauncher } from '../../services/serverLaunch';
import { createNativeStepPaneLauncher, createStepExecutor } from '../../services/stepExecutor';
import { createWorkflowCatalogReader, presentWorkflowCatalog } from '../../services/webWorkflowCatalog';
import { defaultCatalogDeps } from '../../services/workflowCatalogDeps';
import type { WorkflowLaunchInput } from '../../services/workflowExecution';
import { isWorkflowDispatcherProcess, resolveDispatcherParentSession } from '../../services/workflowFence';
import { createWorkflowApi } from '../../services/workflowHubApi';
import {
  parseWorkflowLaunchCommand,
  resolveWorkflowEntry,
  validateWorkflowLaunch,
} from '../../services/workflowLaunchCommand';
import { readWorkflowSkill as skill } from '../../services/workflowResource';
import {
  type ParsedWorkflowRun,
  presentWorkflowRuns,
  runBelongsToSession,
  runLaunchedBySession,
} from '../../services/workflowRuns';
import {
  createWorkflowSessionLifecycle,
  isWorkflowSession,
  workflowSessionBrief,
  workflowSessionName,
} from '../../services/workflowSession';
import { readWorkflowRuns } from '../../services/workflowWatcher';
import routes from '../../types/apiRoutes';
import { WORKFLOW_CATALOG_TYPE, WORKFLOW_RUNS_TYPE } from '../../types/webWorkflows';
import { WORKFLOW_API_BASE_PATH, type WorkflowLaunchResponse } from '../../types/webWorkflowTerminal';

const SOURCE = '@agimon-ai/doompi-workflow';
const WORKFLOW_MODE_ID = 'workflow';
const LIST_TOOL = 'list_workflows';
const LAUNCH_TOOL = 'launch_workflow';
const RUN_TOOL = 'workflow_run';
/** Origin of a request dispatched in process to another mount; nothing resolves it. */
const IN_PROCESS_ORIGIN = 'http://doompi.local';
/** A burst of job and step events is published once, this long after the first. */
const RUNS_PUBLISH_DEBOUNCE_MS = 100;
/** A notification body's limit; a longer failure is cut to it. */
const NOTICE_BODY_LIMIT = 4_000;

type LaunchResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
/** Where a launch comes from: the directory it names paths against, and the repository they must stay in. */
type LaunchLocation = { readonly cwd: string; readonly repoRoot: string };

/**
 * A launch refused because the workflow needs fixing. The doctor's findings
 * name only a job and a step, so the notice names the workflow and says
 * nothing ran; in a conversation it otherwise reads as part of whatever run
 * was reported just before it.
 */
function needsFixingNotice(workflow: string, error: string): string {
  return `Workflow "${workflow}" was not launched: it needs fixing.\n${error}`;
}

function textResult(text: string, isError = false): LaunchResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function isLaunchResponse(value: unknown): value is WorkflowLaunchResponse {
  return typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string';
}

function errorOf(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
    ? value.error
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The text of a launch's tool result, as the launch tool and the API report it. */
function launchResultOf(result: CallToolResult): LaunchResult {
  const text = result.content
    .map((item) => (item.type === 'text' ? item.text : ''))
    .filter((line) => line !== '')
    .join('\n');
  return textResult(text || 'Workflow launch requested.', result.isError === true);
}

function callResult(value: unknown): DoomHeadlessToolResult {
  const content: DoomHeadlessContent[] = [];
  if (typeof value === 'object' && value !== null && 'content' in value && Array.isArray(value.content)) {
    for (const item of value.content) {
      if (typeof item !== 'object' || item === null || !('type' in item)) continue;
      const record = item as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string') content.push({ type: 'text', text: record.text });
      else if (record.type === 'image' && typeof record.data === 'string' && typeof record.mimeType === 'string') {
        content.push({ type: 'image', data: record.data, mimeType: record.mimeType });
      }
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: JSON.stringify(value, null, 2) });
  return {
    content,
    details: value,
    ...(typeof value === 'object' && value !== null && 'isError' in value && value.isError === true
      ? { isError: true }
      : {}),
  };
}

import { type DoomHeadlessHostService } from '@agimon-ai/doompi-core/headless';
import { type DoomServerHostService, type DoomServerSessionPlugin } from '@agimon-ai/doompi-core/serverFacet';
export function createWorkflowServerRuntime(
  host: DoomHeadlessHostService,
  serverHost: DoomServerHostService,
): DoomServerSessionPlugin {
  if (serverHost.context.directEvents === undefined)
    throw new Error('Workflow headless facet requires the session direct event bus.');
  const directEvents = serverHost.context.directEvents;
  let runProvider: RunProviderHandle | undefined;
  const catalogDeps = defaultCatalogDeps();
  const catalogReader = createWorkflowCatalogReader(catalogDeps);
  const telemetry = createDoomTelemetry({
    serviceName: 'doom-workflow',
    packageName: SOURCE,
    cwd: host.context.cwd,
    env: host.context.environment,
    enableLogs: true,
    enableTraces: true,
  });
  /** True when this session was created to own one workflow run for the session that launched it. */
  const workflowSession = isWorkflowSession(host.context);
  const communication = serverHost.context.sessionCommunication;
  const lifecycle = workflowSession
    ? createWorkflowSessionLifecycle({
        parentSessionId: host.context.sessionContext?.parentSessionId,
        publishActivity: (activity) => serverHost.context.publishActivity?.(activity),
        postNotice: async (notice) => {
          // The same entry the notification provider appends in a web session: a notice, never a turn.
          const data = createDoomNotificationEntryData({ title: notice.title, body: notice.body, level: notice.level });
          if (data !== undefined) await host.context.session.appendCustomEntry(DOOM_NOTIFICATION_ENTRY_TYPE, data);
        },
        isIdle: async () => {
          const activity = await host.context.session.activity();
          return activity.isIdle && !activity.hasPendingMessages;
        },
        ...(communication === undefined
          ? {}
          : {
              requestRelease: (parent: string, runKeys: readonly string[]) =>
                communication.publish(parent, WORKFLOW_SESSION_RELEASE_TYPE, { runKeys }),
              onPeerReady: (listener: (peer: string) => void) => communication.onPeerReady(listener),
            }),
      })
    : undefined;
  const reportLifecycleFailure = (error: unknown): void => {
    void telemetry.recordWarning('doom_workflow.session_lifecycle_failed', error);
  };
  /** This session's runs, published to its panel and counted as its background work. */
  const publishRuns = (executionContext: typeof host.context): boolean => {
    const records = readWorkflowRuns({ environment: executionContext.environment }).filter((run) =>
      runBelongsToSession(run, executionContext.sessionId),
    );
    const activeItems = records
      .filter((run) => run.view.stage === 'running' && run.view.stale !== true)
      .map((run) => ({ id: `${run.view.workspace}/${run.view.runKey}`, sessionId: executionContext.sessionId }));
    runProvider?.update(activeItems);
    const runs = presentWorkflowRuns(
      records.map((run) => run.view),
      Date.now(),
    );
    directEvents.publish(WORKFLOW_RUNS_TYPE, executionContext.sessionId, { runs });
    lifecycle?.observe(runs).catch(reportLifecycleFailure);
    return activeItems.length > 0;
  };
  /** The workflows this session can launch. Runs moving on do not change them, so their events skip this. */
  const publishCatalog = async (executionContext: typeof host.context): Promise<void> => {
    try {
      directEvents.publish(WORKFLOW_CATALOG_TYPE, executionContext.sessionId, {
        cwd: executionContext.cwd,
        workflows: presentWorkflowCatalog(await catalogReader.read(executionContext.cwd)),
      });
    } catch (error) {
      const warning = error instanceof Error ? error.message : String(error);
      directEvents.publish(WORKFLOW_CATALOG_TYPE, executionContext.sessionId, {
        cwd: executionContext.cwd,
        workflows: [],
        warning,
      });
    }
  };
  const publishLifecycle = async (executionContext: typeof host.context): Promise<boolean> => {
    const active = publishRuns(executionContext);
    await publishCatalog(executionContext);
    return active;
  };
  let runsTimer: ReturnType<typeof setTimeout> | undefined;
  let runsAfter: ((active: boolean) => void) | undefined;
  /** Publishes the runs once for a burst of job and step events, which a fix loop can produce by the dozen. */
  const publishRunsSoon = (executionContext: typeof host.context, after?: (active: boolean) => void): void => {
    if (after !== undefined) runsAfter = after;
    if (runsTimer !== undefined) return;
    runsTimer = setTimeout(() => {
      runsTimer = undefined;
      const done = runsAfter;
      runsAfter = undefined;
      try {
        const active = publishRuns(executionContext);
        done?.(active);
      } catch (error) {
        void telemetry.recordWarning('doom_workflow.publish_failed', error);
      }
    }, RUNS_PUBLISH_DEBOUNCE_MS);
    runsTimer.unref?.();
  };
  // Steps run in this process: customRun as child sessions of this one, commands in their own panes.
  const sessionService = serverHost.context.sessionService;
  const featureOptions =
    sessionService === undefined
      ? {}
      : {
          stepExecutor: createStepExecutor({
            sessionService,
            parentSessionId: host.context.sessionId,
            hostEnvironment: process.env,
            launchPane: createNativeStepPaneLauncher(undefined, telemetry),
            createId: () => `workflow-${randomUUID()}`,
            telemetry,
          }),
        };
  const feature = createEmbeddedWorkflowFeature(featureOptions);
  type LaunchParameters = Parameters<typeof feature.runTool.execute>[0];
  const launcher = createServerLauncher({
    feature,
    // Each replay owns its recovery service while sharing the registry and host step executor.
    createRecoverTool: (options) =>
      createEmbeddedWorkflowFeature({ ...featureOptions, registry: feature.registry }).createRecoverTool(options),
    sessionId: host.context.sessionId,
    environment: host.context.environment,
    telemetry,
    notify: (body, level) => host.context.client.notify({ body: body.slice(0, NOTICE_BODY_LIMIT), level }),
    onRunsChanged: () => publishRunsSoon(host.context),
  });
  /**
   * Why this session cannot run a launch, or undefined when it can.
   *
   * The checks the slash command makes through the catalog, made for every
   * launch whatever asked for it: the launch tool, another session, or the
   * browser. The workflow must be a file in the repository the launch comes
   * from, a worktree's own when it runs in one, and its runner, command,
   * choice, inputs and prompt must be ones it declares.
   */
  const refuseLaunch = (input: WorkflowLaunchInput, where: LaunchLocation): string | undefined => {
    if (typeof input.workflowPath !== 'string' || input.workflowPath === '') return 'A launch needs a workflowPath.';
    const workflowPath = resolve(where.cwd, input.workflowPath);
    const inside = relative(where.repoRoot, workflowPath);
    if (inside.startsWith('..') || isAbsolute(inside)) {
      return `Workflow ${input.workflowPath} is outside this session's repository, so it cannot be launched here.`;
    }
    const detail = catalogDeps.summarize(workflowPath);
    if (detail.error !== undefined) return needsFixingNotice(inside, detail.error);
    const problems = validateWorkflowLaunch(detail, {
      inputs: input.inputs ?? {},
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...((input.runner ?? input.cliAgent) === undefined ? {} : { runner: input.runner ?? input.cliAgent }),
      ...(input.command === undefined ? {} : { command: input.command }),
      ...(input.choice === undefined ? {} : { choice: input.choice }),
    });
    return problems.length === 0 ? undefined : problems.join('\n');
  };
  /**
   * Run a workflow in this process and answer once it has registered.
   *
   * The launch goes through the same executor the Pi extension uses; see
   * `createServerLauncher` for what the server adds around it.
   */
  const launchHere = async (
    parameters: LaunchParameters,
    where: LaunchLocation = host.context,
  ): Promise<LaunchResult> => {
    let input: WorkflowLaunchInput;
    try {
      input = feature.runTool.getInputSchema().parse(parameters);
    } catch (error) {
      return textResult(`Error: ${errorMessage(error)}`, true);
    }
    const refusal = refuseLaunch(input, where);
    if (refusal !== undefined) return textResult(`Error: ${refusal}`, true);
    try {
      return launchResultOf(await launcher.launch({ ...input, workflowPath: resolve(where.cwd, input.workflowPath) }));
    } catch (error) {
      return textResult(`Error: ${errorMessage(error)}`, true);
    }
  };
  /**
   * Hand a launch to the session that owns this session's runs, through that
   * session's own mount of this package's API. The owner runs it, so the run
   * and its step sessions outlive this session, as a dispatcher's launches must.
   */
  const launchIn = async (owner: string, parameters: LaunchParameters): Promise<LaunchResult> => {
    if (serverHost.context.requestApi === undefined) {
      return textResult(`Error: this host cannot reach session ${owner} to launch the workflow there.`, true);
    }
    const response = await serverHost.context.requestApi(
      { scope: 'session', sessionId: owner },
      WORKFLOW_API_BASE_PATH,
      new Request(`${IN_PROCESS_ORIGIN}${routes.launch.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parameters),
      }),
    );
    const body: unknown = await response.json().catch((error: unknown) => ({ error: String(error) }));
    if (response.ok && isLaunchResponse(body)) return textResult(body.text, body.isError === true);
    const reason = errorOf(body) ?? `HTTP ${String(response.status)}`;
    return textResult(`Error: session ${owner} did not launch the workflow (${reason}).`, true);
  };
  /**
   * A workflow dispatcher launches for its root session, the way a CLI
   * dispatcher child does: the same markers name it, and the root runs what
   * it launches. Any other session runs its own launches.
   */
  const dispatcher = isWorkflowDispatcherProcess(host.context.environment);
  const launchOwner = (): string | undefined => {
    if (!dispatcher) return undefined;
    const parent = resolveDispatcherParentSession(host.context.environment);
    if (parent === undefined) return undefined;
    const owner = resolveRootSessionId(parent, host.context.environment);
    return owner === host.context.sessionId ? undefined : owner;
  };
  /** Sessions this one is creating to hand launches to; they count toward its capacity before their runs register. */
  let creatingWorkflowSessions = 0;
  /** A host that can create a session and reach its API, for a session that is not itself a workflow session. */
  const canHandOff = (): boolean =>
    !workflowSession && sessionService !== undefined && serverHost.context.requestApi !== undefined;
  /**
   * Create a workflow session under this one and hand it the launch, so the
   * run, its step sessions and its owner agent live there, nested under this
   * session in the rail. The launch is checked here first: a refused launch
   * creates nothing.
   */
  const launchInWorkflowSession = async (
    parameters: LaunchParameters,
    where: LaunchLocation = host.context,
  ): Promise<LaunchResult> => {
    let input: WorkflowLaunchInput;
    try {
      input = feature.runTool.getInputSchema().parse(parameters);
    } catch (error) {
      return textResult(`Error: ${errorMessage(error)}`, true);
    }
    const refusal = refuseLaunch(input, where);
    if (refusal !== undefined) return textResult(`Error: ${refusal}`, true);
    const self = host.context.sessionId;
    const running = readWorkflowRuns({ environment: host.context.environment }).filter(
      (run) =>
        run.view.stage === 'running' &&
        run.view.stale !== true &&
        (runBelongsToSession(run, self) || runLaunchedBySession(run, self)),
    ).length;
    const ceiling = resolveMaxConcurrent(host.context.environment);
    if (running + creatingWorkflowSessions >= ceiling) {
      return textResult(
        `Error: This session is at capacity: ${String(running + creatingWorkflowSessions)}/${String(ceiling)} workflows running.`,
        true,
      );
    }
    const workflowPath = resolve(where.cwd, input.workflowPath);
    creatingWorkflowSessions += 1;
    let child: string | undefined;
    try {
      const entry = (await catalogReader.read(where.cwd)).find((candidate) => candidate.path === workflowPath);
      const name = workflowSessionName(workflowPath, entry?.name);
      // No environment: nothing of this session's is copied, and no root-session marker moves ownership back here.
      const scope = await sessionService!.create({
        cwd: where.cwd,
        name,
        parentSessionId: self,
        sessionProvenance: WORKFLOW_SESSION_PROVENANCE,
        selection: { minorModes: [WORKFLOW_MODE_ID] },
      });
      child = scope.sessionId;
      const result = await launchIn(child, {
        ...parameters,
        workflowPath,
        env: { ...input.env, [WORKFLOW_LAUNCHER_SESSION_ENV]: self },
      } as LaunchParameters);
      if (result.isError === true) {
        await sessionService!.close(child).catch(reportLifecycleFailure);
        return result;
      }
      const text = result.content.map((item) => item.text).join('\n');
      return textResult(
        `${text}\nRuns in workflow session "${name}" (${child}), nested under this session. Completion is reported here. Failures wake that workflow session to diagnose locally, without notifying your agent. Recovery requires a request; delegate to its owner with intercom send to "${child}".`,
      );
    } catch (error) {
      if (child !== undefined) await sessionService!.close(child).catch(reportLifecycleFailure);
      return textResult(`Error: ${errorMessage(error)}`, true);
    } finally {
      creatingWorkflowSessions -= 1;
    }
  };
  const launch = async (parameters: LaunchParameters, where?: LaunchLocation): Promise<LaunchResult> => {
    const owner = launchOwner();
    if (owner !== undefined) return launchIn(owner, parameters);
    return canHandOff() ? launchInWorkflowSession(parameters, where) : launchHere(parameters, where);
  };
  /**
   * A launch another session handed this one. A hand-off from a launcher
   * carries its stamp and runs here; any other, such as a dispatcher's, goes
   * through the same routing as a launch made here.
   */
  const launchFromApi = async (parameters: Record<string, unknown>): Promise<WorkflowLaunchResponse> => {
    const env = parameters.env;
    const handedOff =
      typeof env === 'object' &&
      env !== null &&
      typeof (env as Record<string, unknown>)[WORKFLOW_LAUNCHER_SESSION_ENV] === 'string';
    const result = handedOff
      ? await launchHere(parameters as LaunchParameters)
      : await launch(parameters as LaunchParameters);
    // No tool call ends here to refresh the panel, so publish the new run now.
    publishRunsSoon(host.context);
    return {
      text: result.content.map((item) => item.text).join('\n'),
      ...(result.isError === true ? { isError: true } : {}),
    };
  };
  /**
   * A workflow session asks to be released after an untouched success. Only
   * the hub-attached source is trusted, and the registry, not the message,
   * decides: every run it owns succeeded and one was launched from here.
   */
  const releaseWorkflowSession = async (source: string): Promise<void> => {
    if (sessionService?.release === undefined) return;
    const owned = readWorkflowRuns({ environment: host.context.environment }).filter((run) =>
      runBelongsToSession(run, source),
    );
    const succeeded = (run: ParsedWorkflowRun): boolean =>
      run.view.stage === 'completed' &&
      (run.view.outcome === undefined || run.view.outcome === 'success' || run.view.outcome === 'skipped');
    if (owned.length === 0 || !owned.every(succeeded)) return;
    if (!owned.some((run) => runLaunchedBySession(run, host.context.sessionId))) return;
    await sessionService.release(source);
    void telemetry.recordEvent('doom_workflow.session_released', { outcome: 'released' });
  };
  const stopReleaseRequests = communication?.subscribe(WORKFLOW_SESSION_RELEASE_TYPE, (source) => {
    releaseWorkflowSession(source).catch(reportLifecycleFailure);
  });
  // A session hears its children only once it has said it is ready to.
  const stopPeerReady = communication?.onPeerReady(() => undefined);
  let control: ReturnType<typeof feature.createRunControl> | undefined;
  let controlDisposers: (() => void)[] = [];
  const disposeControl = (): void => {
    for (const dispose of controlDisposers.splice(0)) dispose();
    control?.dispose();
    control = undefined;
  };
  let modeOwner: MinorModeOwner | undefined;
  const modeSelected = (): boolean => (host.context.selection.state?.['minor-mode'] ?? []).includes(WORKFLOW_MODE_ID);
  const modeState = (): MinorModeState => {
    const active = modeSelected();
    return {
      activation: active ? 'active' : 'inactive',
      condition: 'ready',
      ...(active ? { detail: 'workflow tools available' } : {}),
      actions: [
        { id: 'activate', enabled: !active, ...(!active ? {} : { disabledReason: 'Workflow mode is active.' }) },
        { id: 'deactivate', enabled: active, ...(active ? {} : { disabledReason: 'Workflow mode is inactive.' }) },
      ],
    };
  };
  const selectMode = async (enabled: boolean): Promise<void> => {
    const modes = (host.context.selection.state?.['minor-mode'] ?? []).filter((mode) => mode !== WORKFLOW_MODE_ID);
    await host.changeSelection({
      axis: 'state',
      key: 'minor-mode',
      values: enabled ? [...modes, WORKFLOW_MODE_ID] : modes,
    });
    modeOwner?.publish();
  };
  modeOwner = defineMinorMode({
    descriptor: {
      source: SOURCE,
      id: WORKFLOW_MODE_ID,
      label: 'Workflow',
      description: 'Workflow discovery, launch, inspection, control, and recovery tools.',
      order: 20,
      actions: [
        {
          id: 'activate',
          label: 'Activate',
          description: 'Enable workflow tools for this session.',
          contexts: ['headless'],
          parameters: [],
        },
        {
          id: 'deactivate',
          label: 'Deactivate',
          description: 'Disable workflow tools without stopping active runs.',
          contexts: ['headless'],
          parameters: [],
        },
      ],
    },
    state: modeState,
    async handleAction(_runtime, actionId, _argumentsValue, execution) {
      execution.signal.throwIfAborted();
      if (actionId === 'activate') {
        await selectMode(true);
        return { message: 'Workflow mode activated.' };
      }
      if (actionId === 'deactivate') {
        await selectMode(false);
        return { message: 'Workflow mode deactivated.' };
      }
      throw new Error(`Unknown workflow mode action: ${actionId}`);
    },
  }).createOwner(undefined);
  return {
    api: [createWorkflowApi(launchFromApi)],
    services: [
      serverMinorModes([modeOwner]),
      (context) => {
        const provider = registerRunProvider(context);
        runProvider = provider;
        return () => {
          provider.dispose();
          if (runProvider === provider) runProvider = undefined;
        };
      },
    ],
    hooks: [
      {
        event: 'tool_execution_end',
        handle: async (_event, executionContext) => {
          await publishLifecycle(executionContext);
        },
      },
      {
        when: { state: { 'minor-mode': WORKFLOW_MODE_ID }, attribution: { kind: 'minor', mode: WORKFLOW_MODE_ID } },
        event: 'session_shutdown',
        handle: disposeControl,
      },
      // Routed by position (hook/*.server.ts): new hooks go at the end.
      {
        event: 'session_start',
        handle: async () => {
          // A woken workflow session comes back without the modes it was created with.
          if (workflowSession && !modeSelected()) await selectMode(true);
        },
      },
      {
        event: 'agent_start',
        handle: () => {
          lifecycle?.agentStarted();
        },
      },
    ],
    resources: [
      {
        when: { state: { 'minor-mode': WORKFLOW_MODE_ID }, attribution: { kind: 'minor', mode: WORKFLOW_MODE_ID } },
        name: 'doompi-author-workflow',
        kind: 'skill',
        read: () => skill('doompi-author-workflow'),
      },
      {
        when: { state: { 'minor-mode': WORKFLOW_MODE_ID }, attribution: { kind: 'minor', mode: WORKFLOW_MODE_ID } },
        name: 'doompi-use-workflow',
        kind: 'skill',
        read: () => skill('doompi-use-workflow'),
      },
      {
        when: { state: { 'minor-mode': WORKFLOW_MODE_ID }, attribution: { kind: 'minor', mode: WORKFLOW_MODE_ID } },
        name: 'workflow-recovery',
        kind: 'skill',
        read: () => skill('workflow-recovery'),
      },
      {
        when: { state: { 'minor-mode': WORKFLOW_MODE_ID }, attribution: { kind: 'minor', mode: WORKFLOW_MODE_ID } },
        name: 'workflow-session',
        kind: 'context',
        // Live state: rebuilt from the registry on every turn, so it survives a wake and never goes stale.
        read: (executionContext) =>
          workflowSession
            ? workflowSessionBrief(
                presentWorkflowRuns(
                  readWorkflowRuns({ environment: executionContext.environment })
                    .filter((run) => runBelongsToSession(run, executionContext.sessionId))
                    .map((run) => run.view),
                  Date.now(),
                ),
              )
            : '',
      },
    ],
    activities: [
      {
        when: { state: { 'minor-mode': WORKFLOW_MODE_ID }, attribution: { kind: 'minor', mode: WORKFLOW_MODE_ID } },
        name: SOURCE,
        async start(executionContext) {
          const reportFailure = (error: unknown): void => {
            process.emitWarning(`Could not publish headless workflow state: ${String(error)}`);
          };
          const stopFor =
            (ownedControl: NonNullable<typeof control>): (() => void) =>
            () => {
              void publishLifecycle(executionContext)
                .then((active) => {
                  if (!active && !modeSelected() && control === ownedControl) disposeControl();
                })
                .catch(reportFailure);
            };
          if (control !== undefined) {
            const ownedControl = control;
            await publishLifecycle(executionContext);
            return stopFor(ownedControl);
          }
          control = feature.createRunControl({});
          const ownedControl = control;
          const refresh = (): void => {
            publishRunsSoon(executionContext, (active) => {
              if (!active && !modeSelected() && control === ownedControl) disposeControl();
            });
          };
          // Job and step transitions live only in the progress log. A step's execution
          // ref, which tells the web view to show an agent session instead of a
          // terminal, lands there after the step started, with no run record change.
          controlDisposers = [
            ownedControl.on('runStarted', refresh),
            ownedControl.on('runUpdated', refresh),
            ownedControl.on('runFinished', refresh),
            ownedControl.on('job', refresh),
            ownedControl.on('step', refresh),
          ];
          try {
            await ownedControl.start();
            await publishLifecycle(executionContext);
            return stopFor(ownedControl);
          } catch (error) {
            if (control === ownedControl) disposeControl();
            throw error;
          }
        },
      },
    ],
    tools: [
      {
        when: { state: { 'minor-mode': WORKFLOW_MODE_ID }, attribution: { kind: 'minor', mode: WORKFLOW_MODE_ID } },
        name: LIST_TOOL,
        label: 'List Workflows',
        description: 'List workflow definitions in this repository, not existing runs.',
        promptGuidelines: ['Use list_workflows to discover definitions, not to find an existing run.'],
        parameters: z.toJSONSchema(feature.listWorkflowsTool.getInputSchema()),
        executionMode: 'serial',
        async execute(_toolCallId, parameters, signal, _onUpdate, context) {
          signal?.throwIfAborted();
          const input = parameters as Parameters<typeof feature.listWorkflowsTool.execute>[0];
          return callResult(
            await feature.listWorkflowsTool.execute({
              ...input,
              directory:
                input?.directory === undefined
                  ? context.cwd
                  : typeof input.directory === 'string'
                    ? resolve(context.cwd, input.directory)
                    : input.directory,
            }),
          );
        },
      },
      {
        when: { state: { 'minor-mode': WORKFLOW_MODE_ID }, attribution: { kind: 'minor', mode: WORKFLOW_MODE_ID } },
        name: LAUNCH_TOOL,
        label: 'Launch Workflow',
        description:
          'Start a workflow run. Prefer in-process Pi execution with command: "pi" when supported; runner: "codex" is not an alias for it. A successful launch is not a completed workflow.',
        promptGuidelines: [
          'Before launching, inspect the workflow and its imports for commands and interactiveRun choices. Prefer a supported Pi template with inProcess: true, selected explicitly with command: "pi" (or a supported in-process "pi-claude" command when requested). Only use an external CLI when the user requests it or no in-process option exists.',
          'command selects the exact template. Without it, runner only matches an exact command name; otherwise each step uses its first command. runner: "codex" does not imply command: "pi", so pass command explicitly to avoid switching to "claude" on later steps.',
          'Launch returns when a run starts, not when it finishes. Use the exact run key and separate workspace from its launch result for workflow_run status, not Agiflow project or job identifiers.',
          'Do not relaunch a healthy running workflow merely because it has not completed.',
        ],
        parameters: z.toJSONSchema(feature.runTool.getInputSchema()),
        executionMode: 'serial',
        async execute(_toolCallId, parameters, signal, _onUpdate, context) {
          signal?.throwIfAborted();
          const input = parameters as Parameters<typeof feature.runTool.execute>[0];
          return callResult(
            await launch(
              {
                ...input,
                ...(typeof input.workflowPath === 'string'
                  ? { workflowPath: resolve(context.cwd, input.workflowPath) }
                  : {}),
              },
              context,
            ),
          );
        },
      },
      {
        when: { state: { 'minor-mode': WORKFLOW_MODE_ID }, attribution: { kind: 'minor', mode: WORKFLOW_MODE_ID } },
        name: RUN_TOOL,
        label: 'Workflow Run',
        description:
          'Inspect a session-owned workflow by exact run key and separate workspace, or request cooperative control.',
        promptGuidelines: [
          'Use workflow_run status for the recorded stage, outcome, position, jobs, and steps. A successful status lookup is not evidence that the workflow completed.',
          'For a healthy running workflow, summarize the recorded progress. Do not automatically search CLI commands or filesystem logs, relaunch, or diagnose failure merely because it remains running.',
          'Investigate further when the run reports failure or staleness, or when the user requests diagnostics. Only status, pause, resume, and stop are supported here; stop only on user request.',
          'Use exact registry runKey and separate workspace from the launch or status result. Agiflow project and job identifiers are not workflow run keys.',
        ],
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['status', 'pause', 'resume', 'stop'] },
            runKey: {
              type: 'string',
              minLength: 1,
              description:
                'Exact registry run key from the launch result, without the workspace prefix. Not an Agiflow job ID.',
            },
            workspace: {
              type: 'string',
              description: 'Workspace from the launch result, passed separately from runKey.',
            },
            reason: { type: 'string' },
            expectedRunId: { type: 'string' },
          },
          required: ['action', 'runKey'],
          additionalProperties: false,
        },
        executionMode: 'serial',
        async execute(_toolCallId, parameters, signal) {
          signal?.throwIfAborted();
          const input = parameters as unknown as {
            action: 'status' | 'pause' | 'resume' | 'stop';
            runKey: string;
            workspace?: string;
            reason?: string;
            expectedRunId?: string;
          };
          const runs = readWorkflowRuns({ environment: host.context.environment }).filter(
            (run) =>
              (runBelongsToSession(run, host.context.sessionId) || runLaunchedBySession(run, host.context.sessionId)) &&
              run.view.runKey === input.runKey &&
              (input.workspace === undefined || run.view.workspace === input.workspace),
          );
          if (runs.length !== 1)
            return {
              ...callResult({
                error:
                  runs.length === 0
                    ? 'No matching workflow run was found in this session. This is a lookup failure, not evidence that the workflow failed. Use the exact runKey and separate workspace from its launch result, not Agiflow job identifiers.'
                    : 'Specify the workspace for this run key.',
              }),
              isError: true,
            };
          const run = runs[0]!.view;
          if (input.action === 'status') return callResult(run);
          if (!runBelongsToSession(runs[0]!, host.context.sessionId)) {
            return callResult({
              error: `This run belongs to workflow session ${run.ownerSessionId ?? 'unknown'}; pause, resume or stop it there.`,
            });
          }
          if (!control) return callResult({ error: 'Workflow activity is not active.' });
          if (typeof input.expectedRunId !== 'string' || input.expectedRunId.length === 0) {
            return callResult({ error: 'expectedRunId is required for workflow control.' });
          }
          const request =
            input.action === 'pause'
              ? await control.pause(input.runKey, input.expectedRunId, input.workspace, input.reason)
              : input.action === 'resume'
                ? await control.resume(input.runKey, input.expectedRunId, input.workspace)
                : await control.stop(input.runKey, input.expectedRunId, input.workspace, input.reason);
          return callResult(request);
        },
      },
      {
        when: { state: { 'minor-mode': WORKFLOW_MODE_ID }, attribution: { kind: 'minor', mode: WORKFLOW_MODE_ID } },
        name: WORKFLOW_TOOLS_TOOL_NAME,
        label: 'Workflow Tools',
        description:
          "Workflow actions beyond workflow_run: recovery-evidence reads a failed run's durable evidence, including one an earlier session launched; recover resumes it from its active repair in this session.",
        promptGuidelines: [
          'Load workflow-recovery and read recovery-evidence before recover; recover is not a fresh launch.',
          'A recover answer means the replay started, not that it succeeded; verify with workflow_run status.',
          'Already claimed means another recovery won: do not retry or launch fresh. Never edit issue.md or repair.json.',
        ],
        parameters: z.toJSONSchema(workflowToolsInputSchema),
        executionMode: 'serial',
        async execute(_toolCallId, parameters, signal) {
          try {
            signal?.throwIfAborted();
            const input = workflowToolsInputSchema.parse(parameters);
            const matches = (await feature.registry.listRuns(input.workspace)).filter(
              (record) => record.runKey === input.runKey && record.stage === 'error',
            );
            if (matches.length > 1)
              throw new Error('Run key exists in more than one workspace; retry with its workspace.');
            const record = matches[0];
            if (!record)
              throw new Error(
                'No failed workflow run matches this key; do not recover a running or completed workflow.',
              );
            const owner = record.env?.PI_SESSION_ID;
            if (
              input.action === 'recover' &&
              owner !== undefined &&
              owner !== host.context.sessionId &&
              sessionService?.isLive(owner) === true
            ) {
              throw new Error(`Run ${record.runKey} belongs to live workflow session ${owner}; recover it there.`);
            }
            if (input.action === 'recover')
              return launchResultOf(
                await launcher.recover(
                  { runKey: record.runKey, workspace: record.workspace },
                  { dryRun: input.dryRun, runner: input.runner },
                ),
              );
            void telemetry.recordEvent('doom_workflow.recovery_evidence_requested', { outcome: 'requested' });
            // ponytail: mirrors the TUI evidence tail; extract if a third caller appears.
            const sections: string[] = [];
            for (const name of ['changelog.md', 'context.md', 'progress.ndjson']) {
              try {
                const bytes = await readFile(join(feature.registry.runDirectoryFor(record), name));
                sections.push(`--- ${name} ---\n${bytes.subarray(-64 * 1024).toString('utf8')}`);
              } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
              }
            }
            const text = `Workflow: ${record.displayName} (${record.runKey})\n${sections.length ? '' : 'No durable evidence files found.\n'}--- run.json ---\n${JSON.stringify(record, null, 2)}${sections.length ? '\n' + sections.join('\n') : ''}`;
            return { content: [{ type: 'text', text }] };
          } catch (error) {
            return {
              content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
              isError: true,
            };
          }
        },
      },
    ],
    commands: [
      {
        when: { state: { 'minor-mode': WORKFLOW_MODE_ID }, attribution: { kind: 'minor', mode: WORKFLOW_MODE_ID } },
        name: 'workflow-launch',
        description: 'Launch a workflow from a slash command.',
        async execute(args: string, execution: DoomHeadlessExecutionContext) {
          const parsed = parseWorkflowLaunchCommand(args);
          if ('error' in parsed) {
            await execution.client.notify({ body: parsed.error, level: 'error' });
            return;
          }
          try {
            const entry = resolveWorkflowEntry(await catalogReader.read(execution.cwd), parsed.workflow);
            if (!entry || entry.error) {
              await execution.client.notify({
                body: entry?.error
                  ? needsFixingNotice(entry.name, entry.error)
                  : `Workflow not found: ${parsed.workflow}`,
                level: 'error',
              });
              return;
            }
            const problems = validateWorkflowLaunch(entry, parsed);
            if (problems.length > 0) {
              await execution.client.notify({ body: problems.join('\n'), level: 'error' });
              return;
            }
            const result = callResult(
              await launch(
                {
                  workflowPath: entry.path,
                  ...(parsed.runner === undefined ? {} : { runner: parsed.runner }),
                  ...(parsed.command === undefined ? {} : { command: parsed.command }),
                  ...(parsed.choice === undefined ? {} : { choice: parsed.choice }),
                  ...(Object.keys(parsed.inputs).length === 0 ? {} : { inputs: parsed.inputs }),
                  ...(parsed.prompt === undefined ? {} : { prompt: parsed.prompt }),
                },
                execution,
              ),
            );
            const rendered = result.content.find((item) => item.type === 'text');
            await execution.client.notify({
              body: rendered?.type === 'text' ? rendered.text : 'Workflow launch requested.',
              level: result.isError ? 'error' : 'info',
            });
          } catch (error) {
            await execution.client.notify({ body: String(error), level: 'error' });
          }
        },
      },
    ],
    // A dispatcher launches for its root and never works a run itself, as a CLI dispatcher child.
    ...(dispatcher ? { toolRestrictions: [{ excludedTools: [RUN_TOOL, WORKFLOW_TOOLS_TOOL_NAME] }] } : {}),
    async onDispose() {
      disposeControl();
      lifecycle?.dispose();
      stopReleaseRequests?.();
      stopPeerReady?.();
      if (runsTimer !== undefined) clearTimeout(runsTimer);
      runsTimer = undefined;
      runsAfter = undefined;
      // Runs this session is running stop with it, rather than going on under a parent that is gone.
      await launcher.dispose();
      runProvider?.dispose();
      runProvider = undefined;
      await telemetry.shutdown();
    },
  };
}
