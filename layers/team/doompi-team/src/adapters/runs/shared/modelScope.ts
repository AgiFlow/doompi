/**
 * Decides whether a resolved model is inside the configured subagent model scope.
 *
 * DESIGN PATTERNS:
 * - Pure decision function, so scope policy can be unit-tested without config or
 *   filesystem access
 * - Severity follows provenance rather than the model: a model the caller asked
 *   for by name is an error, a model inherited from frontmatter, the settings
 *   default, or the parent session is only a warning, so tightening scope never
 *   breaks a working configuration outright
 * - Patterns match the full `provider/id`, never a bare id, so `*` cannot let an
 *   unintended provider in through a same-named model
 *
 * AVOID:
 * - Treating an empty `allow` list as "deny everything"; enforcement without
 *   patterns is a no-op here and is rejected at settings-parse time instead
 * - Comparing the raw model string; the thinking suffix is not part of identity
 */

import { splitKnownThinkingSuffix } from '../../../services/models/modelInfo';
import type { ModelScopeConfig } from '../../../types';

/** Where a resolved model originated, deciding enforcement severity. */
export type ModelSource = 'explicit' | 'inherited';

export interface ModelScopeViolation {
  /** Resolved model id (without thinking suffix) that fell outside the scope. */
  model: string;
  severity: 'warn' | 'error';
  message: string;
  allowedPatterns: string[];
}

/** RegExp metacharacters that must be escaped. `*` is excluded: it is the glob wildcard. */
const REGEXP_SPECIALS_EXCEPT_WILDCARD = /[.+^${}()|[\]\\]/g;
const GLOB_WILDCARD = /\*/g;
/** What `*` expands to: any run of characters, including `/`, so `anthropic/*` covers every id. */
const WILDCARD_EXPANSION = '.*';

function stripThinkingSuffix(model: string): string {
  return splitKnownThinkingSuffix(model).baseModel;
}

/** Escape RegExp specials except `*`, then turn `*` into `.*`. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(REGEXP_SPECIALS_EXCEPT_WILDCARD, '\\$&').replace(GLOB_WILDCARD, WILDCARD_EXPANSION);
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Test whether a resolved model matches a single allow pattern. Both sides are
 * compared case-insensitively against the full `provider/id` (thinking suffix
 * stripped from the model).
 */
export function matchesScopePattern(model: string, pattern: string): boolean {
  return globToRegExp(pattern).test(stripThinkingSuffix(model));
}

/**
 * Pure scope decision. Returns a {@link ModelScopeViolation} when the model is
 * out of scope and enforcement is on, otherwise `undefined`. Enforcement with
 * no `allow` list is a no-op (the settings parser rejects that combination, but
 * this stays defensive for callers that build configs programmatically).
 */
export function checkModelScope(
  model: string | undefined,
  scope: ModelScopeConfig | undefined,
  source: ModelSource,
): ModelScopeViolation | undefined {
  if (!model || !scope?.enforce) return undefined;
  const allow = scope.allow;
  if (!allow || allow.length === 0) return undefined;
  if (allow.some((pattern) => matchesScopePattern(model, pattern))) return undefined;

  const baseModel = stripThinkingSuffix(model);
  const severity: ModelScopeViolation['severity'] = source === 'explicit' ? 'error' : 'warn';
  return {
    model: baseModel,
    severity,
    allowedPatterns: allow,
    message:
      `Model '${baseModel}' is outside the configured subagent model scope. ` +
      `Allowed patterns: ${allow.join(', ')}.`,
  };
}
