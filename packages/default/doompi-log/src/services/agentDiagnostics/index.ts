import { DOOM_HELP_WHEN as HELP_WHEN } from '@agimon-ai/doompi-core/help';
import { defineTool } from '@agimon-ai/doompi-core/piExtension';
import type { Static } from 'typebox';
import { Check } from 'typebox/value';

import {
  AGENT_DIAGNOSTIC_TIMEOUT_MS,
  AGENT_DIAGNOSTIC_TOOL_LIMIT,
  AGENT_ISSUE_CATEGORIES,
  DIAGNOSE_AGENT_DESCRIPTION,
  DIAGNOSE_AGENT_NAME,
} from '../../constants/diagnostics';
import { PACKAGE_NAME, SERVICE_NAME } from '../../constants/telemetry';
import { agentDiagnosticParameters, scopedMetricsSchema } from '../../schemas/agentDiagnostics';
import type { MetricsSource } from '../../types/metricsSource';
import { createMetricsSource, type MetricsSourceOptions } from '../metricsSource';

export async function readAgentDiagnostics(
  source: MetricsSource,
  sessionId: string,
  input: Static<typeof agentDiagnosticParameters>,
  signal: AbortSignal,
) {
  const period = input.period ?? 'day';
  const limit = input.toolLimit ?? AGENT_DIAGNOSTIC_TOOL_LIMIT;
  signal.throwIfAborted();
  let onAbort = () => {};
  try {
    const report: unknown = await Promise.race([
      source.query({ groupBy: 'session', period, limit: 1, toolLimit: limit, filter: { sessionId } }),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
    signal.throwIfAborted();
    if (
      !Check(scopedMetricsSchema, report) ||
      report.filters.sessionId !== sessionId ||
      report.period !== period ||
      report.groups.some((group) => group.sessionId !== sessionId)
    ) {
      return { evidence: 'unavailable', code: 'METRICS_SCOPE_NOT_CONFIRMED', scope: 'current-session', period };
    }
    const totals = report.totals;
    return {
      scope: 'current-session',
      period,
      evidence: totals.totalRecords === 0 ? 'empty' : 'available',
      transport: source.lastTransport(),
      capturedRecords: totals.totalRecords,
      capturedIssues: totals.issueCount,
      issuesByCategory: Object.fromEntries(
        AGENT_ISSUE_CATEGORIES.map((category) => [category, report.groups[0]?.byCategory[category] ?? 0]),
      ),
      usage: {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        totalTokens: totals.totalTokens,
        cachedInputTokens: totals.cachedInputTokens,
        reasoningOutputTokens: totals.reasoningOutputTokens,
        usageEventCount: totals.usageEventCount,
        tokenCoveragePercent: totals.tokenCoveragePercent,
      },
      tools: report.tools.rows.slice(0, limit).map((tool) => ({
        name: tool.toolName,
        invocations: tool.invocationCount,
        sampledTurns: tool.toolCallTurn.samples,
        averageTurnTokens: tool.toolCallTurn.avgTotalTokens,
        p90TurnTokens: tool.toolCallTurn.p90TotalTokens,
      })),
      toolRowLimit: limit,
      limitReached: report.tools.rows.length >= limit,
      captureCompleteness: 'not-reported',
      limitations:
        'Only captured records in this window are represented. Empty data is not proof of a healthy run. Token coverage is not event-capture coverage; per-tool token samples describe the containing turn, not exclusive tool cost. Raw prompts, error messages, tool arguments and traces are omitted. Use doompi-debug-agent for deeper authorized investigation.',
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return { evidence: 'unavailable', code: 'METRICS_UNAVAILABLE', scope: 'current-session', period };
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function createAgentDiagnosticsTool(
  readScope: () => { sessionId: string; options: MetricsSourceOptions },
  authorize: (signal?: AbortSignal) => AbortSignal,
) {
  return defineTool({
    name: DIAGNOSE_AGENT_NAME,
    description: DIAGNOSE_AGENT_DESCRIPTION,
    parameters: agentDiagnosticParameters,
    when: HELP_WHEN,
    executionMode: 'serial',
    async execute(input, execution) {
      const active = authorize(execution.signal);
      const signal = AbortSignal.any([active, AbortSignal.timeout(AGENT_DIAGNOSTIC_TIMEOUT_MS)]);
      const scope = readScope();
      if (!scope.sessionId) throw new Error('Agent diagnostics require an active session.');
      const source = createMetricsSource({ packageName: PACKAGE_NAME, serviceName: SERVICE_NAME, ...scope.options });
      try {
        const report = await readAgentDiagnostics(source, scope.sessionId, input, signal);
        signal.throwIfAborted();
        authorize(execution.signal);
        return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }], details: report };
      } finally {
        await source.close?.();
      }
    },
  });
}
