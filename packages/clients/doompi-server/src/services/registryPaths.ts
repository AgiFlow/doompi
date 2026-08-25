// @scaffold-generated
/** Environment variable overriding where session records live. */
export const REGISTRY_DIR_ENV = 'DOOMPI_RUNTIME_DIR';

const DEFAULT_RUN_DIR_SEGMENT = '.doompi/run';
const SESSIONS_SEGMENT = 'sessions';
const RECORD_EXTENSION = '.json';

export interface RegistryDirInput {
  /** Value of --registry-dir, when given; wins over everything else. */
  readonly flagValue?: string;
  /** Value of DOOMPI_RUNTIME_DIR, when set. */
  readonly envValue?: string;
  /** The user's home directory, supplied by the host. */
  readonly homeDir: string;
}

/**
 * Resolve the runtime registry directory and the record path for a session
 *
 * Host-neutral by construction: every input arrives as an argument, the home
 * directory included, so the same arguments always produce the same result.
 * XDG_RUNTIME_DIR is deliberately not consulted; it is unset on macOS and its
 * tmpfs semantics buy nothing for a registry that must survive reboots no
 * better than the sockets it points at.
 */
export function resolveRegistryDir(input: RegistryDirInput): string {
  if (input.flagValue) return input.flagValue;
  if (input.envValue) return input.envValue;
  return `${input.homeDir}/${DEFAULT_RUN_DIR_SEGMENT}`;
}

/** Directory holding one record file per running session. */
export function sessionRecordsDir(registryDir: string): string {
  return `${registryDir}/${SESSIONS_SEGMENT}`;
}

export function sessionRecordPath(registryDir: string, sessionId: string): string {
  return `${sessionRecordsDir(registryDir)}/${sessionId}${RECORD_EXTENSION}`;
}
