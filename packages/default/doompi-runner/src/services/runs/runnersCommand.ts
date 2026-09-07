/** The `/runners` verb that stops one runner without opening Runner Space. */
export const RUNNERS_STOP_VERB = 'stop';
/** The `/runners` verb that starts one, for a client that cannot call the bash tool. */
export const RUNNERS_START_VERB = 'start';
/**
 * Ends the options and begins the command.
 *
 * A command is arbitrary shell: it may hold `=`, and it may hold flags of its
 * own (`pnpm test -- --watch`). Only the first of these is the separator, so
 * everything the reader typed survives intact after it.
 */
export const RUNNERS_COMMAND_SEPARATOR = '--';

export interface RunnersStartRequest {
  kind: 'start';
  /** The shell command to run; empty when the reader gave none. */
  command: string;
  cwd?: string;
  name?: string;
  interactive: boolean;
}

export type RunnersCommandRequest =
  /** No arguments: open Runner Space. */
  | { kind: 'space' }
  /** `stop <id> [reason]`: stop one runner headlessly; id is empty when it was left out. */
  | { kind: 'stop'; id: string; reason?: string }
  /** `start [key=value ...] -- <command>`: start one headlessly. */
  | RunnersStartRequest;

const NAME_KEY = 'name';
const CWD_KEY = 'cwd';
const INTERACTIVE_KEY = 'interactive';

/** Splits on whitespace but keeps a double-quoted run together, so a path with spaces survives. */
function tokenize(text: string): string[] {
  return text.match(/(?:"[^"]*"|\S)+/gu) ?? [];
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/**
 * Parses `start`'s tail: `key=value` pairs up to the separator, then the
 * command verbatim.
 *
 * Without a separator the whole tail is the command, so typing
 * `/runners start pnpm build` does what it looks like. Options are read only
 * when a separator says where they end, which is what keeps a command such as
 * `FOO=bar pnpm test` from being mistaken for one.
 */
function parseStart(tail: string): RunnersStartRequest {
  const tokens = tokenize(tail);
  const separator = tokens.indexOf(RUNNERS_COMMAND_SEPARATOR);
  if (separator === -1) return { kind: 'start', command: tail.trim(), interactive: false };

  const request: RunnersStartRequest = {
    kind: 'start',
    // Sliced from the raw text rather than rejoined from tokens: rejoining
    // would collapse the spacing the reader wrote.
    command: tail.slice(tail.indexOf(RUNNERS_COMMAND_SEPARATOR) + RUNNERS_COMMAND_SEPARATOR.length).trim(),
    interactive: false,
  };
  for (const token of tokens.slice(0, separator)) {
    const split = token.indexOf('=');
    if (split <= 0) continue;
    const value = unquote(token.slice(split + 1));
    const key = token.slice(0, split);
    if (key === NAME_KEY && value !== '') request.name = value;
    if (key === CWD_KEY && value !== '') request.cwd = value;
    if (key === INTERACTIVE_KEY) request.interactive = value === 'true';
  }
  return request;
}

/**
 * Parses `/runners` arguments. Anything other than a known verb opens Runner
 * Space, which is what the bare command has always done.
 */
export function parseRunnersCommand(args: string): RunnersCommandRequest {
  const trimmed = args.trim();
  const [verb = '', id = '', ...rest] = trimmed.split(/\s+/u).filter(Boolean);
  if (verb === RUNNERS_START_VERB) return parseStart(trimmed.slice(verb.length).trim());
  if (verb !== RUNNERS_STOP_VERB) return { kind: 'space' };
  const reason = rest.join(' ').trim();
  return { kind: 'stop', id, ...(reason ? { reason } : {}) };
}
