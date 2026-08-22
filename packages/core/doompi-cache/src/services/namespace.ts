import type {
  PromptCacheChildProjection,
  PromptCacheDigest,
  PromptCacheMinorModeState,
  PromptCacheModelIdentity,
  PromptCacheParentState,
} from '../types/cache.ts';
import { canonicalJson } from './canonical.ts';

const KEY_PREFIX = 'dpc1_';
const PARENT_PREFIX = 'dpn1_';
const CHILD_PREFIX = 'dch1_';
const ROOT_PREFIX = 'dpr1_';
const MODEL_PREFIX = 'dpm1_';

function digestIdentity(prefix: string, value: unknown, digest: PromptCacheDigest): string {
  return `${prefix}${digest(canonicalJson(value))}`;
}

function normalizedPersona(value: string | undefined): string | undefined {
  const normalized = value?.trim().replaceAll('\\', '/');
  return normalized || undefined;
}

function activeMinorModes(modes: readonly PromptCacheMinorModeState[]): readonly Record<string, string>[] {
  return modes
    .filter(({ activation }) => activation === 'active' || activation === 'activating')
    .map(({ source, id, modelContextVariant }) => ({
      source,
      id,
      ...(modelContextVariant ? { modelContextVariant } : {}),
    }))
    .sort((left, right) => left.source.localeCompare(right.source) || left.id.localeCompare(right.id));
}

export function createRootSessionIdentity(rootSessionId: string, digest: PromptCacheDigest): string {
  return digestIdentity(ROOT_PREFIX, { version: 1, rootSessionId }, digest);
}

export function createParentPromptCacheNamespace(state: PromptCacheParentState, digest: PromptCacheDigest): string {
  return digestIdentity(
    PARENT_PREFIX,
    {
      version: 1,
      rootSession: createRootSessionIdentity(state.rootSessionId, digest),
      compositionFingerprint: state.compositionFingerprint ?? null,
      majorMode: state.majorMode,
      domains: [...state.domains],
      profile: state.profile ?? null,
      persona: normalizedPersona(state.persona) ?? null,
      minorModes: activeMinorModes(state.minorModes),
    },
    digest,
  );
}

export function createChildPromptCacheProjection(
  projection: PromptCacheChildProjection,
  digest: PromptCacheDigest,
): string {
  return digestIdentity(
    CHILD_PREFIX,
    {
      version: 1,
      systemPrompt: projection.systemPrompt ?? null,
      tools: [...projection.tools],
      excludedTools: [...projection.excludedTools].sort((left, right) => left.localeCompare(right)),
      extensions: [...projection.extensions],
      inheritProjectContext: projection.inheritProjectContext ?? null,
      inheritSkills: projection.inheritSkills ?? null,
      fanout: projection.fanout ?? null,
      structuredOutputSchema: projection.structuredOutputSchema ?? null,
    },
    digest,
  );
}

export function createPromptCacheModelFingerprint(model: PromptCacheModelIdentity, digest: PromptCacheDigest): string {
  return digestIdentity(
    MODEL_PREFIX,
    {
      version: 1,
      virtualProvider: model.virtualProvider ?? null,
      virtualModel: model.virtualModel ?? null,
      api: model.api ?? null,
      baseUrl: model.baseUrl ?? null,
      wireModel: model.wireModel ?? null,
    },
    digest,
  );
}

export function createPromptCacheKey(
  parentNamespace: string,
  scope: 'parent' | 'child',
  modelFingerprint: string,
  digest: PromptCacheDigest,
  childProjection?: string,
): string {
  return digestIdentity(
    KEY_PREFIX,
    {
      version: 1,
      parentNamespace,
      scope,
      childProjection: childProjection ?? null,
      modelFingerprint,
    },
    digest,
  );
}
