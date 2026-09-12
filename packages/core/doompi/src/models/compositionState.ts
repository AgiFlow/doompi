import {
  DOOMPI_COMPOSED_ENV,
  DOOMPI_EXTENSIONS_PROVIDED_ENV,
} from '@agimon-ai/doompi-extension-contracts/child-process';

/** Marks a process whose extensions this module composed. */
export const COMPOSED_ENV = DOOMPI_COMPOSED_ENV;
/** Set by the launcher when it passes one precomposed aggregate to Pi. */
export const EXTERNAL_EXTENSIONS_ENV = DOOMPI_EXTENSIONS_PROVIDED_ENV;
/** Survives reload, where argv is re-read but the startup flags must not be. */
export const MUTE_ENV = 'DOOMPI_MUTE';

const COMPOSITION_CLAIM_KEY = Symbol.for('@agimon-ai/doompi:composition-claim');

export type ReleaseCompositionClaim = () => void;

/**
 * Owns composition until Pi starts the freshly loaded extension runner.
 *
 * Pi resolves project resources before user resources, so the first DoomPi
 * factory is the repository-local one when both scopes register the package.
 * A process-global symbol survives distinct installed module URLs and lets that
 * first factory own the load cycle. Releasing on `session_start` leaves a later
 * `/reload` free to compose a new runner.
 */
export function acquireCompositionClaim(): ReleaseCompositionClaim | undefined {
  if (Reflect.get(globalThis, COMPOSITION_CLAIM_KEY) !== undefined) return undefined;

  const claim = Symbol('doompi-composition');
  Reflect.set(globalThis, COMPOSITION_CLAIM_KEY, claim);
  return () => {
    if (Reflect.get(globalThis, COMPOSITION_CLAIM_KEY) === claim) {
      Reflect.deleteProperty(globalThis, COMPOSITION_CLAIM_KEY);
    }
  };
}
