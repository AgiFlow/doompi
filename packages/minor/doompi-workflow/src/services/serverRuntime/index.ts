import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  type DoomHeadlessExecutionContext,
  type DoomHeadlessContent,
  type DoomHeadlessToolResult,
} from '@agimon-ai/doompi-core/headless';
import { serverMinorModes } from '@agimon-ai/doompi-minor-mode';
import { defineMinorMode, type MinorModeOwner, type MinorModeState } from '@agimon-ai/doompi-minor-mode';
import { createEmbeddedWorkflowFeature } from '@agimon-ai/workflow-mcp';
import { z } from 'zod';

import { WORKFLOW_LAUNCH_SESSION_ENV } from '../../constants/workflow';
import { registerRunProvider, type RunProviderHandle } from '../../services/backgroundWork';
import { createNativeStepPaneLauncher, createStepExecutor } from '../../services/stepExecutor';
import { createWorkflowCatalogReader, presentWorkflowCatalog } from '../../services/webWorkflowCatalog';
import { defaultCatalogDeps } from '../../services/workflowCatalogDeps';
import { createWorkflowApi } from '../../services/workflowHubApi';
import {
  parseWorkflowLaunchCommand,
  resolveWorkflowEntry,
  validateWorkflowLaunch,
} from '../../services/workflowLaunchCommand';
import { readWorkflowSkill as skill } from '../../services/workflowResource';
import { PI_SESSION_ENV, presentWorkflowRuns, runBelongsToSession } from '../../services/workflowRuns';
import { readWorkflowRuns } from '../../services/workflowWatcher';
import routes from '../../types/apiRoutes';
import { WORKFLOW_CATALOG_TYPE, WORKFLOW_RUNS_TYPE } from '../../types/webWorkflows';
import { WORKFLOW_API_BASE_PATH, type WorkflowLaunchResponse } from '../../types/webWorkflowTerminal';

const SOURCE = '@agimon-ai/doompi-workflow';
const WORKFLOW_MODE_ID = 'workflow';
const LIST_TOOL = 'list_workflows';
const LAUNCH_TOOL = 'launch_workflow';
const RUN_TOOL = 'workflow_run';
/** How often the registry is asked whether an in-process launch has registered its run. */
const LAUNCH_ACK_POLL_MS = 250;
/** How long a launch waits for that before answering without a run key. */
const LAUNCH_ACK_TIMEOUT_MS = 15_000;
/** Tolerance for a run stamping its start a moment before the launch clock read. */
const LAUNCH_ACK_CLOCK_SKEW_MS = 1_000;
/** Origin of a request dispatched in process to another mount; nothing resolves it. */
const IN_PROCESS_ORIGIN = 'http://doompi.local';

type LaunchResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

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

/** Resolves undefined after `ms`, so a race against it reads as "nothing settled yet". */
function sleep(ms: number): Promise<undefined> {
  return new Promise((settle) => {
    const timer = setTimeout(() => settle(undefined), ms);
    timer.unref?.();
  });
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
  const catalogReader = createWorkflowCatalogReader(defaultCatalogDeps());
  const publishLifecycle = async (executionContext: typeof host.context): Promise<boolean> => {
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
    return activeItems.length > 0;
  };
  // Steps run in this process: customRun as child sessions of this one, commands in their own panes.
  const sessionService = serverHost.context.sessionService;
  const feature = createEmbeddedWorkflowFeature(
    sessionService === undefined
      ? {}
      : {
          stepExecutor: createStepExecutor({
            sessionService,
            parentSessionId: host.context.sessionId,
            hostEnvironment: process.env,
            launchPane: createNativeStepPaneLauncher(),
            createId: () => `workflow-${randomUUID()}`,
          }),
        },
  );
  type LaunchParameters = Parameters<typeof feature.runTool.execute>[0];
  /**
   * Run a workflow in this process and answer once it has registered.
   *
   * `skipLaunch` keeps `launch-command` from handing the run to a terminal
   * launcher, where the host's step executor could not reach it. Each run gets
   * a service of its own so concurrent runs never share an active step, and the
   * caller hears back when the registry shows the run rather than when it ends.
   */
  const launchHere = async (parameters: LaunchParameters): Promise<LaunchResult> => {
    const input = feature.runTool.getInputSchema().parse(parameters);
    const sessionId = host.context.sessionId;
    const since = Date.now();
    const runner = input.runner ?? input.cliAgent;
    const running = feature.createRunService().run({
      ...input,
      ...(runner === undefined ? {} : { runner }),
      env: { ...input.env, [PI_SESSION_ENV]: sessionId },
      skipLaunch: true,
    });
    // Folded before anything races it: a run this function stops awaiting must
    // never reject unobserved and take the server down with it.
    const settled = running.then(
      (result) =>
        result.exitCode === 0 || result.exitCode === 2
          ? textResult(result.output || 'Workflow completed.')
          : textResult(`Workflow failed (exit code ${result.exitCode}):\n\n${result.output}`, true),
      (error: unknown) => textResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true),
    );
    const deadline = since + LAUNCH_ACK_TIMEOUT_MS;
    for (;;) {
      const outcome = await Promise.race([settled, sleep(LAUNCH_ACK_POLL_MS)]);
      if (outcome) return outcome;
      const registered = readWorkflowRuns({ environment: host.context.environment }).find(
        (run) =>
          runBelongsToSession(run, sessionId) &&
          Date.parse(run.view.startedAt) >= since - LAUNCH_ACK_CLOCK_SKEW_MS &&
          resolve(run.view.workflowPath) === resolve(input.workflowPath),
      );
      if (registered) {
        return textResult(
          [
            `Started ${registered.view.displayName} in workspace ${registered.view.workspace}.`,
            `Run key: ${registered.view.runKey}`,
            'The run is registered and going in this server; this call returned without waiting for it to finish.',
          ].join('\n'),
        );
      }
      if (Date.now() >= deadline) {
        return textResult(`Launch started for ${input.workflowPath}, but no run has registered yet.`);
      }
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
  const launch = async (parameters: LaunchParameters): Promise<LaunchResult> => {
    const owner = host.context.environment[WORKFLOW_LAUNCH_SESSION_ENV]?.trim();
    return owner === undefined || owner === '' || owner === host.context.sessionId
      ? launchHere(parameters)
      : launchIn(owner, parameters);
  };
  /** A launch another session handed this one: this session runs and owns it. */
  const launchFromApi = async (parameters: Record<string, unknown>): Promise<WorkflowLaunchResponse> => {
    try {
      const result = await launchHere(parameters as LaunchParameters);
      // No tool call ends here to refresh the panel, so publish the new run now.
      void publishLifecycle(host.context).catch((error: unknown) => {
        process.emitWarning(`Could not publish headless workflow state: ${String(error)}`);
      });
      return {
        text: result.content.map((item) => item.text).join('\n'),
        ...(result.isError === true ? { isError: true } : {}),
      };
    } catch (error) {
      return { text: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
  };
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
            void publishLifecycle(executionContext)
              .then((active) => {
                if (!active && !modeSelected() && control === ownedControl) disposeControl();
              })
              .catch(reportFailure);
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
        description: 'Start a workflow run. A successful launch is not a completed workflow.',
        promptGuidelines: [
          'Launch returns when a run starts, not when it finishes. Use the exact run key and separate workspace from its launch result for workflow_run status, not Agiflow project or job identifiers.',
          'Do not relaunch a healthy running workflow merely because it has not completed.',
        ],
        parameters: z.toJSONSchema(feature.runTool.getInputSchema()),
        executionMode: 'serial',
        async execute(_toolCallId, parameters, signal, _onUpdate, context) {
          signal?.throwIfAborted();
          const input = parameters as Parameters<typeof feature.runTool.execute>[0];
          return callResult(
            await launch({
              ...input,
              ...(typeof input.workflowPath === 'string'
                ? { workflowPath: resolve(context.cwd, input.workflowPath) }
                : {}),
            }),
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
              runBelongsToSession(run, host.context.sessionId) &&
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
                body: entry?.error ?? `Workflow not found: ${parsed.workflow}`,
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
              await launch({
                workflowPath: entry.path,
                ...(parsed.runner === undefined ? {} : { runner: parsed.runner }),
                ...(Object.keys(parsed.inputs).length === 0 ? {} : { inputs: parsed.inputs }),
                ...(parsed.prompt === undefined ? {} : { prompt: parsed.prompt }),
              }),
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
    onDispose() {
      disposeControl();
      runProvider?.dispose();
      runProvider = undefined;
    },
  };
}
