/**
 * Resolving which model a child run uses, and which models it may fall back to.
 *
 * WHY A CHILD IS ALWAYS GIVEN AN EXPLICIT MODEL:
 * Without a `provider/id` on the command line, a child resolves its own model
 * from the global agent settings file, which every open session shares. Another
 * session that changed its model in the TUI would then silently decide this
 * session's children. Passing the parent's in-memory model keeps each session's
 * children isolated to that session.
 *
 * DESIGN PATTERNS:
 * - Every resolver is pure, so model policy is testable without a registry, a
 *   process, or config on disk
 * - Enforcement severity follows provenance: a model the caller named explicitly
 *   throws when out of scope, an inherited one only warns, so tightening scope
 *   never breaks a working configuration outright
 * - Fuzzy matching tolerates separator, case, and date-stamp spelling but never
 *   crosses providers for a qualified query, and refuses ambiguous matches
 *   rather than guessing, because the wrong provider costs real money
 *
 * AVOID:
 * - Retrying a different model on a tool failure; the model was never the
 *   problem and the retry reruns the whole task
 * - Splitting a model string on the first colon to find the thinking suffix;
 *   ids legitimately contain colons
 */

import { type ModelInfo as AvailableModelInfo, splitKnownThinkingSuffix } from '../../../services/models/modelInfo';
import { PROVIDER_SEPARATOR, resolveModelCandidate } from '../../../services/models/modelResolution';
import type { ModelScopeConfig, Usage } from '../../../types';
import { checkModelScope, type ModelScopeViolation, type ModelSource } from './modelScope';

// Re-exported so the runs domain still reads as the entry point for model
// resolution, while the definitions stay in a leaf both domains can reach.
export {
  fuzzyResolveModel,
  normalizeModelSegment,
  resolveModelCandidate,
} from '../../../services/models/modelResolution';
export type { AvailableModelInfo };

/** One finished attempt at running a child on a given model. */
export interface ModelAttemptSummary {
  model: string;
  success: boolean;
  exitCode?: number | null;
  error?: string;
  usage?: Usage;
}

/** Sentinel model value requesting that a subagent inherit the parent session's model. */
export const INHERIT_MODEL = 'inherit';

const FALLBACK_NOTE_PREFIX = '[fallback]';
const EXPLICIT_MODEL_SOURCE: ModelSource = 'explicit';
const INHERITED_MODEL_SOURCE: ModelSource = 'inherited';

/** Minimal shape of the parent session's in-memory model (`ctx.model`). */
export interface ParentModel {
  provider: string;
  id: string;
}

export function normalizeParentModel(model: unknown): ParentModel | undefined {
  if (!model || typeof model !== 'object') return undefined;
  if (!('provider' in model) || !('id' in model)) return undefined;
  const { provider, id } = model;
  if (typeof provider !== 'string' || typeof id !== 'string') return undefined;
  if (!provider || !id) return undefined;
  return { provider, id };
}

export interface ResolveSubagentModelOverrideOptions {
  /** When set with `enforce: true`, out-of-scope models are rejected. */
  scope?: ModelScopeConfig;
  /** Origin of the requested model: explicit caller-supplied (hard error) vs inherited (warn). Defaults to `"inherited"`. */
  source?: ModelSource;
  /** Sink for warn-severity violations. Without it they are dropped; see `discardScopeViolation`. */
  onWarn?: (violation: ModelScopeViolation) => void;
}

/**
 * Where a warn-severity scope violation goes when the caller supplies no sink.
 *
 * Deliberately silent rather than writing to stdio. This module runs inside both
 * the parent's TUI process and a detached runner whose stdout is the child's
 * captured transcript, so writing here would corrupt one and pollute the other.
 * The violation is advisory by definition: its error-severity sibling throws
 * instead. A composition root that wants these visible passes `onWarn` and
 * routes them into that process's own diagnostics.
 */
function discardScopeViolation(_violation: ModelScopeViolation): void {}

/**
 * Resolve the `--model` override passed to a spawned subagent.
 *
 * When no model is requested (`undefined`, `false`, empty, or the `"inherit"`
 * sentinel), the child inherits the parent session's in-memory `provider/id`
 * rather than being left to resolve its own; see the module header for why.
 *
 * An explicitly requested model string is resolved via {@link resolveModelCandidate}.
 * When `options.scope.enforce` is on, an out-of-scope resolved model throws for
 * an explicit (`source: "explicit"`) request and warns for an inherited one.
 */
export function resolveSubagentModelOverride(
  requestedModel: string | boolean | undefined,
  parentModel: ParentModel | undefined,
  availableModels: AvailableModelInfo[] | undefined,
  preferredProvider?: string,
  options?: ResolveSubagentModelOverrideOptions,
): string | undefined {
  const trimmed = typeof requestedModel === 'string' ? requestedModel.trim() : '';
  const explicit = trimmed && trimmed !== INHERIT_MODEL ? trimmed : undefined;
  let resolved: string | undefined;
  if (explicit === undefined) {
    resolved = parentModel ? `${parentModel.provider}${PROVIDER_SEPARATOR}${parentModel.id}` : undefined;
  } else {
    resolved = resolveModelCandidate(explicit, availableModels, preferredProvider);
  }
  if (resolved && options?.scope?.enforce) {
    // A model that fell back to the parent's was never explicitly requested,
    // whatever the caller declared, so it can only ever warn.
    const source = explicit === undefined ? INHERITED_MODEL_SOURCE : (options.source ?? INHERITED_MODEL_SOURCE);
    const violation = checkModelScope(resolved, options.scope, source);
    if (violation) {
      if (violation.severity === 'error') throw new Error(violation.message);
      (options.onWarn ?? discardScopeViolation)(violation);
    }
  }
  return resolved;
}

/**
 * Resolve the model for a run from the caller's request, falling back to the
 * agent's own declared model. A caller-supplied model that resolves to nothing
 * retries against the agent's, which is inherited and so only ever warns.
 */
export function resolveEffectiveSubagentModel(
  explicitModel: string | boolean | undefined,
  agentModel: string | boolean | undefined,
  parentModel: ParentModel | undefined,
  availableModels: AvailableModelInfo[] | undefined,
  preferredProvider?: string,
  options?: Omit<ResolveSubagentModelOverrideOptions, 'source'>,
): string | undefined {
  const resolved = resolveSubagentModelOverride(
    explicitModel ?? agentModel,
    parentModel,
    availableModels,
    preferredProvider,
    { ...options, source: explicitModel !== undefined ? EXPLICIT_MODEL_SOURCE : INHERITED_MODEL_SOURCE },
  );
  if (resolved || explicitModel === undefined) return resolved;
  return resolveSubagentModelOverride(agentModel, parentModel, availableModels, preferredProvider, {
    ...options,
    source: INHERITED_MODEL_SOURCE,
  });
}

export interface BuildModelCandidatesOptions {
  /** Fallback models are inherited agent config and warn, rather than error, when out of scope. */
  scope?: ModelScopeConfig;
  onWarn?: (violation: ModelScopeViolation) => void;
}

/**
 * Build the ordered, de-duplicated list of models to try: the primary first,
 * then each declared fallback. The primary is left to the caller to scope-check,
 * since only the caller knows whether it was explicitly requested.
 */
export function buildModelCandidates(
  primaryModel: string | undefined,
  fallbackModels: string[] | undefined,
  availableModels: AvailableModelInfo[] | undefined,
  preferredProvider?: string,
  options?: BuildModelCandidatesOptions,
): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const rawCandidates = [primaryModel, ...(fallbackModels ?? [])];
  for (let index = 0; index < rawCandidates.length; index++) {
    const raw = rawCandidates[index];
    if (!raw) continue;
    const normalized = resolveModelCandidate(raw.trim(), availableModels, preferredProvider);
    if (!normalized || seen.has(normalized)) continue;
    if (index > 0 && options?.scope?.enforce) {
      const violation = checkModelScope(normalized, options.scope, INHERITED_MODEL_SOURCE);
      if (violation) (options.onWarn ?? discardScopeViolation)(violation);
    }
    seen.add(normalized);
    candidates.push(normalized);
  }
  return candidates;
}

/**
 * Pick the first configured primary/fallback model that the live parent can
 * authenticate. When no registry snapshot is supplied, preserve the primary
 * model for non-interactive callers and older persisted schedules.
 */
export function selectAvailableModel(
  primaryModel: string | undefined,
  fallbackModels: string[] | undefined,
  availableModels: AvailableModelInfo[] | undefined,
  preferredProvider?: string,
): string | undefined {
  if (availableModels === undefined) return primaryModel;
  const availableIds = new Set(availableModels.map((model) => model.fullId));
  for (const candidate of buildModelCandidates(primaryModel, fallbackModels, availableModels, preferredProvider)) {
    const { baseModel } = splitKnownThinkingSuffix(candidate);
    if (availableIds.has(baseModel)) return candidate;
  }
  return undefined;
}

const RETRYABLE_MODEL_FAILURE_PATTERNS = [
  /rate\s*limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota/i,
  /billing/i,
  /credit/i,
  /auth(?:entication)?/i,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /api key/i,
  /token expired/i,
  /invalid key/i,
  /provider.*unavailable/i,
  /model.*unavailable/i,
  /model.*disabled/i,
  /model.*not found/i,
  /unknown model/i,
  /overloaded/i,
  /service unavailable/i,
  /temporar(?:ily)? unavailable/i,
  /connection refused/i,
  /fetch failed/i,
  /network error/i,
  /socket hang up/i,
  /stream ended without finish_reason/i,
  /upstream/i,
  /timed? out/i,
  /timeout/i,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /cold.?start/i,
  /empty response/i,
  /no output/i,
  /model.*(?:load|fail|error)/i,
];

/**
 * Failures reported as `<tool> failed (exit N): ...` or `<tool> failed with
 * exit code N` come from a tool call inside the child's task, not from the
 * provider/model, however network-flavored their details read. Retrying a
 * different model cannot fix them and would rerun the whole task. Tool names
 * include namespaced forms like `mcp.server/write`.
 */
const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i;

export function isRetryableModelFailure(error: string | undefined): boolean {
  if (!error) return false;
  if (TOOL_FAILURE_PREFIX.test(error.trim())) return false;
  return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}

/** Default exit code reported when an attempt failed without one, so the note never reads `exit undefined`. */
const UNKNOWN_EXIT_CODE = 1;

export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
  const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? UNKNOWN_EXIT_CODE}`;
  return nextModel
    ? `${FALLBACK_NOTE_PREFIX} ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
    : `${FALLBACK_NOTE_PREFIX} ${attempt.model} failed: ${failure}.`;
}
