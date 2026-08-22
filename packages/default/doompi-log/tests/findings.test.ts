import { describe, expect, it } from 'vitest';
import { deriveFindings } from '../src/services/findings.ts';
import { LogMetricsAggregator } from '../src/services/metrics.ts';

/**
 * Findings are asserted through the aggregator rather than a hand-built
 * snapshot: a rule that fires on a literal object but never on the records the
 * extension actually emits is a rule that does not exist.
 */
const TURN_FINISHED = 'pi.turn.finished';
const TURN_FAILED = 'pi.turn.failed';
const TOOL_RESULT = 'pi.tool_result';
const TOOL_TOKEN_SAMPLE = 'pi.tool_token_sample';
const API_ERROR = 'pi.api_error';

interface TurnUsage {
  input?: number;
  output?: number;
  total?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

function turn(aggregator: LogMetricsAggregator, usage: TurnUsage = {}): void {
  aggregator.record(TURN_FINISHED, {
    'gen_ai.usage.input_tokens': usage.input ?? 0,
    'gen_ai.usage.output_tokens': usage.output ?? 0,
    'gen_ai.usage.total_tokens': usage.total ?? 0,
    'gen_ai.usage.cache_read_tokens': usage.cacheRead ?? 0,
    'gen_ai.usage.cache_write_tokens': usage.cacheWrite ?? 0,
    'gen_ai.usage.cost': usage.cost ?? 0,
  });
}

function toolCalls(aggregator: LogMetricsAggregator, name: string, count: number, failed = 0): void {
  for (let index = 0; index < count; index++) {
    aggregator.record(TOOL_RESULT, {
      'tool.name': name,
      'tool.call.id': `${name}-${index}`,
      'tool.result.error': index < failed,
    });
  }
}

function tokenSamples(aggregator: LogMetricsAggregator, name: string, total: number, count: number): void {
  for (let index = 0; index < count; index++) {
    aggregator.record(TOOL_TOKEN_SAMPLE, {
      'tool.name': name,
      'gen_ai.usage.total_tokens': total,
      token_attribution: 'toolCallTurn',
    });
  }
}

function ids(aggregator: LogMetricsAggregator): string[] {
  return deriveFindings(aggregator.snapshot()).map((finding) => finding.id);
}

describe('deriveFindings', () => {
  it('says nothing about a session that has produced no records', () => {
    expect(deriveFindings(new LogMetricsAggregator().snapshot())).toEqual([]);
  });

  it('reports a healthy session rather than an empty panel', () => {
    const aggregator = new LogMetricsAggregator();
    turn(aggregator, { input: 1000, output: 100, total: 1100, cacheRead: 9000 });

    const findings = deriveFindings(aggregator.snapshot());

    expect(findings.map((finding) => finding.id)).toEqual(['healthy']);
    expect(findings[0]?.severity).toBe('info');
  });

  it('flags a low cache hit rate with the write volume it wasted', () => {
    const aggregator = new LogMetricsAggregator();
    turn(aggregator, { input: 900_000, total: 900_000, cacheRead: 10_000, cacheWrite: 800_000 });

    const cache = deriveFindings(aggregator.snapshot()).find((finding) => finding.id === 'low-cache-hit');

    expect(cache?.detail).toContain('1% hit');
    expect(cache?.detail).toContain('800k written');
    expect(cache?.action).toBe('pin stable context first');
  });

  it('stays silent on cache until the session has sent enough to judge', () => {
    const aggregator = new LogMetricsAggregator();
    // A near-zero hit rate, but on far too little traffic to mean anything.
    turn(aggregator, { input: 900, total: 900, cacheRead: 1 });

    expect(ids(aggregator)).not.toContain('low-cache-hit');
  });

  it('does not flag a session that is caching effectively', () => {
    const aggregator = new LogMetricsAggregator();
    turn(aggregator, { input: 100_000, total: 900_000, cacheRead: 800_000, cacheWrite: 100_000 });

    expect(ids(aggregator)).not.toContain('low-cache-hit');
  });

  it('names the tool whose turns run far above the median', () => {
    const aggregator = new LogMetricsAggregator();
    tokenSamples(aggregator, 'read', 10_000, 4);
    tokenSamples(aggregator, 'edit', 12_000, 4);
    tokenSamples(aggregator, 'grep', 400_000, 4);
    toolCalls(aggregator, 'grep', 4);

    const expensive = deriveFindings(aggregator.snapshot()).find((finding) => finding.id === 'expensive-tool');

    expect(expensive?.subject).toBe('grep');
    expect(expensive?.detail).toContain('× median');
    expect(expensive?.action).toBe('narrow what it pulls in');
  });

  it('ignores an expensive tool that has only been sampled once or twice', () => {
    const aggregator = new LogMetricsAggregator();
    tokenSamples(aggregator, 'read', 10_000, 4);
    // Two samples is not a distribution, so no claim is made about it.
    tokenSamples(aggregator, 'subagent', 900_000, 2);

    expect(ids(aggregator)).not.toContain('expensive-tool');
  });

  it('raises a failing tool as critical, ahead of every efficiency finding', () => {
    const aggregator = new LogMetricsAggregator();
    turn(aggregator, { input: 900_000, total: 900_000, cacheRead: 1000, cacheWrite: 500_000 });
    toolCalls(aggregator, 'edit', 8, 4);

    const findings = deriveFindings(aggregator.snapshot());

    expect(findings[0]?.id).toBe('failing-tool:edit');
    expect(findings[0]?.severity).toBe('critical');
    expect(findings[0]?.detail).toBe('4 of 8 failed');
  });

  it('ignores a single failure in a tool that mostly works', () => {
    const aggregator = new LogMetricsAggregator();
    toolCalls(aggregator, 'bash', 20, 1);

    expect(ids(aggregator)).not.toContain('failing-tool:bash');
  });

  it('needs more than a couple of calls before calling a tool unreliable', () => {
    const aggregator = new LogMetricsAggregator();
    // 1 of 2 failed is a 50% rate, but on a sample that proves nothing.
    toolCalls(aggregator, 'bash', 2, 1);

    expect(ids(aggregator)).not.toContain('failing-tool:bash');
  });

  it('counts turns the user paid for and had to redo', () => {
    const aggregator = new LogMetricsAggregator();
    aggregator.record(TURN_FAILED, { outcome: 'aborted' });
    aggregator.record(TURN_FAILED, { outcome: 'error' });

    const redone = deriveFindings(aggregator.snapshot()).find((finding) => finding.id === 'redone-turns');

    expect(redone?.severity).toBe('critical');
    expect(redone?.detail).toBe('1 aborted · 1 failed');
    expect(redone?.action).toBe('paid for, then thrown away');
  });

  it('separates rate limiting from a provider outage, because the fix differs', () => {
    const limited = new LogMetricsAggregator();
    limited.record(API_ERROR, { 'http.response.status_code': 429 });
    const down = new LogMetricsAggregator();
    down.record(API_ERROR, { 'http.response.status_code': 529 });

    const limitedFinding = deriveFindings(limited.snapshot()).find((finding) => finding.id.startsWith('provider:'));
    const downFinding = deriveFindings(down.snapshot()).find((finding) => finding.id.startsWith('provider:'));

    expect(limitedFinding?.detail).toBe('1 × rate limited');
    expect(limitedFinding?.action).toBe('back off or drop concurrency');
    expect(downFinding?.detail).toBe('1 × unavailable');
    expect(downFinding?.action).toBe('retry or switch provider');
  });

  it('leaves a plain 4xx to the error panel rather than blaming the provider', () => {
    const aggregator = new LogMetricsAggregator();
    aggregator.record(API_ERROR, { 'http.response.status_code': 400 });

    expect(ids(aggregator).some((id) => id.startsWith('provider:'))).toBe(false);
  });

  it('flags context that is carried rather than scoped', () => {
    const aggregator = new LogMetricsAggregator();
    for (let index = 0; index < 4; index++) turn(aggregator, { input: 200_000, total: 210_000 });

    const context = deriveFindings(aggregator.snapshot()).find((finding) => finding.id === 'heavy-context');

    expect(context?.detail).toBe('200k input tok/turn');
    expect(context?.action).toBe('compact or split the task');
  });

  it('flags tool churn only once there are enough turns to average over', () => {
    const busy = new LogMetricsAggregator();
    for (let index = 0; index < 4; index++) turn(busy, { input: 1000, total: 1000 });
    toolCalls(busy, 'grep', 40);

    const early = new LogMetricsAggregator();
    turn(early, { input: 1000, total: 1000 });
    toolCalls(early, 'grep', 40);

    expect(ids(busy)).toContain('tool-churn');
    expect(ids(early)).not.toContain('tool-churn');
  });

  it('orders critical findings above warnings above notes', () => {
    const aggregator = new LogMetricsAggregator();
    for (let index = 0; index < 4; index++) turn(aggregator, { input: 200_000, total: 200_000, cacheRead: 1000 });
    toolCalls(aggregator, 'edit', 8, 4);
    toolCalls(aggregator, 'grep', 40);

    const severities = deriveFindings(aggregator.snapshot()).map((finding) => finding.severity);

    expect(severities).toEqual(
      [...severities].sort((left, right) => (left === right ? 0 : left === 'critical' ? -1 : 1)),
    );
    expect(severities[0]).toBe('critical');
    expect(severities.at(-1)).toBe('info');
  });
});
