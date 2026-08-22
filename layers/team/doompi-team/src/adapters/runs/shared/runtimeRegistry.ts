/**
 * Which agent runtime executes a run, and how to invoke it.
 *
 * WHY THIS IS CONFIG AND NOT A CLASS PER VENDOR:
 * Every external agent CLI is the same shape from here: a binary, an argv with
 * the prompt substituted in, a working directory, and whatever it prints. There
 * is no per-vendor behaviour worth a per-vendor module, and inventing an
 * adapter interface would mean a new file, a new registration and a new test
 * suite every time someone wants to point a run at a different command. Adding
 * or retargeting a CLI is a config edit.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO:
 * It does not parse vendor output. A generic runner cannot know what a given
 * CLI's JSON stream means, and pretending to would either lock the config down
 * to the two CLIs someone happened to test, or silently mis-report a third. The
 * run's final output is its output; status comes from the run lifecycle, which
 * already knows queued/running/terminal without reading a word of it.
 *
 * `pi` IS NOT IN THIS TABLE:
 * It is not an external command - it runs in-process through the SDK
 * (`runs/sdkRunnerEntry.ts`) and gets the team channel, steering and
 * structured output that an external one-shot cannot. Treating it as one more
 * row here would advertise capabilities the external path does not have.
 *
 * AVOID:
 * - Putting a secret in an argv template; argv is visible in the process table
 * - Adding a placeholder without substituting it. An unsubstituted `{prompt}`
 *   reaches the CLI literally
 */

import { PI_RUNTIME_NAME, runtimeBinaryEnvVar } from '../../../types/environment';

/** One external CLI, as configured. */
export interface RuntimeDefinition {
  /** Binary to execute. Resolved against PATH unless overridden by env. */
  command: string;
  /** Argv template. `{prompt}`, `{model}` and `{cwd}` are substituted per run. */
  args: string[];
}

export type RuntimeTable = Record<string, RuntimeDefinition>;

/**
 * Shipped defaults, overridable per entry by config.
 *
 * Both are headless one-shot invocations: the prompt goes in, the final answer
 * comes out on stdout, and the process exits. Neither is asked for a structured
 * stream, because nothing here would read it.
 */
export const DEFAULT_RUNTIMES: RuntimeTable = {
  claude: { command: 'claude', args: ['-p', '{prompt}'] },
  antigravity: { command: 'antigravity', args: ['{prompt}'] },
};

export interface ResolvedRuntimeLaunch {
  runtime: string;
  command: string;
  args: string[];
}

export interface RuntimeSubstitutions {
  prompt: string;
  model?: string;
  cwd: string;
}

/** True for the in-process SDK path, which this module does not describe. */
export function isPiRuntime(runtime: string | undefined): boolean {
  return (runtime ?? PI_RUNTIME_NAME).trim() === PI_RUNTIME_NAME;
}

export function resolveRuntimeTable(configured: RuntimeTable | undefined): RuntimeTable {
  if (!configured) return { ...DEFAULT_RUNTIMES };
  return { ...DEFAULT_RUNTIMES, ...configured };
}

/**
 * The binary to run, most explicit source first.
 *
 * The env override exists for the same reason `piSpawn.ts` has one: a
 * developer testing against a locally built CLI must be able to point a run at
 * it without editing shared config.
 */
function resolveCommand(runtime: string, definition: RuntimeDefinition, env: NodeJS.ProcessEnv): string {
  const override = env[runtimeBinaryEnvVar(runtime)]?.trim();
  return override || definition.command;
}

function substitute(template: string, values: RuntimeSubstitutions): string {
  return template
    .replaceAll('{prompt}', values.prompt)
    .replaceAll('{model}', values.model ?? '')
    .replaceAll('{cwd}', values.cwd);
}

/**
 * Resolve one run's command line.
 *
 * An argument that reduces to the empty string is dropped rather than passed:
 * a template carrying `--model {model}` for a run with no model override would
 * otherwise hand the CLI a bare `--model` with nothing after it.
 */
export function resolveRuntimeLaunch(
  runtime: string,
  table: RuntimeTable,
  values: RuntimeSubstitutions,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRuntimeLaunch {
  const definition = table[runtime];
  if (!definition) {
    const known = Object.keys(table).sort().join(', ') || '(none configured)';
    throw new Error(`Unknown subagent runtime '${runtime}'. Configured runtimes: ${known}.`);
  }
  return {
    runtime,
    command: resolveCommand(runtime, definition, env),
    args: definition.args.map((arg) => substitute(arg, values)).filter((arg) => arg.length > 0),
  };
}
