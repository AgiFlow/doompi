import { describe, expect, it } from 'vitest';

import {
  type AvailableModelInfo,
  buildModelCandidates,
  formatModelAttemptNote,
  fuzzyResolveModel,
  INHERIT_MODEL,
  isRetryableModelFailure,
  type ModelAttemptSummary,
  normalizeModelSegment,
  normalizeParentModel,
  resolveEffectiveSubagentModel,
  resolveModelCandidate,
  resolveSubagentModelOverride,
} from '../../src/services/modelFallback';
import { checkModelScope, matchesScopePattern, type ModelScopeViolation } from '../../src/services/modelScope';
import type { ModelScopeConfig } from '../../src/types';

// ============================================================================
// model-scope
// ============================================================================

describe('scope pattern matching', () => {
  it('expands `*` across the whole id so a provider wildcard covers every model it offers', () => {
    expect(matchesScopePattern('anthropic/claude-opus-5', 'anthropic/*')).toBe(true);
    expect(matchesScopePattern('anthropic/claude-haiku-4-5-20251001', 'anthropic/*')).toBe(true);
    // `.*` deliberately spans `/`, so a nested id under the provider still matches.
    expect(matchesScopePattern('anthropic/vendor/model', 'anthropic/*')).toBe(true);
  });

  it('anchors the pattern, so a literal matches only itself and not a longer id', () => {
    expect(matchesScopePattern('anthropic/claude-opus-5', 'anthropic/claude-opus-5')).toBe(true);
    // Without the `^...$` anchors a scope entry would silently admit every
    // variant that merely starts with an allowed name.
    expect(matchesScopePattern('anthropic/claude-opus-5-mini', 'anthropic/claude-opus-5')).toBe(false);
    expect(matchesScopePattern('other/anthropic/claude-opus-5', 'anthropic/claude-opus-5')).toBe(false);
  });

  it('matches against the full provider/id, so a bare id never satisfies a qualified pattern', () => {
    // A pattern is compared to `provider/id`; letting a bare id through would
    // admit a same-named model from a provider that was never allowed.
    expect(matchesScopePattern('claude-opus-5', 'anthropic/claude-opus-5')).toBe(false);
    expect(matchesScopePattern('bedrock/claude-opus-5', 'anthropic/*')).toBe(false);
  });

  it('treats a regex metacharacter in a pattern as a literal', () => {
    // `.` must not act as "any character": that would widen an allow entry into
    // a family of models the operator never listed.
    expect(matchesScopePattern('anthropic/claudeX5', 'anthropic/claude.5')).toBe(false);
    expect(matchesScopePattern('anthropic/claude.5', 'anthropic/claude.5')).toBe(true);
    // `+` would otherwise mean "one or more of the preceding token".
    expect(matchesScopePattern('openai/o11', 'openai/o1+')).toBe(false);
    expect(matchesScopePattern('openai/o1+', 'openai/o1+')).toBe(true);
    // A pattern full of specials must still compile rather than throw.
    expect(matchesScopePattern('openai/gpt-5', 'openai/(gpt-5|gpt-4)')).toBe(false);
    expect(matchesScopePattern('openai/(gpt-5|gpt-4)', 'openai/(gpt-5|gpt-4)')).toBe(true);
    expect(matchesScopePattern('openai/a[b]c', 'openai/a[b]c')).toBe(true);
  });

  it('compares case-insensitively so a differently-cased allow entry still matches', () => {
    expect(matchesScopePattern('anthropic/Claude-Opus-5', 'ANTHROPIC/claude-opus-5')).toBe(true);
  });

  it('strips a known thinking suffix before matching, since it is not part of model identity', () => {
    // `anthropic/claude-opus-5:high` is the same model at a different thinking
    // level; requiring operators to list every level would be unusable.
    expect(matchesScopePattern('anthropic/claude-opus-5:high', 'anthropic/claude-opus-5')).toBe(true);
    // An unknown suffix is part of the id (`vendor:free`), so it is not stripped.
    expect(matchesScopePattern('openrouter/vendor:free', 'openrouter/vendor')).toBe(false);
    expect(matchesScopePattern('openrouter/vendor:free', 'openrouter/vendor:free')).toBe(true);
  });
});

describe('model scope enforcement severity', () => {
  const scope: ModelScopeConfig = { enforce: true, allow: ['anthropic/*'] };

  it('reports an explicitly requested out-of-scope model as an error', () => {
    // The caller named this model, so honouring it would silently ignore policy.
    const violation = checkModelScope('openai/gpt-5', scope, 'explicit');
    expect(violation?.severity).toBe('error');
    expect(violation?.model).toBe('openai/gpt-5');
    expect(violation?.allowedPatterns).toEqual(['anthropic/*']);
    expect(violation?.message).toContain('openai/gpt-5');
    expect(violation?.message).toContain('anthropic/*');
  });

  it('reports an inherited out-of-scope model as only a warning', () => {
    // Nobody asked for this model at the call site: it came from frontmatter,
    // settings, or the parent session. Erroring would break a configuration
    // that worked before the scope was tightened.
    const violation = checkModelScope('openai/gpt-5', scope, 'inherited');
    expect(violation?.severity).toBe('warn');
  });

  it('reports the base model without the thinking suffix', () => {
    const violation = checkModelScope('openai/gpt-5:high', scope, 'explicit');
    expect(violation?.model).toBe('openai/gpt-5');
  });

  it('allows an in-scope model regardless of provenance', () => {
    expect(checkModelScope('anthropic/claude-opus-5', scope, 'explicit')).toBeUndefined();
    expect(checkModelScope('anthropic/claude-opus-5', scope, 'inherited')).toBeUndefined();
  });

  it('is inert without a model or without enforcement', () => {
    expect(checkModelScope(undefined, scope, 'explicit')).toBeUndefined();
    expect(checkModelScope('', scope, 'explicit')).toBeUndefined();
    expect(checkModelScope('openai/gpt-5', undefined, 'explicit')).toBeUndefined();
    expect(checkModelScope('openai/gpt-5', { enforce: false, allow: ['anthropic/*'] }, 'explicit')).toBeUndefined();
  });

  it('FAILS OPEN when enforcement is on but the allow list is empty or absent', () => {
    // Documented current behaviour: enforcement with no patterns permits every
    // model rather than denying every model. The module header argues the
    // settings parser rejects that combination upstream, so this branch is only
    // reachable for a config built programmatically. Anything constructing a
    // ModelScopeConfig by hand and setting `enforce: true` before its allow list
    // is populated gets no enforcement at all, with no diagnostic.
    expect(checkModelScope('openai/gpt-5', { enforce: true, allow: [] }, 'explicit')).toBeUndefined();
    expect(checkModelScope('openai/gpt-5', { enforce: true }, 'explicit')).toBeUndefined();
  });
});

// ============================================================================
// model-fallback
// ============================================================================

const registry: AvailableModelInfo[] = [
  { provider: 'anthropic', id: 'claude-opus-5', fullId: 'anthropic/claude-opus-5' },
  { provider: 'anthropic', id: 'claude-sonnet-5-20250101', fullId: 'anthropic/claude-sonnet-5-20250101' },
  { provider: 'bedrock', id: 'claude-opus-5', fullId: 'bedrock/claude-opus-5' },
  { provider: 'openai', id: 'gpt-5', fullId: 'openai/gpt-5' },
];

describe('parent model normalization', () => {
  it('accepts a well-formed provider/id pair', () => {
    expect(normalizeParentModel({ provider: 'anthropic', id: 'claude-opus-5' })).toEqual({
      provider: 'anthropic',
      id: 'claude-opus-5',
    });
  });

  it('rejects anything that cannot name a model, so a child is never given a broken --model', () => {
    expect(normalizeParentModel(undefined)).toBeUndefined();
    expect(normalizeParentModel('anthropic/claude-opus-5')).toBeUndefined();
    expect(normalizeParentModel({ provider: 'anthropic' })).toBeUndefined();
    expect(normalizeParentModel({ id: 'claude-opus-5' })).toBeUndefined();
    expect(normalizeParentModel({ provider: 1, id: 'claude-opus-5' })).toBeUndefined();
    expect(normalizeParentModel({ provider: 'anthropic', id: 2 })).toBeUndefined();
    expect(normalizeParentModel({ provider: '', id: 'claude-opus-5' })).toBeUndefined();
    expect(normalizeParentModel({ provider: 'anthropic', id: '' })).toBeUndefined();
  });
});

describe('model segment normalization', () => {
  it('folds case and separator spelling so `4.5` and `4_5` reach `4-5`', () => {
    expect(normalizeModelSegment('Claude_Opus.5')).toBe('claude-opus-5');
    expect(normalizeModelSegment('claude--opus---5')).toBe('claude-opus-5');
    expect(normalizeModelSegment('-claude-opus-5-')).toBe('claude-opus-5');
  });
});

describe('fuzzy model resolution', () => {
  it('tolerates separator and case differences', () => {
    expect(fuzzyResolveModel('anthropic/Claude_Opus.5', registry)).toBe('anthropic/claude-opus-5');
  });

  it('accepts `:` and `.` as provider separators only when the prefix names a real provider', () => {
    expect(fuzzyResolveModel('openai:gpt-5', registry)).toBe('openai/gpt-5');
    expect(fuzzyResolveModel('anthropic.claude-opus-5', registry)).toBe('anthropic/claude-opus-5');
    // `gpt` is not a provider, so this stays an unqualified id and finds nothing.
    expect(fuzzyResolveModel('gpt:5', registry)).toBeUndefined();
  });

  it('matches a dated registry id from an undated query', () => {
    // Providers restamp ids; requiring the exact date would break configs on
    // every model refresh.
    expect(fuzzyResolveModel('anthropic/claude-sonnet-5', registry)).toBe('anthropic/claude-sonnet-5-20250101');
    expect(fuzzyResolveModel('anthropic/claude-sonnet-5-2025-01-01', registry)).toBe(
      'anthropic/claude-sonnet-5-20250101',
    );
  });

  it('does not mistake a version-shaped tail for a date stamp', () => {
    // `-1234` is out of the plausible year range, so it must stay part of the id.
    expect(fuzzyResolveModel('anthropic/claude-sonnet-5-12340101', registry)).toBeUndefined();
  });

  it('refuses an ambiguous unqualified id rather than guessing a provider', () => {
    // Two providers offer `claude-opus-5` and picking one costs real money.
    expect(fuzzyResolveModel('claude-opus-5', registry)).toBeUndefined();
    expect(fuzzyResolveModel('claude-opus-5', registry, 'bedrock')).toBe('bedrock/claude-opus-5');
    // A preferred provider that offers none of the candidates cannot break the tie.
    expect(fuzzyResolveModel('claude-opus-5', registry, 'openai')).toBeUndefined();
  });

  it('never crosses providers for a qualified query', () => {
    expect(fuzzyResolveModel('anthropic/gpt-5', registry)).toBeUndefined();
    // Even a preferred provider cannot override the provider the query named.
    expect(fuzzyResolveModel('anthropic/gpt-5', registry, 'openai')).toBeUndefined();
  });

  it('returns undefined for an id nothing offers', () => {
    expect(fuzzyResolveModel('nope/not-a-model', registry)).toBeUndefined();
  });
});

describe('model candidate resolution', () => {
  it('keeps the caller spelling when there is no registry to match against', () => {
    expect(resolveModelCandidate('anything/at-all', undefined)).toBe('anything/at-all');
    expect(resolveModelCandidate('anything/at-all', [])).toBe('anything/at-all');
  });

  it('returns undefined for no model at all', () => {
    expect(resolveModelCandidate(undefined, registry)).toBeUndefined();
  });

  it('prefers an exact registry match', () => {
    expect(resolveModelCandidate('anthropic/claude-opus-5', registry)).toBe('anthropic/claude-opus-5');
  });

  it('disambiguates a bare id with the preferred provider', () => {
    expect(resolveModelCandidate('claude-opus-5', registry, 'anthropic')).toBe('anthropic/claude-opus-5');
    expect(resolveModelCandidate('gpt-5', registry)).toBe('openai/gpt-5');
    // Only one provider offers this id, so a preferred provider that does not
    // have it is simply ignored rather than blocking resolution.
    expect(resolveModelCandidate('gpt-5', registry, 'anthropic')).toBe('openai/gpt-5');
  });

  it('keeps an ambiguous bare id as written rather than picking a provider', () => {
    expect(resolveModelCandidate('claude-opus-5', registry)).toBe('claude-opus-5');
  });

  it('resolves the base model and re-attaches a known thinking suffix', () => {
    // The suffix is not part of registry identity, so resolution has to happen
    // on the base id and then be put back, or thinking would be dropped.
    expect(resolveModelCandidate('anthropic/Claude_Opus.5:high', registry)).toBe('anthropic/claude-opus-5:high');
  });

  it('falls back to the caller spelling when nothing resolves', () => {
    expect(resolveModelCandidate('nope/not-a-model', registry)).toBe('nope/not-a-model');
    expect(resolveModelCandidate('nope/not-a-model:high', registry)).toBe('nope/not-a-model:high');
  });
});

describe('subagent model override', () => {
  it('hands the child the parent session model when nothing is requested', () => {
    // A child left to resolve its own model would read the shared global
    // settings file and could be decided by an unrelated open session.
    const parent = { provider: 'anthropic', id: 'claude-opus-5' };
    expect(resolveSubagentModelOverride(undefined, parent, registry)).toBe('anthropic/claude-opus-5');
    expect(resolveSubagentModelOverride('', parent, registry)).toBe('anthropic/claude-opus-5');
    expect(resolveSubagentModelOverride('   ', parent, registry)).toBe('anthropic/claude-opus-5');
    expect(resolveSubagentModelOverride(false, parent, registry)).toBe('anthropic/claude-opus-5');
    expect(resolveSubagentModelOverride(INHERIT_MODEL, parent, registry)).toBe('anthropic/claude-opus-5');
  });

  it('resolves nothing when there is no request and no parent model', () => {
    expect(resolveSubagentModelOverride(undefined, undefined, registry)).toBeUndefined();
  });

  it('resolves an explicitly requested model through the registry', () => {
    expect(resolveSubagentModelOverride('anthropic/Claude_Opus.5', undefined, registry)).toBe(
      'anthropic/claude-opus-5',
    );
  });

  it('throws for an explicit out-of-scope model', () => {
    expect(() =>
      resolveSubagentModelOverride('openai/gpt-5', undefined, registry, undefined, {
        scope: { enforce: true, allow: ['anthropic/*'] },
        source: 'explicit',
      }),
    ).toThrow(/outside the configured subagent model scope/);
  });

  it('only warns for an inherited out-of-scope model', () => {
    const warnings: ModelScopeViolation[] = [];
    const resolved = resolveSubagentModelOverride('openai/gpt-5', undefined, registry, undefined, {
      scope: { enforce: true, allow: ['anthropic/*'] },
      source: 'inherited',
      onWarn: (violation) => warnings.push(violation),
    });
    expect(resolved).toBe('openai/gpt-5');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe('warn');
  });

  it('defaults to `inherited` when no source is declared', () => {
    const warnings: ModelScopeViolation[] = [];
    resolveSubagentModelOverride('openai/gpt-5', undefined, registry, undefined, {
      scope: { enforce: true, allow: ['anthropic/*'] },
      onWarn: (violation) => warnings.push(violation),
    });
    expect(warnings).toHaveLength(1);
  });

  it('downgrades to a warning when the model came from the parent, even if the caller said explicit', () => {
    // The parent's model was never requested at this call site, so declaring it
    // explicit must not turn an inherited configuration into a hard failure.
    const warnings: ModelScopeViolation[] = [];
    const resolved = resolveSubagentModelOverride(
      INHERIT_MODEL,
      { provider: 'openai', id: 'gpt-5' },
      registry,
      undefined,
      {
        scope: { enforce: true, allow: ['anthropic/*'] },
        source: 'explicit',
        onWarn: (violation) => warnings.push(violation),
      },
    );
    expect(resolved).toBe('openai/gpt-5');
    expect(warnings[0].severity).toBe('warn');
  });

  it('drops the violation silently when no handler is supplied, rather than writing to stdio', () => {
    // This module runs inside the parent's TUI and inside a detached runner
    // whose stdout is the child's transcript, so it must never print. A warn is
    // advisory by definition; its error-severity sibling throws instead.
    const resolved = resolveSubagentModelOverride('openai/gpt-5', undefined, registry, undefined, {
      scope: { enforce: true, allow: ['anthropic/*'] },
      source: 'inherited',
    });
    expect(resolved).toBe('openai/gpt-5');
  });
});

describe('effective subagent model', () => {
  it('treats a caller-supplied model as explicit and an agent-declared one as inherited', () => {
    // This is the provenance that decides throw-vs-warn downstream.
    expect(() =>
      resolveEffectiveSubagentModel('openai/gpt-5', 'anthropic/claude-opus-5', undefined, registry, undefined, {
        scope: { enforce: true, allow: ['anthropic/*'] },
      }),
    ).toThrow(/outside the configured subagent model scope/);

    const warnings: ModelScopeViolation[] = [];
    const resolved = resolveEffectiveSubagentModel(undefined, 'openai/gpt-5', undefined, registry, undefined, {
      scope: { enforce: true, allow: ['anthropic/*'] },
      onWarn: (violation) => warnings.push(violation),
    });
    expect(resolved).toBe('openai/gpt-5');
    expect(warnings[0].severity).toBe('warn');
  });

  it('retries against the agent model when the caller request resolves to nothing', () => {
    // `false`/empty from the caller with no parent session model leaves nothing
    // to run on; the agent's own declared model is the remaining source.
    const warnings: ModelScopeViolation[] = [];
    const resolved = resolveEffectiveSubagentModel(false, 'openai/gpt-5', undefined, registry, undefined, {
      scope: { enforce: true, allow: ['anthropic/*'] },
      onWarn: (violation) => warnings.push(violation),
    });
    expect(resolved).toBe('openai/gpt-5');
    // The retry is inherited, so it warns rather than throwing.
    expect(warnings.every((violation) => violation.severity === 'warn')).toBe(true);
  });

  it('returns undefined when neither the caller, the agent, nor the parent names a model', () => {
    expect(resolveEffectiveSubagentModel(undefined, undefined, undefined, registry)).toBeUndefined();
  });
});

describe('model candidate chain', () => {
  it('keeps the primary first and then each fallback in declared order', () => {
    expect(
      buildModelCandidates('anthropic/claude-opus-5', ['openai/gpt-5', 'bedrock/claude-opus-5'], registry),
    ).toEqual(['anthropic/claude-opus-5', 'openai/gpt-5', 'bedrock/claude-opus-5']);
  });

  it('de-duplicates after resolution, so two spellings of one model are not tried twice', () => {
    expect(
      buildModelCandidates('anthropic/claude-opus-5', ['anthropic/Claude_Opus.5', ' openai/gpt-5 '], registry),
    ).toEqual(['anthropic/claude-opus-5', 'openai/gpt-5']);
  });

  it('skips empty entries and tolerates a missing primary or missing fallbacks', () => {
    expect(buildModelCandidates(undefined, ['openai/gpt-5'], registry)).toEqual(['openai/gpt-5']);
    expect(buildModelCandidates('openai/gpt-5', undefined, registry)).toEqual(['openai/gpt-5']);
    expect(buildModelCandidates('', [''], registry)).toEqual([]);
  });

  it('scope-checks only the fallbacks, and only ever warns about them', () => {
    // The primary belongs to the caller, who alone knows whether it was
    // explicitly requested; fallbacks are always inherited agent config.
    const warnings: ModelScopeViolation[] = [];
    const candidates = buildModelCandidates('openai/gpt-5', ['bedrock/claude-opus-5'], registry, undefined, {
      scope: { enforce: true, allow: ['anthropic/*'] },
      onWarn: (violation) => warnings.push(violation),
    });
    expect(candidates).toEqual(['openai/gpt-5', 'bedrock/claude-opus-5']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].model).toBe('bedrock/claude-opus-5');
    expect(warnings[0].severity).toBe('warn');
  });

  it('says nothing about an in-scope fallback', () => {
    const warnings: ModelScopeViolation[] = [];
    buildModelCandidates('anthropic/claude-opus-5', ['anthropic/claude-sonnet-5-20250101'], registry, undefined, {
      scope: { enforce: true, allow: ['anthropic/*'] },
      onWarn: (violation) => warnings.push(violation),
    });
    expect(warnings).toHaveLength(0);
  });

  it('drops an out-of-scope fallback violation when no handler is supplied, rather than writing to stdio', () => {
    const candidates = buildModelCandidates('anthropic/claude-opus-5', ['openai/gpt-5'], registry, undefined, {
      scope: { enforce: true, allow: ['anthropic/*'] },
    });
    expect(candidates).toContain('openai/gpt-5');
  });

  it('leaves an out-of-scope fallback in the chain rather than dropping it', () => {
    // Documented current behaviour: a warned fallback is still a candidate, so
    // exhausting the primary can still land a run on a model outside the scope.
    const candidates = buildModelCandidates('anthropic/claude-opus-5', ['openai/gpt-5'], registry, undefined, {
      scope: { enforce: true, allow: ['anthropic/*'] },
      onWarn: () => undefined,
    });
    expect(candidates).toContain('openai/gpt-5');
  });
});

describe('retryable model failures', () => {
  it('retries provider-side failures', () => {
    for (const error of [
      'rate limit exceeded',
      'Too Many Requests',
      'HTTP 429',
      'quota exhausted',
      'billing issue',
      'authentication failed',
      'model gpt-5 not found',
      'overloaded',
      'service unavailable',
      'fetch failed',
      'socket hang up',
      'HTTP 503',
      'request timed out',
      'empty response',
    ]) {
      expect(isRetryableModelFailure(error)).toBe(true);
    }
  });

  it('does not retry a failure with no error text or an unrecognised one', () => {
    expect(isRetryableModelFailure(undefined)).toBe(false);
    expect(isRetryableModelFailure('')).toBe(false);
    expect(isRetryableModelFailure('the task did not satisfy the acceptance gate')).toBe(false);
  });

  it('does not retry a tool failure however network-flavoured its details read', () => {
    // The model was never the problem, and a retry reruns the entire task.
    expect(isRetryableModelFailure('bash failed (exit 1): fetch failed')).toBe(false);
    expect(isRetryableModelFailure('mcp.server/write failed (exit 2): connection refused')).toBe(false);
    expect(isRetryableModelFailure('  edit failed (exit 3): timeout')).toBe(false);
    // The detail-less form the runner emits when it has no error body.
    expect(isRetryableModelFailure('bash failed with exit code 1')).toBe(false);
    // A provider message that merely mentions a tool name is still retryable.
    expect(isRetryableModelFailure('bash tool call hit a rate limit')).toBe(true);
  });

  it('misses a `with exit code N:` failure that carries trailing detail', () => {
    // Current behaviour, asserted as-is. TOOL_FAILURE_PREFIX
    // (src/runs/shared/modelFallback.ts:371) accepts a colon after `(exit N)`
    // but requires whitespace or end-of-string after `with exit code N`, so a
    // message shaped `<tool> failed with exit code N: <details>` escapes the
    // guard. `worktree setup hook failed with exit code ${status}: ${details}`
    // (src/runs/shared/worktree.ts:409) is exactly that shape, so a setup hook
    // that prints a network-flavoured detail is misread as a provider fault and
    // the whole task is rerun on the next model in the chain.
    expect(isRetryableModelFailure('worktree setup hook failed with exit code 2: connection refused')).toBe(true);
  });
});

describe('model attempt notes', () => {
  it('names the next model when the chain continues', () => {
    const attempt: ModelAttemptSummary = { model: 'openai/gpt-5', success: false, error: 'rate limit' };
    expect(formatModelAttemptNote(attempt, 'anthropic/claude-opus-5')).toBe(
      '[fallback] openai/gpt-5 failed: rate limit. Retrying with anthropic/claude-opus-5.',
    );
  });

  it('reads as terminal once the chain is exhausted', () => {
    const attempt: ModelAttemptSummary = { model: 'openai/gpt-5', success: false, error: 'rate limit' };
    expect(formatModelAttemptNote(attempt)).toBe('[fallback] openai/gpt-5 failed: rate limit.');
  });

  it('falls back to the exit code, never printing `exit undefined`', () => {
    expect(formatModelAttemptNote({ model: 'openai/gpt-5', success: false, exitCode: 137 })).toBe(
      '[fallback] openai/gpt-5 failed: exit 137.',
    );
    expect(formatModelAttemptNote({ model: 'openai/gpt-5', success: false, error: '   ' })).toBe(
      '[fallback] openai/gpt-5 failed: exit 1.',
    );
    expect(formatModelAttemptNote({ model: 'openai/gpt-5', success: false, exitCode: null })).toBe(
      '[fallback] openai/gpt-5 failed: exit 1.',
    );
  });
});
