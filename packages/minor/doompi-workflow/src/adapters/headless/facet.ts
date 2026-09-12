import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessContent,
  type DoomHeadlessToolResult,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { DOOM_SERVER_HOST_SERVICE, requireDoomServerHost } from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { MinorModeOwnerHandle, MinorModeState } from '@agimon-ai/doompi-extension-contracts/mode';
import type { Context } from '@deepseek-ai/cordis';
import { readFile } from 'node:fs/promises';
import { createEmbeddedWorkflowFeature } from '@agimon-ai/workflow-mcp';
import { z } from 'zod';
import { parseWorkflowLaunchCommand } from '../../services/workflowLaunchCommand.ts';
import { createWorkflowCatalogReader, presentWorkflowCatalog } from '../../services/webWorkflowCatalog.ts';
import { defaultCatalogDeps } from '../workflowCatalogDeps.ts';
import { readWorkflowRuns } from '../workflowWatcher.ts';
import { presentWorkflowRuns, runBelongsToSession } from '../../services/workflowRuns.ts';
import { WORKFLOW_CATALOG_TYPE, WORKFLOW_RUNS_TYPE } from '../../types/webWorkflows.ts';
type HeadlessFacet = {
  inject: readonly string[];
  apply(context: Context): void | (() => void);
};

const SOURCE = '@agimon-ai/doompi-workflow';
const WORKFLOW_MODE_ID = 'workflow';
const LIST_TOOL = 'list_workflows';
const LAUNCH_TOOL = 'launch_workflow';
const RUN_TOOL = 'workflow_run';

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
  return { content, details: value };
}

async function skill(name: string): Promise<string> {
  const root = name === 'workflow-recovery' ? '../../../skills' : '../../prompts';
  return readFile(new URL(`${root}/${name}/SKILL.md`, import.meta.url), 'utf8');
}

export const workflowHeadlessFacet: HeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE, DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const serverHost = requireDoomServerHost(context);
    if (serverHost.context.directEvents === undefined)
      throw new Error('Workflow headless facet requires the session direct event bus.');
    const directEvents = serverHost.context.directEvents;
    const catalogReader = createWorkflowCatalogReader(defaultCatalogDeps());
    const publishLifecycle = async (executionContext: typeof host.context): Promise<void> => {
      const runs = presentWorkflowRuns(
        readWorkflowRuns({ environment: executionContext.environment })
          .filter((run) => runBelongsToSession(run, executionContext.sessionId))
          .map((run) => run.view),
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
    };
    const feature = createEmbeddedWorkflowFeature();
    const statuses = feature.createListStatusesTool({
      recordFilter: (record) => {
        const sessionId = host.context.sessionId;
        return record.env?.PI_SESSION_ID === undefined || record.env.PI_SESSION_ID === sessionId;
      },
    });
    let control: ReturnType<typeof feature.createRunControl> | undefined;
    let modeOwner: MinorModeOwnerHandle | undefined;
    const modeSelected = (): boolean => host.context.selection.minorModes.includes(WORKFLOW_MODE_ID);
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
      const modes = host.context.selection.minorModes.filter((mode) => mode !== WORKFLOW_MODE_ID);
      await host.changeSelection({ axis: 'minorModes', minorModes: enabled ? [...modes, WORKFLOW_MODE_ID] : modes });
      modeOwner?.publish(modeState());
    };
    modeOwner = host.registerMinorMode({
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
      initialState: modeState(),
      async handleAction(actionId, _argumentsValue, execution) {
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
    });
    const toolRestriction = host.registerToolRestriction({
      minorMode: WORKFLOW_MODE_ID,
      allowedTools: [LIST_TOOL, LAUNCH_TOOL, RUN_TOOL],
    });
    const projectionHook = host.registerHook({
      event: 'tool_execution_end',
      handle: async (_event, executionContext) => {
        await publishLifecycle(executionContext);
      },
    });
    const registrations = [
      projectionHook,
      host.registerResource({
        when: { minorMode: WORKFLOW_MODE_ID },
        name: 'doompi-author-workflow',
        kind: 'skill',
        read: () => skill('doompi-author-workflow'),
      }),
      host.registerResource({
        when: { minorMode: WORKFLOW_MODE_ID },
        name: 'doompi-use-workflow',
        kind: 'skill',
        read: () => skill('doompi-use-workflow'),
      }),
      host.registerResource({
        when: { minorMode: WORKFLOW_MODE_ID },
        name: 'workflow-recovery',
        kind: 'skill',
        read: () => skill('workflow-recovery'),
      }),
      host.registerActivity({
        when: { minorMode: WORKFLOW_MODE_ID },
        name: SOURCE,
        async start(executionContext) {
          control = feature.createRunControl({});
          await control.start();
          await publishLifecycle(executionContext);
          return () => {
            control?.dispose();
            control = undefined;
          };
        },
      }),
      host.registerTool({
        when: { minorMode: WORKFLOW_MODE_ID },
        name: LIST_TOOL,
        label: 'List Workflows',
        description: 'List workflow definitions available in this repository.',
        parameters: z.toJSONSchema(feature.listWorkflowsTool.getInputSchema()),
        executionMode: 'serial',
        async execute(_toolCallId, parameters, signal) {
          signal?.throwIfAborted();
          return callResult(
            await feature.listWorkflowsTool.execute(
              parameters as Parameters<typeof feature.listWorkflowsTool.execute>[0],
            ),
          );
        },
      }),
      host.registerTool({
        when: { minorMode: WORKFLOW_MODE_ID },
        name: LAUNCH_TOOL,
        label: 'Launch Workflow',
        description: 'Start a workflow run and return its recorded launch result.',
        parameters: z.toJSONSchema(feature.runTool.getInputSchema()),
        executionMode: 'serial',
        async execute(_toolCallId, parameters, signal) {
          signal?.throwIfAborted();
          return callResult(await feature.runTool.execute(parameters as Parameters<typeof feature.runTool.execute>[0]));
        },
      }),
      host.registerTool({
        when: { minorMode: WORKFLOW_MODE_ID },
        name: RUN_TOOL,
        label: 'Workflow Run',
        description: 'Inspect the status of a workflow run or request cooperative control.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['status', 'pause', 'resume', 'stop'] },
            runKey: { type: 'string', minLength: 1 },
            workspace: { type: 'string' },
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
          if (input.action === 'status')
            return callResult(await statuses.execute({ workspace: input.workspace, pageSize: 100 }));
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
      }),
      host.registerCommand({
        when: { minorMode: WORKFLOW_MODE_ID },
        name: 'workflow-launch',
        description: 'Launch a workflow from a slash command.',
        async execute(args, execution) {
          const parsed = parseWorkflowLaunchCommand(args);
          if ('error' in parsed) {
            await execution.client.notify({ body: parsed.error, level: 'error' });
            return;
          }
          const result = await feature.runTool.execute({
            workflowPath: parsed.workflow,
            ...(parsed.runner === undefined ? {} : { runner: parsed.runner }),
            ...(Object.keys(parsed.inputs).length === 0 ? {} : { inputs: parsed.inputs }),
            ...(parsed.prompt === undefined ? {} : { prompt: parsed.prompt }),
          });
          const rendered = callResult(result).content.find((entry) => entry.type === 'text');
          await execution.client.notify({
            body: rendered?.type === 'text' ? rendered.text : 'Workflow launch requested.',
            level: 'info',
          });
        },
      }),
      host.registerHook({
        when: { minorMode: WORKFLOW_MODE_ID },
        event: 'session_shutdown',
        handle: () => {
          control?.dispose();
          control = undefined;
        },
      }),
    ];
    return () => {
      toolRestriction.dispose();
      modeOwner?.dispose();
      control?.dispose();
      control = undefined;
      registrations.forEach((registration) => registration.dispose());
    };
  },
};

export default workflowHeadlessFacet;
