/**
 * The `/runners start` line the launch form sends.
 *
 * WHY THE BUILDER LIVES HERE AND THE PARSER DOES NOT:
 * Cockpit code is compiled into the host bundle and may import only this
 * package's own web and type modules, so it cannot share the session's parser
 * in src/services. The two are pinned together by a test that parses what this
 * writes, which is the only guarantee that matters: the line has to survive
 * the trip.
 */

export const RUNNERS_START_LINE = '/runners start';
/** Ends the options and begins the command; the command may hold `=` and flags of its own. */
export const RUNNERS_COMMAND_SEPARATOR = '--';

export interface RunnerLaunchRequest {
  command: string;
  cwd?: string;
  name?: string;
  interactive?: boolean;
}

/** Quotes a value that carries whitespace, which is how a value survives tokenizing. */
function quote(value: string): string {
  return /\s/u.test(value) ? `"${value}"` : value;
}

export function runnerLaunchLine(request: RunnerLaunchRequest): string {
  const cwd = request.cwd?.trim() ?? '';
  const name = request.name?.trim() ?? '';
  const pairs = [
    ...(name === '' ? [] : [`name=${quote(name)}`]),
    ...(cwd === '' ? [] : [`cwd=${quote(cwd)}`]),
    ...(request.interactive === true ? ['interactive=true'] : []),
  ];
  // The separator is always written, even with no options before it, so the
  // command is never re-read as a `key=value` pair.
  return [RUNNERS_START_LINE, ...pairs, RUNNERS_COMMAND_SEPARATOR, request.command.trim()].join(' ');
}

/** What the form will not let a reader send, worded the way the session would answer. */
export function launchProblems(request: RunnerLaunchRequest): string[] {
  const problems: string[] = [];
  if (request.command.trim() === '') problems.push('A runner needs a command to run.');
  return problems;
}
