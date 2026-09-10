/**
 * Top-level argv routing for the `doompi` binary.
 *
 * Deliberately tiny and dependency-free. It answers two questions before any
 * command module loads: which subcommand was named, and whether this run only
 * wants help or a version. Everything else, including the harness options and
 * the Pi passthrough, stays with `parseHarnessArgs`, which already knows the
 * harness vocabulary and forwards what it does not own.
 */

/** Subcommands that parse their own arguments instead of passing them to Pi. */
export const KNOWN_COMMANDS = ['init', 'sync', 'compat', 'doctor', 'history-export'] as const;

export type KnownCommand = (typeof KNOWN_COMMANDS)[number];

const HELP_FLAGS = ['--help', '-h'];
const VERSION_FLAGS = ['--version', '-v'];
/** Everything after this belongs to a provider or to Pi, never to doompi. */
const PASSTHROUGH_SEPARATOR = '--';

/**
 * The named subcommand, or undefined when this run is a Pi invocation.
 *
 * Reads argv[0] only. A token later in the line is a flag value or prompt text,
 * never a command, so scanning further would let `doompi --profile sync` look
 * like a sync.
 */
export function routeCommand(args: readonly string[]): KnownCommand | undefined {
  const first = args[0];
  return first !== undefined && (KNOWN_COMMANDS as readonly string[]).includes(first)
    ? (first as KnownCommand)
    : undefined;
}

/**
 * Whether this run asks for help or a version, before the passthrough boundary.
 *
 * The scan stops at the first bare `--` so a provider's own `--help` reaches
 * the provider rather than printing doompi's help and exiting.
 */
export function informationalRequest(args: readonly string[]): 'help' | 'version' | undefined {
  for (const argument of args) {
    if (argument === PASSTHROUGH_SEPARATOR) return undefined;
    if (HELP_FLAGS.includes(argument)) return 'help';
    if (VERSION_FLAGS.includes(argument)) return 'version';
  }
  return undefined;
}

/** Convenience for a subcommand that only needs to know whether to print help. */
export function wantsHelp(args: readonly string[]): boolean {
  return informationalRequest(args) === 'help';
}
