import { resolve } from 'node:path';
import { type EmbeddedWorkflowFeature, type Workflow } from '@agimon-ai/workflow-mcp';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  type DispatchInput,
  workflowCatalogPageSchema,
  workflowDispatchInputsSchema,
} from '../../../schemas/workflowPi.ts';
import type {
  WorkflowCatalogDetail,
  WorkflowInputSummary,
  WorkflowJobSummary,
} from '../../../tui/workflow/workflowCatalog';
import { toolResultText } from './piToolBridge';
import { type WorkflowLaunchExecutor, type WorkflowLaunchInput } from './piTools';

const CATALOG_PAGE_SIZE = 100;
const USER_PROMPT_TRIGGER = 'user_prompt';
const WORKFLOW_DISPATCH_TRIGGER = 'workflow_dispatch';
const BOOLEAN_INPUT_TYPE = 'boolean';

type WorkflowListTool = EmbeddedWorkflowFeature['listWorkflowsTool'];
type WorkflowListInput = Parameters<WorkflowListTool['execute']>[0];

export interface WorkflowCatalogEntry {
  description: string;
  name: string;
  path: string;
  relativePath: string;
  tags: string[];
}

export interface WorkflowCatalogPage {
  directory: string;
  hasNextPage: boolean;
  page: number;
  pageSize: number;
  workflows: WorkflowCatalogEntry[];
}

export interface WorkflowLauncherUi {
  editor(title: string, prefill?: string): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
  select(title: string, options: string[]): Promise<string | undefined>;
}

export interface WorkflowEntryLaunchOptions {
  compatibleRunners(workflow: Workflow): string[] | undefined;
  launch: WorkflowLaunchExecutor['execute'];
  parseWorkflow(workflowPath: string): Workflow;
  ui: WorkflowLauncherUi;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function workflowTriggerBlock(workflow: Workflow): Record<string, unknown> {
  return asRecord(workflow.on);
}

function dispatchInputs(workflow: Workflow): Record<string, DispatchInput> {
  const dispatch = workflowTriggerBlock(workflow)[WORKFLOW_DISPATCH_TRIGGER];
  if (dispatch === null || dispatch === undefined) return {};
  const parsed = workflowDispatchInputsSchema.safeParse(dispatch);
  if (!parsed.success) throw new Error(`Invalid workflow_dispatch input definitions: ${parsed.error.message}`);
  return parsed.data.inputs ?? {};
}

function launchResultError(result: CallToolResult): Error {
  return new Error(toolResultText(result) || 'Workflow launch failed.');
}

export function parseWorkflowCatalogPage(result: CallToolResult): WorkflowCatalogPage {
  if (result.isError) throw launchResultError(result);
  let value: unknown;
  try {
    value = JSON.parse(toolResultText(result));
  } catch (cause) {
    throw new Error('Workflow catalog returned invalid JSON.', { cause });
  }
  const parsed = workflowCatalogPageSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Workflow catalog response was invalid: ${parsed.error.message}`);
  return {
    directory: parsed.data.directory,
    hasNextPage: parsed.data.hasNextPage,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    workflows: parsed.data.workflows.map((entry) => ({
      description: entry.description,
      name: entry.name,
      path: resolve(parsed.data.directory, entry.path),
      relativePath: entry.path,
      tags: entry.tags,
    })),
  };
}

export async function loadWorkflowCatalog(
  listWorkflowsTool: WorkflowListTool,
  directory: string,
): Promise<WorkflowCatalogEntry[]> {
  const entries: WorkflowCatalogEntry[] = [];
  let page = 1;
  let hasNextPage = true;
  while (hasNextPage) {
    const input: WorkflowListInput = { directory, page, pageSize: CATALOG_PAGE_SIZE };
    const result = await listWorkflowsTool.execute(input);
    const catalogPage = parseWorkflowCatalogPage(result);
    entries.push(...catalogPage.workflows);
    hasNextPage = catalogPage.hasNextPage;
    page += 1;
  }
  return entries;
}

async function requestPrompt(ui: WorkflowLauncherUi): Promise<string | undefined> {
  while (true) {
    const value = await ui.editor('Workflow prompt');
    if (value === undefined) return undefined;
    const prompt = value.trim();
    if (prompt) return prompt;
    ui.notify('A workflow prompt is required.', 'warning');
  }
}

async function requestDispatchInput(
  ui: WorkflowLauncherUi,
  name: string,
  input: DispatchInput,
): Promise<string | undefined> {
  const title = input.description ? `${name}: ${input.description}` : `Workflow input: ${name}`;
  if (input.options && input.options.length > 0) return ui.select(title, input.options);
  if (input.type === BOOLEAN_INPUT_TYPE) return ui.select(title, ['true', 'false']);

  while (true) {
    const value = await ui.input(title, input.default);
    if (value === undefined) return undefined;
    const normalized = value.trim() || input.default;
    if (normalized || !input.required) return normalized || undefined;
    ui.notify(`A value is required for workflow input ${name}.`, 'warning');
  }
}

export async function collectWorkflowInputs(
  workflow: Workflow,
  ui: WorkflowLauncherUi,
): Promise<{ inputs?: Record<string, string>; prompt?: string } | undefined> {
  const triggers = workflowTriggerBlock(workflow);
  const requiresPrompt = Object.hasOwn(triggers, USER_PROMPT_TRIGGER);
  const prompt = requiresPrompt ? await requestPrompt(ui) : undefined;
  if (requiresPrompt && prompt === undefined) return undefined;

  const definitions = dispatchInputs(workflow);
  const inputs: Record<string, string> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const value = await requestDispatchInput(ui, name, definition);
    if (value === undefined && definition.required) return undefined;
    if (value !== undefined) inputs[name] = value;
  }
  return {
    ...(prompt === undefined ? {} : { prompt }),
    ...(Object.keys(inputs).length === 0 ? {} : { inputs }),
  };
}

/**
 * Everything a launch needs once the workflow is chosen: the runner, the
 * prompt, and any `workflow_dispatch` inputs, each asked for through the
 * host's own dialogs. Selection is the caller's business - `SPC w l` launches
 * the row under its cursor, so this takes an entry rather than picking one.
 */
function stepLabel(step: { name?: string; uses?: string; run?: unknown; id?: string }, index: number): string {
  if (step.name) return step.name;
  if (step.uses) return step.uses;
  if (step.id) return step.id;
  // A `run:` step without a name is identified by its position; printing the
  // command would put a shell line into a summary pane.
  return `step ${index + 1}`;
}

function catalogInputs(workflow: Workflow): WorkflowInputSummary[] {
  return Object.entries(dispatchInputs(workflow)).map(([name, definition]) => ({
    name,
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.required === undefined ? {} : { required: definition.required }),
    ...(definition.default === undefined ? {} : { default: definition.default }),
    ...(definition.options ? { options: definition.options } : {}),
  }));
}

function catalogJobs(workflow: Workflow): WorkflowJobSummary[] {
  return Object.entries(workflow.jobs ?? {}).map(([name, job]) => ({
    name,
    ...(job['runs-on'] ? { runsOn: job['runs-on'] } : {}),
    steps: (job.steps ?? []).map((step, index) => stepLabel(step, index)),
  }));
}

/**
 * The parsed shape `SPC w l`'s detail pane shows. A parse failure is returned
 * as `error` rather than thrown: one unparseable file in a repository must not
 * take the whole board down.
 */
export function summarizeWorkflowFile(
  workflowPath: string,
  options: Pick<WorkflowEntryLaunchOptions, 'compatibleRunners' | 'parseWorkflow'>,
): WorkflowCatalogDetail {
  try {
    const workflow = options.parseWorkflow(workflowPath);
    const runners = options.compatibleRunners(workflow);
    return {
      triggers: Object.keys(workflowTriggerBlock(workflow)),
      inputs: catalogInputs(workflow),
      jobs: catalogJobs(workflow),
      ...(runners ? { runners } : {}),
    };
  } catch (cause) {
    return {
      triggers: [],
      inputs: [],
      jobs: [],
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export async function launchWorkflowEntry(
  options: WorkflowEntryLaunchOptions,
  selected: Pick<WorkflowCatalogEntry, 'path'>,
  ctx: ExtensionContext,
): Promise<CallToolResult | undefined> {
  const workflow = options.parseWorkflow(selected.path);
  const runners = options.compatibleRunners(workflow);
  if (runners && runners.length === 0) throw new Error('No compatible runner is available for this workflow.');
  let runner: string | undefined;
  if (runners) {
    runner = await options.ui.select('Select a workflow runner', runners);
    if (runner === undefined) return undefined;
  }

  const triggerInputs = await collectWorkflowInputs(workflow, options.ui);
  if (triggerInputs === undefined) return undefined;
  const launchInput: WorkflowLaunchInput = {
    workflowPath: selected.path,
    ...(runner === undefined ? {} : { runner }),
    ...(typeof workflow.workspace === 'string' ? { workspace: workflow.workspace } : {}),
    ...triggerInputs,
  };
  return options.launch(launchInput, ctx);
}
