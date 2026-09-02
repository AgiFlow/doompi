import { describe, expect, it, vi } from 'vitest';
import { createIssuesSource } from '../src/adapters/node/issuesSource.ts';

/**
 * The CLI's output is a foreign process's JSON, so the narrowing matters more
 * than the happy path: a sink one version off must degrade, not throw.
 */

describe('the issues source', () => {
  it('narrows the sink report onto the shape the page reads', async () => {
    const cliRunner = vi.fn().mockResolvedValue({
      totalIssues: 69,
      uniqueIncidents: 27,
      byCategory: { tool_failure: 33, log_error: 36 },
      byTool: { bash: 25 },
      byErrorType: { ENOENT: 20 },
      issues: [
        {
          fingerprint: 'tool_failure|pi|bash||pi.tool_result',
          occurrenceCount: 4,
          category: 'tool_failure',
          timestamp: '2026-09-02T01:05:07.100Z',
          level: 'warn',
          message: 'pi.tool_result',
          detail: 'command not found',
          tool: 'bash',
          errorType: 'ENOENT',
          agentName: 'pi',
          model: null,
          statusCode: null,
        },
      ],
    });

    const report = await createIssuesSource({ cliRunner }).query({ limit: 25 });

    expect(report.totalIssues).toBe(69);
    expect(report.byTool).toEqual({ bash: 25 });
    expect(report.samples).toEqual([
      {
        fingerprint: 'tool_failure|pi|bash||pi.tool_result',
        // The number a reader acts on: this exact problem happened four times.
        occurrenceCount: 4,
        category: 'tool_failure',
        timestamp: '2026-09-02T01:05:07.100Z',
        level: 'warn',
        message: 'pi.tool_result',
        detail: 'command not found',
        tool: 'bash',
        errorType: 'ENOENT',
        agentName: 'pi',
        model: null,
        statusCode: null,
      },
    ]);
  });

  it('treats a sink that sent no occurrence count as one occurrence', async () => {
    const cliRunner = vi.fn().mockResolvedValue({ issues: [{ category: 'log_error', message: 'boom' }] });

    const report = await createIssuesSource({ cliRunner }).query({ limit: 5 });

    expect(report.samples[0]?.occurrenceCount).toBe(1);
    // A sink leaves detail null when the message already is the detail.
    expect(report.samples[0]?.detail).toBe('boom');
  });

  it('degrades rather than throwing when a sink omits fields', async () => {
    const cliRunner = vi.fn().mockResolvedValue({ totalIssues: 3 });

    const report = await createIssuesSource({ cliRunner }).query({ limit: 5 });

    expect(report).toEqual({
      totalIssues: 3,
      uniqueIncidents: 0,
      byCategory: {},
      byTool: {},
      byErrorType: {},
      samples: [],
    });
  });

  it('drops count entries that are not numbers', async () => {
    const cliRunner = vi.fn().mockResolvedValue({ byTool: { bash: 4, broken: 'lots' } });

    expect((await createIssuesSource({ cliRunner }).query({ limit: 5 })).byTool).toEqual({ bash: 4 });
  });

  it('refuses output that is not a report at all', async () => {
    const cliRunner = vi.fn().mockResolvedValue('not a report');

    await expect(createIssuesSource({ cliRunner }).query({ limit: 5 })).rejects.toThrow(/cannot read/);
  });

  it('forwards the sample limit and the session filter to the CLI', async () => {
    const cliRunner = vi.fn().mockResolvedValue({});

    await createIssuesSource({ cliRunner }).query({ limit: 25, sessionId: 'id_abc' });

    expect(cliRunner).toHaveBeenCalledWith({ limit: 25, sessionId: 'id_abc' });
  });
});
