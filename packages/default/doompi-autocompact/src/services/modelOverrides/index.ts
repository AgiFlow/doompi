/**
 * Picks the absolute token checkpoints configured for the model a session is running.
 *
 * DESIGN PATTERNS:
 * - Pure decision function, so the matching rule is unit-testable without a session,
 *   a config file or a filesystem
 * - First match in file order wins, so a reader resolves a model by reading down the
 *   list rather than by working out which pattern is the most specific
 * - A model matching nothing returns no overrides at all, which leaves the ratio
 *   ladder exactly as it behaves without this feature
 *
 * AVOID:
 * - Stripping a thinking suffix the way subagent model scope does. That matches
 *   free-typed config strings; this matches a resolved `Model`, whose `id` carries
 *   the level in a separate field and never in the id itself.
 * - Matching a bare pattern against `provider/id`. The glob wildcard does not cross
 *   the separator, so the subject has to follow the pattern's own shape.
 */

import type { AutocompactOverrideConfig } from '@agimon-ai/doompi-config';
import { minimatch } from 'minimatch';

import type { AutocompactTokenOverrides } from '../../types/autocompact';

/** The parts of a resolved model the rules match on. */
export interface AutocompactModelIdentity {
  id: string;
  provider: string;
}

/**
 * A pattern naming a provider is matched against `provider/id`, anything else
 * against the bare id. `*` does not cross `/`, so a bare pattern tested against a
 * qualified subject would never match and would read as a silently dead rule.
 */
function matchesModelPattern(pattern: string, model: AutocompactModelIdentity): boolean {
  const subject = pattern.includes('/') ? `${model.provider}/${model.id}` : model.id;
  return minimatch(subject, pattern, { nocase: true });
}

export function resolveModelTokenOverrides(
  model: AutocompactModelIdentity | undefined,
  overrides: readonly AutocompactOverrideConfig[],
): AutocompactTokenOverrides {
  if (!model) return {};
  const matched = overrides.find((entry) => matchesModelPattern(entry.model, model));
  if (!matched) return {};
  const { pass1, pass2, pass3 } = matched.tokens;
  return {
    ...(pass1 === undefined ? {} : { 1: pass1 }),
    ...(pass2 === undefined ? {} : { 2: pass2 }),
    ...(pass3 === undefined ? {} : { 3: pass3 }),
  };
}
