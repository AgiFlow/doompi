import type { ModelGuidanceDocument, ModelGuidanceMap } from '../../types/modelGuidance';

import { DEFAULT_GUIDANCE, DEFAULT_MODEL_GUIDANCE_PRESET } from '../../constants/modelGuidance';
export { DEFAULT_MODEL_GUIDANCE_PRESET } from '../../constants/modelGuidance';
Object.freeze(DEFAULT_GUIDANCE);
Object.freeze(DEFAULT_MODEL_GUIDANCE_PRESET);
/**
 * Folds guidance documents in source order, so a later document overrides one
 * model id at a time.
 *
 * The reader hands back global then repository, so a repository entry wins the
 * ids it names while global entries it does not name survive. That per-id
 * granularity is the point: a personal default stays useful inside a project
 * that only pins one model.
 *
 * Non-string values are dropped rather than rejected, because a guidance file is
 * optional user input and one bad entry must not discard the rest.
 */
export function mergeModelGuidance(documents: readonly ModelGuidanceDocument[]): ModelGuidanceMap {
  const merged: Record<string, string> = {};
  for (const document of documents) {
    for (const [modelId, guidance] of Object.entries(document.modelGuidance ?? {})) {
      if (typeof guidance !== 'string') continue;
      const trimmed = guidance.trim();
      if (trimmed) merged[modelId] = trimmed;
    }
  }
  return merged;
}

/** Exact-match lookup. An unknown or absent model id contributes nothing. */
export function guidanceForModel(guidance: ModelGuidanceMap, modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  return guidance[modelId];
}

/**
 * Builds the replacement system prompt for one turn.
 *
 * Pi treats a returned `systemPrompt` as a full replacement and chains handlers,
 * so the incoming prompt has to be re-embedded. Returning bare guidance would
 * discard every earlier contribution, including plan mode and the persona.
 * Keeping that in one function leaves a single place for it to be right.
 */
export function applyModelGuidance(systemPrompt: string, guidance: string | undefined): string | undefined {
  if (!guidance) return undefined;
  return `${systemPrompt}\n\n${guidance}`;
}
