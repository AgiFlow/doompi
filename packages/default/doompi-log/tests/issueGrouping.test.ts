import { describe, expect, it } from 'vitest';
import { groupIssues, groupingKey } from '../src/types/issueGrouping.ts';
import type { IssueSample } from '../src/types/webMetrics.ts';

/**
 * The ranking is the whole point of the issues view, so it is tested as a
 * function. Two behaviours matter: the sink repeats fingerprints and those
 * repeats must merge, and the order must be by how often a problem happened
 * rather than by when it last did.
 */

function sample(overrides: Partial<IssueSample> = {}): IssueSample {
  return {
    fingerprint: 'fp',
    occurrenceCount: 1,
    category: 'log_error',
    timestamp: '2026-09-02T01:00:00.000Z',
    level: 'warn',
    message: 'msg',
    detail: 'detail',
    tool: null,
    errorType: null,
    agentName: null,
    model: null,
    statusCode: null,
    ...overrides,
  };
}

describe('grouping issues', () => {
  it('merges repeats of one fingerprint and sums their occurrences', () => {
    // The sink emitted 'tool_failure|pi|bash||pi.tool_result' three times.
    // Left unmerged, one problem appears three times at a third of its weight.
    const groups = groupIssues([
      sample({ fingerprint: 'bash', occurrenceCount: 4, detail: 'pi.tool_result' }),
      sample({ fingerprint: 'bash', occurrenceCount: 4, detail: 'pi.tool_result' }),
      sample({ fingerprint: 'bash', occurrenceCount: 2, detail: 'pi.tool_result' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.occurrences).toBe(10);
    expect(groups[0]?.members).toHaveLength(3);
  });

  it('ranks by occurrences, not by recency', () => {
    const groups = groupIssues([
      sample({ fingerprint: 'rare', detail: 'rare', occurrenceCount: 1, timestamp: '2026-09-02T09:00:00.000Z' }),
      sample({ fingerprint: 'common', detail: 'common', occurrenceCount: 20, timestamp: '2026-09-01T01:00:00.000Z' }),
    ]);

    expect(groups.map((group) => group.detail)).toEqual(['common', 'rare']);
  });

  it('keeps problems apart when a shared fingerprint hides different details', () => {
    const groups = groupIssues([
      sample({ fingerprint: 'shared', detail: 'missing binary a' }),
      sample({ fingerprint: 'shared', detail: 'missing binary b' }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it('falls back to category and message when the sink sent no fingerprint', () => {
    expect(groupingKey(sample({ fingerprint: '', category: 'api_error', message: 'boom', detail: 'd' }))).toBe(
      'api_error|boom|d',
    );
  });

  it('carries the newest timestamp and fills identifying fields from any member', () => {
    const groups = groupIssues([
      sample({ occurrenceCount: 1, timestamp: '2026-09-01T00:00:00.000Z', agentName: null, tool: 'bash' }),
      sample({ occurrenceCount: 1, timestamp: '2026-09-03T00:00:00.000Z', agentName: 'reviewer', tool: null }),
    ]);

    expect(groups[0]?.lastSeen).toBe('2026-09-03T00:00:00.000Z');
    // One incident missing the agent must not blank it for the merged row.
    expect(groups[0]?.agentName).toBe('reviewer');
    expect(groups[0]?.tool).toBe('bash');
  });

  it('is empty for no issues', () => {
    expect(groupIssues([])).toEqual([]);
  });
});
