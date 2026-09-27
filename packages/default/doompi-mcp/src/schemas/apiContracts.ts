import { defineApiContract, jsonApiResponses } from '@agimon-ai/doompi-core/apiContracts';
import { Type } from 'typebox';

const S = Type.String();
const N = Type.Number();
const B = Type.Boolean();
const O = Type.Optional;
const literals = <T extends string>(values: T[]) => Type.Union(values.map((value) => Type.Literal(value)));
const RepositoryId = Type.String({ pattern: '^(?:[a-f0-9]{32}|repo-[A-Za-z0-9_-]{24})$' });
const RepositoryQuery = [{ name: 'repositoryId', in: 'query' as const, required: true, schema: RepositoryId }];
export const McpCatalogSchema = Type.Object({
  repositoryId: S,
  sync: Type.Object({ fresh: B, reasons: Type.Array(S) }),
  servers: Type.Array(
    Type.Object({
      name: S,
      state: literals(['not-connected', 'connecting', 'connected', 'degraded', 'needs-auth', 'failed', 'closed']),
      source: literals(['cached', 'live', 'configured']),
      credentialPresent: B,
      tools: Type.Array(Type.Object({ name: S, piName: S, description: O(S) })),
      error: O(S),
    }),
  ),
  droppedServers: Type.Array(S),
  diagnostics: Type.Array(S),
});
export const McpAuthorizationSchema = Type.Object({
  id: S,
  repositoryId: S,
  serverName: S,
  status: literals(['starting', 'waiting', 'completed', 'failed', 'cancelled', 'expired']),
  authorizationUrl: O(S),
  error: O(S),
  expiresAt: N,
});
export const McpSessionToolSchema = Type.Object({
  server: S,
  tool: S,
  description: O(S),
  inputSchema: Type.Record(S, Type.Unknown()),
  tokens: N,
});
const SessionToolQuery = [
  { name: 'server', in: 'query' as const, required: true, schema: Type.String({ minLength: 1, maxLength: 160 }) },
  { name: 'tool', in: 'query' as const, required: true, schema: Type.String({ minLength: 1, maxLength: 256 }) },
];
type HttpContract = Parameters<typeof defineApiContract>[0]['http'][number];
export const apiContracts = defineApiContract({
  version: 1,
  sockets: [],
  dynamic: [],
  http: [
    {
      id: 'mcp.session.tool',
      scope: 'session',
      basePath: 'mcp-session',
      path: '/tool',
      method: 'GET',
      authentication: 'owner',
      description: 'Read one tool the session reaches through mcp_use: its description, schema, and token cost.',
      parameters: SessionToolQuery,
      responses: jsonApiResponses(McpSessionToolSchema),
    },
    ...(['global', 'workspace'] as const).flatMap((scope): HttpContract[] => [
      {
        id: 'mcp.catalog',
        scope,
        basePath: 'mcp',
        path: '/repository',
        method: 'GET',
        authentication: 'owner',
        description: 'Read the synced MCP repository catalog.',
        parameters: RepositoryQuery,
        responses: jsonApiResponses(McpCatalogSchema),
      },
      {
        id: 'mcp.discover',
        scope,
        basePath: 'mcp',
        path: '/repository/discover',
        method: 'POST',
        authentication: 'owner',
        description: 'Discover repository MCP servers.',
        body: { required: true, contentType: 'application/json', schema: Type.Object({ repositoryId: RepositoryId }) },
        responses: jsonApiResponses(McpCatalogSchema),
      },
      {
        id: 'mcp.authorize',
        scope,
        basePath: 'mcp',
        path: '/repository/authorize',
        method: 'POST',
        authentication: 'owner',
        description: 'Start MCP authorization.',
        body: {
          required: true,
          contentType: 'application/json',
          schema: Type.Object({
            repositoryId: RepositoryId,
            serverName: Type.String({ minLength: 1, maxLength: 160 }),
          }),
        },
        responses: jsonApiResponses(McpAuthorizationSchema, 202),
      },
      ...(['GET', 'DELETE'] as const).map((method) => ({
        id: `mcp.authorization.${method}`,
        scope,
        basePath: 'mcp',
        path: '/repository/authorize/{flowId}',
        method,
        authentication: 'owner' as const,
        description: method === 'GET' ? 'Read an authorization flow.' : 'Cancel an authorization flow.',
        parameters: RepositoryQuery,
        responses: jsonApiResponses(McpAuthorizationSchema),
      })),
    ]),
  ],
});
export default apiContracts;
