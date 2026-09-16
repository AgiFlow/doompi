/**
 * The slice of harness state the header renders.
 *
 * A projection of the store rather than its own reader. This used to
 * re-implement five of the state keys with its own list parser and its own
 * default mode, which is two definitions of one protocol to keep in step.
 */

const DEFAULT_MAJOR_MODE = 'copilot';

export interface DoomHarnessMetadata {
  root?: string;
  /** The one named major mode this session runs under. */
  majorMode: string;
  domains: string[];
  /** The layer components the major mode resolved to. */
  layers: string[];
  profile?: string;
}

function parseList(value: string | undefined): string[] {
  return value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export function readDoomHarnessMetadata(environment: NodeJS.ProcessEnv = process.env): DoomHarnessMetadata {
  return {
    root: environment.DOOMPI_ROOT,
    majorMode: environment.DOOMPI_MAJOR_MODE?.trim() || DEFAULT_MAJOR_MODE,
    domains: parseList(environment.DOOMPI_DOMAINS),
    layers: parseList(environment.DOOMPI_LAYERS),
    profile: environment.DOOMPI_PROFILE?.trim() || undefined,
  };
}
