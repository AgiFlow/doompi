/** Environment variable naming the composition record of a launcher session. */
export const LAUNCHER_COMPOSITION_ENV = 'DOOMPI_LAUNCHER_COMPOSITION';

export const LAUNCHER_COMPOSITION_VERSION = 1;

/**
 * What a launcher session's stable Pi entry needs to compose itself.
 *
 * Only the values that stay fixed for the process live here. The major mode,
 * layers, and domains are deliberately absent: those are read from live
 * harness state at load time, which is what lets a reload land on a different
 * composition than the one the session started with.
 */
export interface LauncherCompositionState {
  version: number;
  /** Repository root the session was launched against. */
  root: string;
  preset: string;
  /** Both contribute to parent activation, so both belong to the identity. */
  mute: boolean;
  autoStop: boolean;
  agents: boolean;
  /** Compiled aggregates by composition fingerprint, when one has been built. */
  bundles: Record<string, string>;
}
