import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentDiagnosticsTool, readAgentDiagnostics } from '../../src/services/agentDiagnostics';
import * as metricsSource from '../../src/services/metricsSource';
import type { MetricsSource } from '../../src/types/metricsSource';

afterEach(() => {
  vi.restoreAllMocks();
});

function report() {
  return {
    groupBy: 'session',
    period: 'day',
    filters: { sessionId: 'current' },
    totals: {
      totalRecords: 4,
      issueCount: 1,
      usageEventCount: 2,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 50,
      reasoningOutputTokens: 10,
      tokenCoveragePercent: 50,
    },
    groups: [{ sessionId: 'current', byCategory: { tool_failure: 1, 'private-error-text': 999 } }],
    tools: {
      returnedTools: 1,
      rows: [
        {
          toolName: 'read',
          invocationCount: 2,
          toolCallTurn: { samples: 1, avgTotalTokens: 120, p90TotalTokens: 120 },
        },
      ],
    },
    private: 'secret credential and raw prompt',
  };
}

function source(value: unknown = report()) {
  const query = vi.fn<MetricsSource['query']>().mockResolvedValue(value as Awaited<ReturnType<MetricsSource['query']>>);
  return { query, lastTransport: () => 'worker' as const };
}

describe('scoped agent diagnostics', () => {
  it('asks only for the current session and returns a bounded safe projection', async () => {
    const metrics = source();
    const result = await readAgentDiagnostics(metrics, 'current', {}, new AbortController().signal);
    expect(metrics.query).toHaveBeenCalledWith({
      groupBy: 'session',
      period: 'day',
      limit: 1,
      toolLimit: 10,
      filter: { sessionId: 'current' },
    });
    expect(result).toMatchObject({
      evidence: 'available',
      capturedIssues: 1,
      usage: { totalTokens: 120, tokenCoveragePercent: 50 },
      tools: [{ name: 'read', sampledTurns: 1 }],
      captureCompleteness: 'not-reported',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('private-error-text');
  });

  it.each(['filter', 'group', 'shape', 'period'] as const)(
    'refuses evidence when %s does not establish the requested scope',
    async (mismatch) => {
      const value = report();
      if (mismatch === 'filter') value.filters.sessionId = 'other';
      if (mismatch === 'group') value.groups[0]!.sessionId = 'other';
      if (mismatch === 'shape') value.totals.totalTokens = Number.NaN;
      if (mismatch === 'period') value.period = 'week';
      const result = await readAgentDiagnostics(source(value), 'current', {}, new AbortController().signal);
      expect(result).toEqual({
        evidence: 'unavailable',
        code: 'METRICS_SCOPE_NOT_CONFIRMED',
        scope: 'current-session',
        period: 'day',
      });
    },
  );

  it('distinguishes empty and unavailable data rather than reporting either as health', async () => {
    const value = report();
    value.totals = {
      totalRecords: 0,
      issueCount: 0,
      usageEventCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      tokenCoveragePercent: 0,
    };
    value.groups = [];
    value.tools = { returnedTools: 0, rows: [] };
    const empty = await readAgentDiagnostics(source(value), 'current', {}, new AbortController().signal);
    expect(empty).toMatchObject({ evidence: 'empty', capturedRecords: 0 });
    expect(JSON.stringify(empty)).toContain('not proof of a healthy run');
    const unavailable = source();
    unavailable.query.mockRejectedValue(new Error('secret database path'));
    expect(await readAgentDiagnostics(unavailable, 'current', {}, new AbortController().signal)).toEqual({
      evidence: 'unavailable',
      code: 'METRICS_UNAVAILABLE',
      scope: 'current-session',
      period: 'day',
    });
  });

  it('reports row limits and supports a bounded older window', async () => {
    const value = report();
    value.period = 'week';
    const result = await readAgentDiagnostics(
      source(value),
      'current',
      { period: 'week', toolLimit: 1 },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ period: 'week', toolRowLimit: 1, limitReached: true });
  });

  it('cancels pending reads and never returns a late result after revocation', async () => {
    const metrics = source();
    let resolve!: (value: Awaited<ReturnType<MetricsSource['query']>>) => void;
    metrics.query.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const controller = new AbortController();
    const reading = readAgentDiagnostics(metrics, 'current', {}, controller.signal);
    controller.abort(new Error('revoked'));
    await expect(reading).rejects.toThrow('revoked');
    resolve(report() as unknown as Awaited<ReturnType<MetricsSource['query']>>);
    await expect(readAgentDiagnostics(metrics, 'current', {}, controller.signal)).rejects.toThrow('revoked');
  });
  it.each([false, true])(
    'closes its scoped reader after execution, including revoked calls (revoked=%s)',
    async (revoked) => {
      const controller = new AbortController();
      const metrics = { ...source(), close: vi.fn(async () => {}) };
      if (revoked)
        metrics.query.mockImplementation(async () => {
          controller.abort(new Error('Help deactivated'));
          return report() as unknown as Awaited<ReturnType<MetricsSource['query']>>;
        });
      const factory = vi.spyOn(metricsSource, 'createMetricsSource').mockReturnValue(metrics);
      const authorize = vi.fn(() => {
        controller.signal.throwIfAborted();
        return controller.signal;
      });
      const tool = createAgentDiagnosticsTool(
        () => ({ sessionId: 'current', options: { cwd: '/fixture' } }),
        authorize,
      );
      const execution = tool.execute({}, { cwd: '/fixture', toolCallId: 'diagnostic', notify() {}, update() {} });
      if (revoked) await expect(execution).rejects.toThrow('Help deactivated');
      else {
        const result = await execution;
        expect(result.details).toMatchObject({ evidence: 'available', capturedRecords: 4 });
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(authorize).toHaveBeenCalledTimes(2);
      }
      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/fixture', packageName: '@agimon-ai/doompi-log' }),
      );
      expect(metrics.close).toHaveBeenCalledOnce();
    },
  );

  it('rejects absent sessions before opening any telemetry reader', async () => {
    const factory = vi.spyOn(metricsSource, 'createMetricsSource');
    const tool = createAgentDiagnosticsTool(
      () => ({ sessionId: '', options: {} }),
      () => new AbortController().signal,
    );
    await expect(
      tool.execute({}, { cwd: '/fixture', toolCallId: 'missing', notify() {}, update() {} }),
    ).rejects.toThrow('active session');
    expect(factory).not.toHaveBeenCalled();
  });
});
