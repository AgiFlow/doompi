/**
 * Resolving a loosely-spelled model name to a canonical `provider/id`.
 *
 * Users and agent frontmatter name models by hand, so the same string has to
 * resolve the same way wherever it is written. This is a leaf so every domain
 * can share one answer.
 *
 * DESIGN PATTERNS:
 * - Pure functions over a registry passed in, so model policy is testable with
 *   no process, no config on disk and no network
 * - Exact matches win; fuzzy matching is only ever a fallback
 * - A qualified `provider/id` query never resolves across providers, and an
 *   ambiguous match resolves to nothing rather than guessing. Picking the wrong
 *   provider costs real money
 *
 * AVOID:
 * - Splitting a model string on the first colon to find a thinking suffix; ids
 *   legitimately contain colons, which is why `splitKnownThinkingSuffix` exists
 * - Adding a second, looser resolver anywhere. Two spellings of "the same
 *   model" that disagree are worse than one that is occasionally strict
 */

import { type ModelInfo as AvailableModelInfo, splitKnownThinkingSuffix } from './modelInfo';

export type { AvailableModelInfo };

interface ModelRegistryLike<TModel extends { provider: string; id: string }> {
  getAvailable(): TModel[];
  hasConfiguredAuth(model: TModel): boolean;
}

/** Return only models the live host can authenticate, in registry order. */
export function authenticatedModelInfos<TModel extends { provider: string; id: string }>(
  registry: ModelRegistryLike<TModel>,
): AvailableModelInfo[] {
  return registry
    .getAvailable()
    .filter((model) => registry.hasConfiguredAuth(model))
    .map((model) => ({ provider: model.provider, id: model.id, fullId: `${model.provider}/${model.id}` }));
}

/** Separates provider from id in a canonical model reference. */
export const PROVIDER_SEPARATOR = '/';

/**
 * Separators an unqualified query may use in place of `/`. Only accepted when
 * the leading segment names a provider that actually exists, so a model id
 * containing a dot is not mistaken for `provider.id`.
 */
const ALTERNATE_PROVIDER_SEPARATORS = [':', '.'];

/** Bounds for a trailing date stamp, wide enough to be permissive and narrow enough to reject version numbers. */
const MIN_DATE_STAMP_YEAR = 1900;
const MAX_DATE_STAMP_YEAR = 2099;
const MONTHS_PER_YEAR = 12;
const MAX_DAYS_PER_MONTH = 31;

/** `-2025-10-01` and `-20251001` respectively, anchored to the end of a segment. */
const DASHED_DATE_STAMP = /^(.*)-(\d{4})-(\d{2})-(\d{2})$/;
const COMPACT_DATE_STAMP = /^(.*)-(\d{4})(\d{2})(\d{2})$/;

/**
 * Normalize a model id or provider segment for fuzzy comparison: case-fold,
 * treat dots/underscores as dashes (so `4.5` matches `4-5`), and collapse
 * repeated separators. Pure.
 */
export function normalizeModelSegment(segment: string): string {
  return segment.toLowerCase().replace(/[._]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function isPlausibleDateStamp(year: string, month: string, day: string): boolean {
  const yyyy = Number(year);
  const mm = Number(month);
  const dd = Number(day);
  return (
    yyyy >= MIN_DATE_STAMP_YEAR &&
    yyyy <= MAX_DATE_STAMP_YEAR &&
    mm >= 1 &&
    mm <= MONTHS_PER_YEAR &&
    dd >= 1 &&
    dd <= MAX_DAYS_PER_MONTH
  );
}

/** Drop a trailing date stamp (`-20251001` or `-2025-10-01`) so dated and undated ids match. Pure. */
function stripTrailingDateStamp(segment: string): string {
  const dashed = DASHED_DATE_STAMP.exec(segment);
  if (dashed && isPlausibleDateStamp(dashed[2], dashed[3], dashed[4])) return dashed[1];
  const compact = COMPACT_DATE_STAMP.exec(segment);
  if (compact && isPlausibleDateStamp(compact[2], compact[3], compact[4])) return compact[1];
  return segment;
}

function resolveBaseModelCandidate(
  baseModel: string,
  availableModels: AvailableModelInfo[],
  preferredProvider?: string,
): string | undefined {
  if (baseModel.includes(PROVIDER_SEPARATOR)) {
    const exact = availableModels.find((entry) => entry.fullId === baseModel);
    if (exact) return exact.fullId;
  } else {
    const exactMatches = availableModels.filter((entry) => entry.id === baseModel);
    if (preferredProvider) {
      const preferredMatch = exactMatches.find((entry) => entry.provider === preferredProvider);
      if (preferredMatch) return preferredMatch.fullId;
    }
    if (exactMatches.length === 1) return exactMatches[0].fullId;
  }

  return fuzzyResolveModel(baseModel, availableModels, preferredProvider);
}

/**
 * Fuzzy-resolve a base model id (thinking suffix already stripped) against the
 * registry, tolerating separator, case, and optional date-stamp differences so
 * users do not have to spell provider/model exactly. A qualified `provider/id`
 * query only matches within the named provider, so this never silently switches
 * providers for security/cost-sensitive configs. Returns the matched `fullId`,
 * or `undefined` when there is no match or the match is ambiguous across
 * providers (and no `preferredProvider` disambiguates). Pure.
 */
export function fuzzyResolveModel(
  baseModel: string,
  availableModels: AvailableModelInfo[],
  preferredProvider?: string,
): string | undefined {
  let queryProvider: string | undefined;
  let queryIdRaw = baseModel;
  const slashIdx = baseModel.indexOf(PROVIDER_SEPARATOR);
  if (slashIdx !== -1) {
    queryProvider = normalizeModelSegment(baseModel.slice(0, slashIdx));
    queryIdRaw = baseModel.slice(slashIdx + 1);
  } else {
    for (const separator of ALTERNATE_PROVIDER_SEPARATORS) {
      const separatorIdx = baseModel.indexOf(separator);
      if (separatorIdx <= 0) continue;
      const providerPart = normalizeModelSegment(baseModel.slice(0, separatorIdx));
      if (!availableModels.some((entry) => normalizeModelSegment(entry.provider) === providerPart)) continue;
      queryProvider = providerPart;
      queryIdRaw = baseModel.slice(separatorIdx + 1);
      break;
    }
  }
  const queryId = normalizeModelSegment(queryIdRaw);
  const queryIdNoDate = stripTrailingDateStamp(queryId);

  const candidates = availableModels.filter((entry) => {
    const entryId = normalizeModelSegment(entry.id);
    if (entryId !== queryId && stripTrailingDateStamp(entryId) !== queryIdNoDate) return false;
    if (queryProvider !== undefined && normalizeModelSegment(entry.provider) !== queryProvider) return false;
    return true;
  });
  if (candidates.length === 0) return undefined;
  if (preferredProvider) {
    const preferredProviderNorm = normalizeModelSegment(preferredProvider);
    const preferred = candidates.find((entry) => normalizeModelSegment(entry.provider) === preferredProviderNorm);
    if (preferred) return preferred.fullId;
  }
  if (candidates.length === 1) return candidates[0].fullId;
  return undefined;
}

/**
 * Resolve a possibly-loose model id to a canonical `provider/id` (plus any
 * thinking suffix). Exact registry matches win; fuzzy normalization
 * (separator/case/date-stamp via {@link fuzzyResolveModel}) is a fallback so
 * spelling differences still resolve. Never switches providers for a qualified
 * query. Pure.
 */
export function resolveModelCandidate(
  model: string | undefined,
  availableModels: AvailableModelInfo[] | undefined,
  preferredProvider?: string,
): string | undefined {
  if (!model) return undefined;
  // With no registry to match against, the caller's spelling is all there is.
  if (!availableModels || availableModels.length === 0) return model;

  const resolvedWhole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
  if (resolvedWhole) return resolvedWhole;

  const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(model);
  if (!thinkingSuffix) return model;
  const resolvedBase = resolveBaseModelCandidate(baseModel, availableModels, preferredProvider);
  if (resolvedBase) return `${resolvedBase}${thinkingSuffix}`;
  return model;
}
