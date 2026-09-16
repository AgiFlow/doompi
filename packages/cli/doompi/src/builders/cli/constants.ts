/** Environment variable naming the composition record of a launcher session. */
export const LAUNCHER_COMPOSITION_ENV = 'DOOMPI_LAUNCHER_COMPOSITION';

/**
 * Environment variable asking a delegated launcher to record its composition.
 *
 * A server that composes in process passes `compositionRecordPath` directly,
 * but a repository that pins its own DoomPi, or a host that sets
 * `DOOMPI_AGENT_COMMAND`, hands the arguments to a different launcher process
 * instead. That launcher owns composition for its own version, so the request
 * travels as an environment variable it may honour or ignore. A launcher too
 * old to know this name simply composes as before, which is why forwarding it
 * is safe across versions.
 */
export const LAUNCHER_COMPOSITION_REQUEST_ENV = 'DOOMPI_COMPOSITION_RECORD';

export const LAUNCHER_COMPOSITION_VERSION = 1;
