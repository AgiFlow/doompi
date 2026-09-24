import { Type } from 'typebox';

import { AGENT_DIAGNOSTIC_MAX_TOOLS } from '../constants/diagnostics';

const count = Type.Number({ minimum: 0 });
const coverage = Type.Number({ minimum: 0, maximum: 100 });
export const agentDiagnosticParameters = Type.Object(
  {
    period: Type.Optional(Type.Union([Type.Literal('day'), Type.Literal('week')])),
    toolLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: AGENT_DIAGNOSTIC_MAX_TOOLS })),
  },
  { additionalProperties: false },
);

/** Validate only the fields we return. Extra upstream fields never cross this boundary. */
export const scopedMetricsSchema = Type.Object({
  groupBy: Type.Literal('session'),
  period: Type.Union([Type.Literal('day'), Type.Literal('week')]),
  filters: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
  totals: Type.Object({
    totalRecords: count,
    issueCount: count,
    usageEventCount: count,
    inputTokens: count,
    outputTokens: count,
    totalTokens: count,
    cachedInputTokens: count,
    reasoningOutputTokens: count,
    tokenCoveragePercent: coverage,
  }),
  groups: Type.Array(
    Type.Object({
      sessionId: Type.String({ minLength: 1 }),
      byCategory: Type.Record(Type.String(), count),
    }),
    { maxItems: 1 },
  ),
  tools: Type.Object({
    returnedTools: count,
    rows: Type.Array(
      Type.Object({
        toolName: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_./:-]+$' }),
        invocationCount: count,
        toolCallTurn: Type.Object({ samples: count, avgTotalTokens: count, p90TotalTokens: count }),
      }),
      { maxItems: AGENT_DIAGNOSTIC_MAX_TOOLS },
    ),
  }),
});
