import type { WorkflowCatalogEntryView } from '../../../../../types/webWorkflows';

/**
 * The `/workflow-launch` line the dialog sends.
 *
 * WHY THE BUILDER LIVES HERE AND THE PARSER DOES NOT:
 * Cockpit code is compiled into the host bundle and may import only this
 * package's own web and type modules, so it cannot share the session's parser.
 * The two are pinned together by a test that parses what this writes, which is
 * the only guarantee that matters: the line has to survive the trip.
 */

export const WORKFLOW_LAUNCH_VERB = '/workflow-launch';
/** Reserved keys; every other pair is one of the workflow's own inputs. */
export const RUNNER_KEY = 'runner';
export const COMMAND_KEY = 'command';
export const CHOICE_KEY = 'choice';

export interface WorkflowLaunchRequest {
  workflow: string;
  runner?: string;
  command?: string;
  choice?: string;
  inputs: Record<string, string>;
  prompt?: string;
}

/** Quotes a value that carries whitespace, which is how a value survives tokenizing. */
function quote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function reservedPair(key: string, value: string | undefined): string[] {
  return value === undefined || value === '' ? [] : [`${key}=${quote(value)}`];
}

export function workflowLaunchLine(request: WorkflowLaunchRequest): string {
  const pairs = [
    ...reservedPair(RUNNER_KEY, request.runner),
    ...reservedPair(COMMAND_KEY, request.command),
    ...reservedPair(CHOICE_KEY, request.choice),
    ...Object.entries(request.inputs)
      .filter(([, value]) => value !== '')
      .map(([key, value]) => `${key}=${quote(value)}`),
  ];
  const prompt = request.prompt?.trim();
  return [WORKFLOW_LAUNCH_VERB, quote(request.workflow), ...pairs, ...(prompt ? [prompt] : [])].join(' ');
}

/** The trigger that makes a prompt mandatory. */
const USER_PROMPT_TRIGGER = 'user_prompt';

/** What the dialog will not let a reader send, worded the way the session would answer. */
export function launchProblems(workflow: WorkflowCatalogEntryView, request: WorkflowLaunchRequest): string[] {
  const problems: string[] = [];
  if (workflow.triggers.includes(USER_PROMPT_TRIGGER) && (request.prompt ?? '').trim() === '') {
    problems.push('This workflow is triggered by a prompt, so it needs one.');
  }
  const missing = workflow.inputs
    .filter((input) => input.required === true && (request.inputs[input.name] ?? '') === '')
    .map((input) => input.name);
  if (missing.length > 0) {
    problems.push(`Missing required input${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
  }
  return problems;
}

/** The default a field starts with: what the workflow declared, or empty. */
export function initialInputs(workflow: WorkflowCatalogEntryView): Record<string, string> {
  return Object.fromEntries(workflow.inputs.map((input) => [input.name, input.default ?? '']));
}

/** The runner a launch starts on: the workflow's first declared one, when it declares any. */
export function initialRunner(workflow: WorkflowCatalogEntryView): string | undefined {
  return workflow.runners?.[0];
}

/** The command templated steps start on: the one their steps list first. */
export function initialCommand(workflow: WorkflowCatalogEntryView): string | undefined {
  return workflow.commands?.[0];
}

/** The choice a launch starts on: `default` when declared, else the first. */
export function initialChoice(workflow: WorkflowCatalogEntryView): string | undefined {
  const choices = workflow.choices ?? [];
  return choices.includes('default') ? 'default' : choices[0];
}
