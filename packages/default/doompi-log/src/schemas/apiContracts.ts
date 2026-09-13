import { defineApiContract, jsonApiResponses } from '@agimon-ai/doompi-core/api-contracts';
import { Type } from 'typebox';

const S = Type.String();
const N = Type.Number();
const B = Type.Boolean();
const O = Type.Optional;
const literals = <T extends string>(values: T[]) => Type.Union(values.map((value) => Type.Literal(value)));
const Dimension = literals(['session', 'agent', 'model', 'provider']);
const Period = literals(['day', 'week', 'month', 'all']);
const Unavailable = Type.Object({ unavailable: literals(['no-sink', 'no-data', 'no-api']), detail: S });
const Tokens = { totalTokens: N, inputTokens: N, outputTokens: N };
export const MetricsResponseSchema = Type.Union([
  Unavailable,
  Type.Object({
    generatedAt: S,
    dimension: Dimension,
    period: Period,
    bucketUnit: S,
    focus: O(S),
    transport: O(literals(['http', 'cli'])),
    totals: Type.Object({
      ...Tokens,
      cachedTokens: N,
      reasoningTokens: N,
      groupCount: N,
      failedGroups: N,
      issueCount: N,
    }),
    timeline: Type.Array(Type.Object({ label: S, ...Tokens })),
    groups: Type.Array(Type.Object({ key: S, ...Tokens, issueCount: N, failed: B })),
    tools: Type.Array(Type.Object({ name: S, calls: N, p90TotalTokens: N })),
  }),
]);
const Nullable = Type.Union([S, Type.Null()]);
export const IssuesResponseSchema = Type.Union([
  Unavailable,
  Type.Object({
    totalIssues: N,
    uniqueIncidents: N,
    byCategory: Type.Record(S, N),
    byTool: Type.Record(S, N),
    byErrorType: Type.Record(S, N),
    samples: Type.Array(
      Type.Object({
        fingerprint: S,
        occurrenceCount: N,
        category: S,
        timestamp: S,
        level: S,
        message: S,
        detail: S,
        tool: Nullable,
        errorType: Nullable,
        agentName: Nullable,
        model: Nullable,
        statusCode: Nullable,
      }),
    ),
  }),
]);
export const apiContracts = defineApiContract({
  version: 1,
  sockets: [],
  dynamic: [],
  http: (['global', 'workspace'] as const).flatMap((scope) => [
    {
      id: 'log.metrics',
      scope,
      basePath: 'log',
      path: '/metrics',
      method: 'GET',
      authentication: 'owner',
      description: 'Read usage metrics from the configured log sink.',
      parameters: [
        { name: 'dimension', in: 'query', required: false, schema: Dimension },
        { name: 'period', in: 'query', required: false, schema: Period },
        { name: 'focus', in: 'query', required: false, schema: S },
      ],
      responses: jsonApiResponses(MetricsResponseSchema),
    },
    {
      id: 'log.issues',
      scope,
      basePath: 'log',
      path: '/issues',
      method: 'GET',
      authentication: 'owner',
      description: 'Read log issue details.',
      parameters: [{ name: 'focus', in: 'query', required: false, schema: S }],
      responses: jsonApiResponses(IssuesResponseSchema),
    },
  ]),
});
export default apiContracts;
