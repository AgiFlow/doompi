import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogMetricsAggregator, MAX_RETAINED_STATE_PER_TOOL } from '../src/services/metrics.ts';

/**
 * The aggregator consumes the same log records the telemetry extension already
 * emits, keyed by record name. That is why every fixture below is an
 * `(name, attributes)` pair rather than a Pi event: no new instrumentation is
 * added for metrics, so the aggregator can only ever see what the sink sees.
 */
const TOOL_RESULT = 'pi.tool_result';
const TOOL_CALL = 'pi.tool_call';
const TURN_FINISHED = 'pi.turn.finished';
const USER_PROMPT = 'pi.user_prompt';
const API_ERROR = 'pi.api_error';

function toolResult(
  toolName: string,
  overrides: { durationMs?: number; isError?: boolean; callId?: string } = {},
): [string, Record<string, unknown>] {
  return [
    TOOL_RESULT,
    {
      'tool.name': toolName,
      'tool.call.id': overrides.callId ?? `${toolName}-1`,
      'tool.result.error': overrides.isError ?? false,
      ...(overrides.durationMs === undefined ? {} : { 'tool.duration_ms': overrides.durationMs }),
    },
  ];
}

function turnFinished(usage: { input: number; output: number; total: number; cost: number }) {
  return [
    TURN_FINISHED,
    {
      'gen_ai.usage.input_tokens': usage.input,
      'gen_ai.usage.output_tokens': usage.output,
      'gen_ai.usage.total_tokens': usage.total,
      'gen_ai.usage.cost': usage.cost,
    },
  ] as [string, Record<string, unknown>];
}

function feed(aggregator: LogMetricsAggregator, records: Array<[string, Record<string, unknown>]>): void {
  for (const [name, attributes] of records) aggregator.record(name, attributes);
}

describe('LogMetricsAggregator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts events, tool calls, and failed tool calls from tool results', () => {
    const aggregator = new LogMetricsAggregator();

    feed(aggregator, [
      toolResult('bash', { durationMs: 10, callId: 'a' }),
      toolResult('bash', { durationMs: 20, callId: 'b' }),
      toolResult('read', { durationMs: 5, isError: true, callId: 'c' }),
    ]);
    const snapshot = aggregator.snapshot();

    expect(snapshot.events).toBe(3);
    expect(snapshot.toolCalls).toBe(3);
    expect(snapshot.failedToolCalls).toBe(1);
  });

  it('counts only api errors toward the session error total', () => {
    const aggregator = new LogMetricsAggregator();

    feed(aggregator, [
      toolResult('bash', { durationMs: 10, isError: true }),
      [API_ERROR, { 'http.response.status_code': 529 }],
      [API_ERROR, { 'http.response.status_code': 429 }],
    ]);
    const snapshot = aggregator.snapshot();

    // A failed tool result is a tool failure, not a sink error: the mockup
    // reports them in separate cells (ERRORS vs "118 failed").
    expect(snapshot.errors).toBe(2);
    expect(snapshot.failedToolCalls).toBe(1);
  });

  it('accumulates token and cost totals from turn usage', () => {
    const aggregator = new LogMetricsAggregator();

    feed(aggregator, [
      turnFinished({ input: 100, output: 20, total: 120, cost: 0.5 }),
      turnFinished({ input: 300, output: 80, total: 380, cost: 1.25 }),
    ]);
    const snapshot = aggregator.snapshot();

    expect(snapshot.tokens).toMatchObject({ input: 400, output: 100, total: 500 });
    expect(snapshot.cost).toBeCloseTo(1.75, 5);
  });

  it('ignores a turn that carries no usage', () => {
    const aggregator = new LogMetricsAggregator();

    // usageAttributes() returns nothing for a non-assistant turn, so the record
    // reaches the aggregator with only its context attributes.
    feed(aggregator, [[TURN_FINISHED, { 'pi.turn.index': 1, 'pi.tool_result.count': 0 }]]);
    const snapshot = aggregator.snapshot();

    expect(snapshot.tokens).toMatchObject({ input: 0, output: 0, total: 0 });
    expect(snapshot.cost).toBe(0);
    expect(snapshot.events).toBe(1);
  });

  it('computes p95 duration per tool without pooling tools together', () => {
    const aggregator = new LogMetricsAggregator();

    for (let ms = 1; ms <= 100; ms++) feed(aggregator, [toolResult('bash', { durationMs: ms, callId: `bash-${ms}` })]);
    for (let ms = 1; ms <= 100; ms++)
      feed(aggregator, [toolResult('read', { durationMs: ms * 10, callId: `read-${ms}` })]);
    const byTool = new Map(aggregator.snapshot().toolLatency.map((entry) => [entry.name, entry]));

    // A tolerance band, not an exact millisecond: a bounded histogram or a
    // capped reservoir both land near the true p95 (95ms / 950ms) but neither
    // reproduces it exactly.
    expect(byTool.get('bash')?.p95Ms).toBeGreaterThanOrEqual(85);
    expect(byTool.get('bash')?.p95Ms).toBeLessThanOrEqual(110);
    expect(byTool.get('read')?.p95Ms).toBeGreaterThanOrEqual(850);
    expect(byTool.get('read')?.p95Ms).toBeLessThanOrEqual(1100);
  });

  it('sorts the tool latency breakdown slowest first', () => {
    const aggregator = new LogMetricsAggregator();

    feed(aggregator, [
      toolResult('read', { durationMs: 20, callId: 'r' }),
      toolResult('subagent', { durationMs: 9000, callId: 's' }),
      toolResult('bash', { durationMs: 400, callId: 'b' }),
    ]);

    expect(aggregator.snapshot().toolLatency.map((entry) => entry.name)).toEqual(['subagent', 'bash', 'read']);
  });

  it('bounds retained latency state for a long session', () => {
    const aggregator = new LogMetricsAggregator();
    const sampleCount = MAX_RETAINED_STATE_PER_TOOL * 10;

    for (let index = 0; index < sampleCount; index++) {
      // A uniform 1..1000ms spread so the true p95 stays a known 950ms
      // regardless of how many samples the aggregator chose to drop.
      feed(aggregator, [toolResult('bash', { durationMs: (index % 1000) + 1, callId: `bash-${index}` })]);
    }
    const bash = aggregator.snapshot().toolLatency.find((entry) => entry.name === 'bash');

    expect(bash?.calls).toBe(sampleCount);
    expect(bash?.retainedStateSize).toBeLessThanOrEqual(MAX_RETAINED_STATE_PER_TOOL);
    expect(bash?.p95Ms).toBeGreaterThanOrEqual(850);
    expect(bash?.p95Ms).toBeLessThanOrEqual(1100);
  });

  it('reports a tool call with no completed duration as having no latency sample', () => {
    const aggregator = new LogMetricsAggregator();

    // `tool.duration_ms` is omitted when the start was never seen
    // (`startedAt === undefined` in the extension), so the call still counts
    // but contributes no sample.
    feed(aggregator, [toolResult('grep', { callId: 'g' })]);
    const grep = aggregator.snapshot().toolLatency.find((entry) => entry.name === 'grep');

    expect(grep?.calls).toBe(1);
    expect(grep?.p95Ms).toBeUndefined();
  });

  it('counts event volume by log record name, most frequent first', () => {
    const aggregator = new LogMetricsAggregator();

    feed(aggregator, [
      toolResult('bash', { durationMs: 1, callId: '1' }),
      toolResult('bash', { durationMs: 1, callId: '2' }),
      [TOOL_CALL, { 'tool.name': 'bash' }],
      [USER_PROMPT, { 'pi.user_message.length': 12 }],
    ]);

    expect(aggregator.snapshot().eventVolume).toEqual([
      { name: TOOL_RESULT, count: 2 },
      { name: TOOL_CALL, count: 1 },
      { name: USER_PROMPT, count: 1 },
    ]);
  });

  it('aggregates sanitized package events, failures, and operation durations', () => {
    const aggregator = new LogMetricsAggregator();

    feed(aggregator, [
      [
        'doom_team.child_started',
        { 'telemetry.package': '@agimon-ai/doompi-team', duration_ms: 10, outcome: 'completed' },
      ],
      [
        'doom_team.child_failed',
        {
          'telemetry.package': '@agimon-ai/doompi-team',
          duration_ms: 100,
          outcome: 'failed',
          'error.type': 'Error',
          'error.code': 'E_CHILD',
          'error.message': 'private failure',
        },
      ],
      ['doom_runner.process_finished', { 'telemetry.package': '/private/path', duration_ms: 20, outcome: 'completed' }],
      [API_ERROR, { 'telemetry.package': '@agimon-ai/doompi-log', 'http.response.status_code': 503 }],
      toolResult('bash', { isError: true }),
    ]);

    const snapshot = aggregator.snapshot();
    expect(snapshot.packageEvents).toEqual([
      { name: '@agimon-ai/doompi-team', count: 2 },
      { name: '@agimon-ai/doompi-log', count: 1 },
    ]);
    expect(snapshot.sanitizedFailures).toBe(3);
    expect(snapshot.operationDuration.map((entry) => entry.name)).toEqual([
      'doom_team.child_failed',
      'doom_runner.process_finished',
      'doom_team.child_started',
    ]);
    expect(snapshot.recentErrors[0]?.message).toContain('bash');
    expect(JSON.stringify(snapshot.recentErrors)).not.toContain('private failure');
  });

  it('keeps a bounded, newest-first list of recent errors', () => {
    let clock = 0;
    const aggregator = new LogMetricsAggregator({ now: () => ++clock, maxRecentErrors: 2 });

    feed(aggregator, [
      [API_ERROR, { 'http.response.status_code': 529 }],
      [API_ERROR, { 'http.response.status_code': 429 }],
      toolResult('bash', { durationMs: 5, isError: true, callId: 'x' }),
    ]);
    const { recentErrors } = aggregator.snapshot();

    expect(recentErrors).toHaveLength(2);
    expect(recentErrors[0]).toMatchObject({ event: 'tool_result', at: 3 });
    // Redaction is on by default, so the tool's own output is never available:
    // the tool name is the only detail the entry can carry.
    expect(recentErrors[0]?.message).toContain('bash');
    expect(recentErrors[1]).toMatchObject({ event: 'api_error', code: '429' });
  });
});
