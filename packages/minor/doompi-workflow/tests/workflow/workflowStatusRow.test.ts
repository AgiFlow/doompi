import { describe, expect, it } from 'vitest';
import { humanizeDuration, stepReportLines } from '../../src/tui/workflow/workflowStatusRow';

describe('humanizeDuration', () => {
  it('scales the unit to the magnitude', () => {
    expect(humanizeDuration(420)).toBe('420ms');
    expect(humanizeDuration(12_000)).toBe('12s');
    expect(humanizeDuration(192_000)).toBe('3m12s');
    expect(humanizeDuration(3_840_000)).toBe('1h04m');
  });

  it('says so rather than guessing when the span makes no sense', () => {
    expect(humanizeDuration(Number.NaN)).toBe('?');
    expect(humanizeDuration(-1)).toBe('?');
  });
});

describe('stepReportLines', () => {
  const started = {
    type: 'step' as const,
    status: 'running' as const,
    job: 'verify-dispatch',
    step: 'Record dispatch evidence',
    at: '2026-01-01T00:00:00.000Z',
  };
  const finished = {
    type: 'step' as const,
    status: 'completed' as const,
    job: 'verify-dispatch',
    step: 'Record dispatch evidence',
    at: '2026-01-01T00:00:12.000Z',
  };

  it('reports a start and a finish with how long it took', () => {
    const reports = stepReportLines('ixx-324', [started, finished]);

    expect(reports).toEqual([
      {
        job: 'verify-dispatch',
        key: 'started:ixx-324/verify-dispatch/Record dispatch evidence:2026-01-01T00:00:00.000Z',
        status: 'STARTED',
        step: 'Record dispatch evidence',
      },
      {
        duration: '12s',
        job: 'verify-dispatch',
        key: 'FINISHED:ixx-324/verify-dispatch/Record dispatch evidence:2026-01-01T00:00:12.000Z',
        status: 'FINISHED',
        step: 'Record dispatch evidence',
      },
    ]);
  });

  // Calling a failed step FINISHED buries the one outcome worth reading.
  it('names a failure as a failure', () => {
    const reports = stepReportLines('ixx-324', [started, { ...finished, status: 'failed' as const }]);

    expect(reports[1]).toEqual(
      expect.objectContaining({
        duration: '12s',
        job: 'verify-dispatch',
        status: 'FAILED',
        step: 'Record dispatch evidence',
      }),
    );
  });

  // The caller re-reads the whole append-only log on every poll, so the keys are
  // what stop the same transition being reported once per tick.
  it('keys every transition uniquely so repeated polling reports each once', () => {
    const reports = stepReportLines('ixx-324', [started, finished]);
    const keys = reports.map((report) => report.key);

    expect(new Set(keys).size).toBe(keys.length);
    // Stable across reads of the same log.
    expect(stepReportLines('ixx-324', [started, finished]).map((r) => r.key)).toEqual(keys);
  });

  it('truncates a step name long enough to swamp the line', () => {
    const long = 'A'.repeat(80);
    const reports = stepReportLines('run', [{ ...started, step: long }]);

    expect(reports[0].step).toContain('…');
    expect(reports[0].step.length).toBeLessThan(long.length);
  });

  it('still reports a finish whose start it never saw', () => {
    const reports = stepReportLines('ixx-324', [finished]);

    expect(reports[0]).toEqual(
      expect.objectContaining({
        duration: '?',
        job: 'verify-dispatch',
        status: 'FINISHED',
        step: 'Record dispatch evidence',
      }),
    );
  });

  it('ignores job-level events, which are not steps', () => {
    expect(stepReportLines('r', [{ type: 'job', status: 'running', job: 'build', at: started.at }])).toEqual([]);
  });
});
