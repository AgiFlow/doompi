import { describe, expect, it } from 'vitest';

import { performanceEntries, PERFORMANCE_MARKERS } from '../support/performanceFixture';

describe('performanceEntries', () => {
  it('keeps both logical workloads repeatable and their IDs distinct', () => {
    const large = performanceEntries('large');
    const small = performanceEntries('small');
    expect(large).toEqual(performanceEntries('large'));
    expect(small).toEqual(performanceEntries('small'));
    const ids = [...large, ...small].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(large).toHaveLength(290);
    expect(small).toHaveLength(4);
  });

  it('keeps the large workload inside the protocol fixture window with tools and a final marker', () => {
    const entries = performanceEntries('large');
    expect(entries.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(entries.at(-1))).toContain(PERFORMANCE_MARKERS.large);
    expect(JSON.stringify(entries)).toContain('toolResult');
    expect(JSON.stringify(performanceEntries('small').at(-1))).toContain(PERFORMANCE_MARKERS.small);
  });
});
