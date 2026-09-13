/**
 * The `/workflow-launch` line, parsed.
 *
 * WHY A VERB AT ALL:
 * A browser can only send a session a prompt frame, so every cockpit action
 * that has to run inside the session travels as a slash line, the way the
 * agent catalog sends `/run`. The workflow tools answer to the agent, not to a
 * page, and the leader board answers to a keyboard, so neither of them can be
 * what the launch dialog sends.
 *
 * THE SHAPE:
 *   /workflow-launch <workflow> [key=value ...] [prompt words]
 *
 * Key-value pairs come first and stop at the first token that is not one, so
 * everything after them is the prompt exactly as it was typed, including any
 * `=` inside it. `runner` is the one reserved key; the rest are the workflow's
 * own `workflow_dispatch` inputs. Values may be double quoted to hold spaces.
 */

/** The reserved key: which runner map entry the run executes with. */
const RUNNER_KEY = 'runner';
const KEY_VALUE = /^([A-Za-z_][\w.-]*)=(.*)$/s;

export interface ParsedWorkflowLaunch {
  /** The workflow's name or its path, as typed; resolution belongs to the caller. */
  workflow: string;
  runner?: string;
  inputs: Record<string, string>;
  prompt?: string;
}

export interface WorkflowLaunchParseFailure {
  error: string;
}

export function isLaunchParseFailure(
  value: ParsedWorkflowLaunch | WorkflowLaunchParseFailure,
): value is WorkflowLaunchParseFailure {
  return 'error' in value;
}

/** Strips one layer of surrounding double quotes, which is how a value holds spaces. */
function unquote(value: string): string {
  return value.length > 1 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/**
 * Splits on whitespace, keeping double-quoted runs together.
 *
 * Returns each token with the offset it started at, so the caller can take the
 * rest of the line verbatim rather than rebuilding it from tokens and losing
 * the spacing a prompt was written with.
 */
function tokenize(line: string): { text: string; start: number }[] {
  const tokens: { text: string; start: number }[] = [];
  let index = 0;
  while (index < line.length) {
    while (index < line.length && /\s/.test(line[index] as string)) index += 1;
    if (index >= line.length) break;
    const start = index;
    let quoted = false;
    while (index < line.length && (quoted || !/\s/.test(line[index] as string))) {
      if (line[index] === '"') quoted = !quoted;
      index += 1;
    }
    tokens.push({ text: line.slice(start, index), start });
  }
  return tokens;
}

export function parseWorkflowLaunchCommand(args: string): ParsedWorkflowLaunch | WorkflowLaunchParseFailure {
  const tokens = tokenize(args.trim());
  const first = tokens[0];
  if (first === undefined) return { error: 'Usage: /workflow-launch <workflow> [key=value …] [prompt]' };

  const inputs: Record<string, string> = {};
  let runner: string | undefined;
  let index = 1;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index] as { text: string; start: number };
    const match = KEY_VALUE.exec(token.text);
    if (!match) break;
    const key = match[1] as string;
    const value = unquote(match[2] as string);
    if (key === RUNNER_KEY) runner = value;
    else inputs[key] = value;
  }

  const rest = tokens[index];
  const prompt = rest === undefined ? undefined : args.trim().slice(rest.start).trim();
  return {
    workflow: unquote(first.text),
    ...(runner === undefined ? {} : { runner }),
    inputs,
    ...(prompt === undefined || prompt === '' ? {} : { prompt }),
  };
}

/** The line the cockpit sends, built from what its dialog collected. */
export function workflowLaunchCommand(request: ParsedWorkflowLaunch): string {
  const quote = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);
  const pairs = [
    ...(request.runner === undefined ? [] : [`${RUNNER_KEY}=${quote(request.runner)}`]),
    ...Object.entries(request.inputs).map(([key, value]) => `${key}=${quote(value)}`),
  ];
  const prompt = request.prompt?.trim();
  return ['/workflow-launch', quote(request.workflow), ...pairs, ...(prompt ? [prompt] : [])].join(' ');
}

/** One catalog row, as much of it as resolution needs. */
export interface LaunchResolvableWorkflow {
  name: string;
  path: string;
  relativePath: string;
}

/**
 * The workflow a token names: its name, its path in the repository, or the
 * tail of that path. Case-insensitive on the name, because the catalog shows
 * names as their author capitalised them and nobody types that back exactly.
 */
export function resolveWorkflowEntry<T extends LaunchResolvableWorkflow>(
  entries: readonly T[],
  token: string,
): T | undefined {
  const needle = token.trim();
  const lower = needle.toLocaleLowerCase();
  return (
    entries.find((entry) => entry.name.toLocaleLowerCase() === lower) ??
    entries.find((entry) => entry.relativePath === needle || entry.path === needle) ??
    entries.find((entry) => entry.relativePath.endsWith(`/${needle}`) || entry.path.endsWith(`/${needle}`))
  );
}

/** What a workflow declares, as much of it as a launch has to satisfy. */
export interface LaunchRequirements {
  triggers: readonly string[];
  inputs: readonly { name: string; required?: boolean; options?: readonly string[] }[];
  /** Absent means the workflow names no runner map, so any runner will do. */
  runners?: readonly string[];
}

/** The trigger that makes a prompt mandatory: the run waits for one otherwise. */
const USER_PROMPT_TRIGGER = 'user_prompt';

/**
 * Everything wrong with a launch, before it is started.
 *
 * Checked here rather than left to the engine because the failure would
 * otherwise be a run that starts and then waits forever for terminal input, or
 * one that dies on a runner its steps never declared. Both read as the launch
 * having worked.
 */
export function validateWorkflowLaunch(
  requirements: LaunchRequirements,
  parsed: Pick<ParsedWorkflowLaunch, 'inputs' | 'prompt' | 'runner'>,
): string[] {
  const problems: string[] = [];
  if (requirements.triggers.includes(USER_PROMPT_TRIGGER) && (parsed.prompt ?? '') === '') {
    problems.push('This workflow is triggered by a prompt, so it needs one.');
  }
  const missing = requirements.inputs
    .filter((input) => input.required === true && (parsed.inputs[input.name] ?? '') === '')
    .map((input) => input.name);
  if (missing.length > 0)
    problems.push(`Missing required input${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
  for (const input of requirements.inputs) {
    const value = parsed.inputs[input.name];
    if (value === undefined || input.options === undefined || input.options.includes(value)) continue;
    problems.push(`Input ${input.name} must be one of: ${input.options.join(', ')}.`);
  }
  const declared = requirements.runners;
  if (parsed.runner !== undefined && declared !== undefined && !declared.includes(parsed.runner)) {
    problems.push(
      declared.length === 0
        ? 'This workflow declares no runner its steps agree on.'
        : `Runner ${parsed.runner} is not one this workflow declares: ${declared.join(', ')}.`,
    );
  }
  return problems;
}
