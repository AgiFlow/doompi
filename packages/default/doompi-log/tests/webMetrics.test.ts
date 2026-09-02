import { describe, expect, it } from 'vitest';
import {
  isMetricsDimension,
  isMetricsPeriod,
  isMetricsUnavailable,
  issuesUrl,
  METRICS_DIMENSIONS,
  metricsUrl,
} from '../src/types/webMetrics.ts';

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

  it('builds a metrics url, adding focus only when there is one', () => {
    expect(metricsUrl('model', 'week')).toBe('/api/plugin/log/metrics?dimension=model&period=week');
    expect(metricsUrl('model', 'week', '')).toBe('/api/plugin/log/metrics?dimension=model&period=week');
    expect(metricsUrl('model', 'week', 'a b')).toContain('focus=a+b');
  });

  it('builds an issues url with no query when unfocused', () => {
    expect(issuesUrl()).toBe('/api/plugin/log/issues');
    expect(issuesUrl('')).toBe('/api/plugin/log/issues');
    expect(issuesUrl('id_abc')).toBe('/api/plugin/log/issues?focus=id_abc');
  });

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
