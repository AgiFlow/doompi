/**
 * Parses `/chain`/`/parallel`/`/run` slash-command argument strings into
 * structured steps: inline per-agent config (`agent[key=value,...]`),
 * `->`-separated chain steps, and `(a | b)`-style parallel groups within a
 * chain. Pure string parsing - nothing here calls into `SpawnPlanner` or
 * knows what a parsed field is used for; see `subagentLaunch.ts` for the
 * execution side and whichever module maps a `ParsedStep` onto a
 * `SpawnPlanTaskInput`/`SpawnPlanChainStepInput` for what happens to a
 * field this parser accepts once `SpawnPlanner`'s own request shape is
 * settled for this port (see the port's own tracking, not this file).
 *
 * WHY THIS IS ITS OWN MODULE, SEPARATE FROM COMMAND REGISTRATION:
 * The predecessor kept this logic inline in `slashCommands.ts`. Splitting
 * it out means the string-parsing rules - which are intricate and worth
 * testing in isolation (quote tracking, nested parens, top-level-only arrow
 * and pipe splitting) - do not need a `pi.registerCommand` fixture to test,
 * and stay unaffected by whatever `SpawnPlanner` request shape a caller
 * eventually maps a `ParsedStep` onto.
 *
 * AVOID:
 * - Adding execution or `SpawnPlanner` knowledge here. If a function needs
 *   to know what a field does once parsed, it belongs in the caller, not
 *   this file
 */

export interface InlineConfig {
  output?: string | false;
  outputMode?: 'inline' | 'file-only';
  reads?: string[] | false;
  model?: string;
  skill?: string[] | false;
  progress?: boolean;
  as?: string;
  label?: string;
  phase?: string;
  cwd?: string;
  count?: number;
  outputSchema?: string;
  acceptance?: string;
}

/** Parses the `key=value,...` body of `agent[...]` inline config. Unknown keys are ignored, not rejected. */
export function parseInlineConfig(raw: string): InlineConfig {
  const config: InlineConfig = {};
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      if (trimmed === 'progress') config.progress = true;
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    switch (key) {
      case 'output':
        config.output = val === 'false' ? false : val;
        break;
      case 'outputMode':
        if (val === 'inline' || val === 'file-only') config.outputMode = val;
        break;
      case 'reads':
        config.reads = val === 'false' ? false : val.split('+').filter(Boolean);
        break;
      case 'model':
        config.model = val || undefined;
        break;
      case 'skill':
      case 'skills':
        config.skill = val === 'false' ? false : val.split('+').filter(Boolean);
        break;
      case 'progress':
        config.progress = val !== 'false';
        break;
      case 'as':
        config.as = val || undefined;
        break;
      case 'label':
        config.label = val || undefined;
        break;
      case 'phase':
        config.phase = val || undefined;
        break;
      case 'cwd':
        config.cwd = val || undefined;
        break;
      case 'count': {
        const n = Number(val);
        if (Number.isInteger(n) && n > 0) config.count = n;
        break;
      }
      case 'outputSchema':
        config.outputSchema = val || undefined;
        break;
      case 'acceptance':
        config.acceptance = val || undefined;
        break;
    }
  }
  return config;
}

/** Splits `agent[key=value]` into the bare agent name and its parsed inline config. */
export function parseAgentToken(token: string): { name: string; config: InlineConfig } {
  const bracket = token.indexOf('[');
  if (bracket === -1) return { name: token, config: {} };
  const end = token.lastIndexOf(']');
  return {
    name: token.slice(0, bracket),
    config: parseInlineConfig(token.slice(bracket + 1, end !== -1 ? end : undefined)),
  };
}

export interface ParsedStep {
  kind: 'step';
  name: string;
  config: InlineConfig;
  task?: string;
}

export class SlashParseError extends Error {}

export function parseSingleTaskToken(token: string): ParsedStep {
  let agentPart: string;
  let task: string | undefined;
  const qMatch = token.match(/^(\S+(?:\[[^\]]*\])?)\s+(?:"([^"]*)"|'([^']*)')$/);
  if (qMatch) {
    agentPart = qMatch[1]!;
    task = (qMatch[2] ?? qMatch[3]) || undefined;
  } else {
    const dashIdx = token.indexOf(' -- ');
    if (dashIdx !== -1) {
      agentPart = token.slice(0, dashIdx).trim();
      task = token.slice(dashIdx + 4).trim() || undefined;
    } else {
      agentPart = token;
    }
  }
  return { kind: 'step', ...parseAgentToken(agentPart), task };
}

/**
 * User-typed flag selecting fork context for a run.
 *
 * Named because it is part of the command surface a user types, so the literal
 * appears in the parser, in help text and in any error naming it. Three copies
 * of a user-facing token drift one edit at a time, and the failure mode is a
 * flag the help promises and the parser does not accept.
 */
const FORK_FLAG = '--fork';

/**
 * The predecessor's flags that used to select background execution. `--async`
 * was a synonym for the same flag, accepted by the since-removed prompt
 * workflow commands; it stays rejected here so anyone carrying an old
 * invocation gets the explanation rather than an unknown-flag error.
 */
const DEPRECATED_BACKGROUND_FLAGS = ['--bg', '--async'];

/**
 * Thrown when a command's argument text still contains a background-mode
 * flag. Distinct from a generic parse error so the message can say
 * specifically why the flag is gone, not just that it was unexpected -
 * caught the same way as any other `SlashParseError` by
 * `reportKnownErrorOrRethrow`.
 */
export class DeprecatedBackgroundFlagError extends SlashParseError {
  constructor(readonly flag: string) {
    super(`'${flag}' is no longer needed: every run in this package is already background.`);
    this.name = 'DeprecatedBackgroundFlagError';
  }
}

function matchesTrailingFlag(text: string, flag: string): boolean {
  return text === flag || text.endsWith(` ${flag}`);
}

function stripTrailingFlag(text: string, flag: string): string {
  return text === flag ? '' : text.slice(0, -(flag.length + 1)).trim();
}

/**
 * Removes a trailing ` --fork` flag, returning the remaining argument text.
 *
 * `--bg`/`--async` are gone entirely - not stripped, not accepted, not
 * silently ignored. A user typing `--bg` out of habit gets an explicit,
 * named rejection here rather than falling through as literal text that
 * then produces an unrelated "no such agent" error further down the
 * pipeline, which points at the wrong problem. See `subagentLaunch.ts`'s
 * module doc for why background is the only mode.
 */
export function extractForkFlag(rawArgs: string): { args: string; fork: boolean } {
  let trimmed = rawArgs.trim();
  let fork = false;
  for (;;) {
    if (matchesTrailingFlag(trimmed, FORK_FLAG)) {
      fork = true;
      trimmed = stripTrailingFlag(trimmed, FORK_FLAG);
      continue;
    }
    const deprecatedFlag = DEPRECATED_BACKGROUND_FLAGS.find((flag) => matchesTrailingFlag(trimmed, flag));
    if (deprecatedFlag) throw new DeprecatedBackgroundFlagError(deprecatedFlag);
    break;
  }
  return { args: trimmed, fork };
}
