import { describe, expect, it } from 'vitest';

import { isMetricsDimension, isMetricsPeriod, isMetricsUnavailable, METRICS_DIMENSIONS } from '../src/types/webMetrics';

/**
 * The vocabulary both halves share. These guards are the gate the route uses
 * to refuse a dimension the sink has data for but DoomPi never emits, so they
 * are worth pinning rather than assuming.
 */

describe('the metrics wire vocabulary', () => {
  it('offers only the dimensions DoomPi actually emits', () => {
    // The sink also groups by workflow-run, workflow-name, job and step. No
    // package emits those attributes, so offering them would draw empty charts.
    expect([...METRICS_DIMENSIONS]).toEqual(['session', 'agent', 'model', 'provider']);
    expect(isMetricsDimension('workflow-run')).toBe(false);
    expect(isMetricsDimension('model')).toBe(true);
  });

  it('recognises the periods the sink accepts', () => {
    expect(isMetricsPeriod('day')).toBe(true);
    expect(isMetricsPeriod('decade')).toBe(false);
  });

  // The URLs this vocabulary used to build now come from the generated client,
  // and are pinned as literals in tests/unit/urlParity.test.ts.

  it('tells an unavailable body from a report', () => {
    expect(isMetricsUnavailable({ unavailable: 'no-sink', detail: '' })).toBe(true);
    expect(
      isMetricsUnavailable({
        generatedAt: '',
        dimension: 'model',
        period: 'week',
        bucketUnit: 'day',
        totals: {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          groupCount: 0,
          failedGroups: 0,
          issueCount: 0,
        },
        timeline: [],
        groups: [],
        tools: [],
      }),
    ).toBe(false);
  });
});
