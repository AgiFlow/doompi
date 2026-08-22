/**
 * Ranked, actionable findings derived from a session snapshot.
 *
 * Every finding restates numbers the aggregator already holds and pairs them
 * with the one change that moves them, because a counter the user cannot act on
 * is screen space spent for nothing. Nothing here queries the sink: the panel
 * has to stay useful when no sink is connected, which is exactly the situation
 * where a user has no other way to see any of this.
 *
 * Thresholds are deliberately conservative. A finding that fires on a healthy
 * session teaches the user to ignore the panel, which is worse than an empty
 * one.
 */

import type { LogMetricsSnapshot, LogMetricsToolCost } from './metrics.ts';

export type LogMetricsFindingSeverity = 'critical' | 'warning' | 'info';

export interface LogMetricsFinding {
  /** Stable identifier, so a finding can be asserted without matching prose. */
  id: string;
  severity: LogMetricsFindingSeverity;
  /** What the finding is about: a tool name, or a facet like `cache`. */
  subject: string;
  /** The evidence, already formatted. */
  detail: string;
  /** The change that moves the number. */
  action: string;
}

/** Below this, the prompt prefix is churning and cache writes are being wasted. */
const LOW_CACHE_HIT_RATIO = 0.3;
/** Cache hit rate is meaningless on a session that has barely sent anything. */
const MIN_CACHE_SAMPLE_TOKENS = 50_000;
/** A tool is "expensive" only well clear of the session's typical turn. */
const EXPENSIVE_TOOL_RATIO = 1.5;
const MIN_TOOL_SAMPLES = 3;
const FAILING_TOOL_RATIO = 0.25;
const MIN_TOOL_CALLS = 3;
/** Sustained input this large per turn means context is carried, not scoped. */
const HEAVY_TURN_INPUT_TOKENS = 120_000;
const MIN_TURNS_FOR_AVERAGE = 3;
/** Tool calls per turn above this reads as search thrash rather than progress. */
const BUSY_TURN_TOOL_CALLS = 8;

const RATE_LIMITED = 'rate_limited';
/** Kept short because the finding's subject column already says "provider". */
const SHORT_CATEGORY: Record<string, string> = {
  [RATE_LIMITED]: 'rate limited',
  provider_unavailable: 'unavailable',
};

const SEVERITY_RANK: Record<LogMetricsFindingSeverity, number> = { critical: 0, warning: 1, info: 2 };
const PERCENT = 100;
const MILLION = 1_000_000;
const THOUSAND = 1000;
const COMPACT_DECIMALS = 1;
const HEALTHY_FINDING: LogMetricsFinding = {
  id: 'healthy',
  severity: 'info',
  subject: 'session',
  detail: 'no failures, no outliers',
  action: 'nothing to act on yet',
};

function compact(value: number): string {
  if (value >= MILLION) return `${(value / MILLION).toFixed(COMPACT_DECIMALS)}M`;
  if (value >= THOUSAND) return `${Math.round(value / THOUSAND)}k`;
  return String(Math.round(value));
}

function percent(value: number): string {
  return `${Math.round(value * PERCENT)}%`;
}

/**
 * Median rather than mean: one pathological tool would drag a mean up far
 * enough to hide itself from the comparison that is meant to catch it.
 */
function medianTokens(tools: readonly LogMetricsToolCost[]): number {
  const sampled = tools
    .map((tool) => tool.p90Tokens)
    .filter((tokens): tokens is number => tokens !== undefined)
    .sort((left, right) => left - right);
  if (sampled.length === 0) return 0;
  const middle = Math.floor(sampled.length / 2);
  const lower = sampled[middle - 1] ?? 0;
  const upper = sampled[middle] ?? 0;
  return sampled.length % 2 === 0 ? (lower + upper) / 2 : upper;
}

function cacheFinding(snapshot: LogMetricsSnapshot): LogMetricsFinding | undefined {
  const { cacheRead, cacheWrite, input } = snapshot.tokens;
  const cacheable = cacheRead + input;
  if (cacheable < MIN_CACHE_SAMPLE_TOKENS) return undefined;

  const hitRatio = cacheRead / cacheable;
  if (hitRatio >= LOW_CACHE_HIT_RATIO) return undefined;
  return {
    id: 'low-cache-hit',
    severity: 'warning',
    subject: 'cache',
    detail: `${percent(hitRatio)} hit · ${compact(cacheWrite)} written`,
    action: 'pin stable context first',
  };
}

function expensiveToolFinding(snapshot: LogMetricsSnapshot): LogMetricsFinding | undefined {
  const median = medianTokens(snapshot.toolCost);
  if (median <= 0) return undefined;

  const worst = snapshot.toolCost.find(
    (tool) => tool.samples >= MIN_TOOL_SAMPLES && (tool.p90Tokens ?? 0) >= median * EXPENSIVE_TOOL_RATIO,
  );
  if (!worst?.p90Tokens) return undefined;
  return {
    id: 'expensive-tool',
    severity: 'warning',
    subject: worst.name,
    detail: `${compact(worst.p90Tokens)} p90 · ${Math.round(worst.p90Tokens / median)}× median`,
    action: 'narrow what it pulls in',
  };
}

function failingToolFindings(snapshot: LogMetricsSnapshot): LogMetricsFinding[] {
  return snapshot.toolCost
    .filter((tool) => tool.calls >= MIN_TOOL_CALLS && tool.failed / tool.calls >= FAILING_TOOL_RATIO)
    .sort((left, right) => right.failed - left.failed)
    .map((tool) => ({
      id: `failing-tool:${tool.name}`,
      severity: 'critical' as const,
      subject: tool.name,
      detail: `${tool.failed} of ${tool.calls} failed`,
      action: 'retries burn tokens',
    }));
}

function abortedTurnFinding(snapshot: LogMetricsSnapshot): LogMetricsFinding | undefined {
  const redone = snapshot.abortedTurns + snapshot.failedTurns;
  if (redone === 0) return undefined;
  return {
    id: 'redone-turns',
    severity: 'critical',
    subject: 'turns',
    detail: `${snapshot.abortedTurns} aborted · ${snapshot.failedTurns} failed`,
    action: 'paid for, then thrown away',
  };
}

function providerFinding(snapshot: LogMetricsSnapshot): LogMetricsFinding | undefined {
  const category = snapshot.failureCategories.find((entry) => entry.name in SHORT_CATEGORY);
  if (!category) return undefined;
  return {
    id: `provider:${category.name}`,
    severity: 'warning',
    subject: 'provider',
    detail: `${category.count} × ${SHORT_CATEGORY[category.name] ?? category.name}`,
    action: category.name === RATE_LIMITED ? 'back off or drop concurrency' : 'retry or switch provider',
  };
}

function contextFinding(snapshot: LogMetricsSnapshot): LogMetricsFinding | undefined {
  if (snapshot.turns < MIN_TURNS_FOR_AVERAGE) return undefined;

  const perTurn = snapshot.tokens.input / snapshot.turns;
  if (perTurn < HEAVY_TURN_INPUT_TOKENS) return undefined;
  return {
    id: 'heavy-context',
    severity: 'warning',
    subject: 'context',
    detail: `${compact(perTurn)} input tok/turn`,
    action: 'compact or split the task',
  };
}

function toolChurnFinding(snapshot: LogMetricsSnapshot): LogMetricsFinding | undefined {
  if (snapshot.turns < MIN_TURNS_FOR_AVERAGE) return undefined;

  const perTurn = snapshot.toolCalls / snapshot.turns;
  if (perTurn < BUSY_TURN_TOOL_CALLS) return undefined;
  return {
    id: 'tool-churn',
    severity: 'info',
    subject: 'tools',
    detail: `${perTurn.toFixed(1)} calls/turn`,
    action: 'give it a narrower target',
  };
}

/**
 * Ranked most-actionable first. Severity leads because a failing tool costs
 * more than an inefficient one, and the panel is read top-down under a
 * height limit.
 */
export function deriveFindings(snapshot: LogMetricsSnapshot): LogMetricsFinding[] {
  const findings = [
    ...failingToolFindings(snapshot),
    abortedTurnFinding(snapshot),
    providerFinding(snapshot),
    cacheFinding(snapshot),
    expensiveToolFinding(snapshot),
    contextFinding(snapshot),
    toolChurnFinding(snapshot),
  ].filter((finding): finding is LogMetricsFinding => finding !== undefined);

  if (findings.length === 0) return snapshot.events > 0 ? [HEALTHY_FINDING] : [];
  return findings.sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]);
}
