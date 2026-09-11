import { readDoomConfigSources } from '@agimon-ai/doompi-config/layeredConfig';
import { DEFAULT_MODEL_GUIDANCE_PRESET, mergeModelGuidance } from '../services/modelGuidance.ts';
import type { ModelGuidanceDocument, ModelGuidanceMap } from '../types/modelGuidance.ts';

/** Layered guidance document, read from the global then the repository `.doom` directory. */
export const GUIDANCE_FILE = 'model-guidance.yaml';

const DEFAULT_GUIDANCE = Object.freeze(mergeModelGuidance([DEFAULT_MODEL_GUIDANCE_PRESET]));

/**
 * Reads and folds the global and repository guidance documents.
 *
 * Fails open. The reader parses YAML without a guard, so a typo in an optional
 * prompt file would otherwise throw on every turn of the session. Degrading to
 * the built-in preset keeps the package useful without letting malformed user
 * input end the turn.
 *
 * `homeDirectory` exists so a test can point the global scope at a temporary
 * directory; production callers omit it and the reader falls back to the real home.
 */
export function loadModelGuidance(repositoryRoot: string | undefined, homeDirectory?: string): ModelGuidanceMap {
  if (!repositoryRoot) return DEFAULT_GUIDANCE;

  try {
    const sources = readDoomConfigSources<ModelGuidanceDocument>(GUIDANCE_FILE, repositoryRoot, homeDirectory);
    return mergeModelGuidance([DEFAULT_MODEL_GUIDANCE_PRESET, ...sources.map((source) => source.document)]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[doompi-model-guidance] could not read ${GUIDANCE_FILE}: ${reason}\n`);
    return DEFAULT_GUIDANCE;
  }
}
