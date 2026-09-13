import { defineApiContract, jsonApiResponses } from '@agimon-ai/doompi-core/api-contracts';
import { Type } from 'typebox';

const S = Type.String();
const N = Type.Number();
const O = Type.Optional;
const literals = <T extends string>(values: T[]) => Type.Union(values.map((value) => Type.Literal(value)));
export const TeamCatalogSchema = Type.Object({
  cwd: S,
  models: Type.Array(S),
  warning: O(S),
  agents: Type.Array(
    Type.Object({
      name: S,
      source: literals(['project', 'user', 'plugin']),
      packageName: O(S),
      description: S,
      model: O(S),
      fallbackModels: Type.Array(S),
      tools: Type.Array(S),
      skills: Type.Array(S),
      extensions: Type.Array(S),
      defaultContext: literals(['fresh', 'fork']),
      filePath: S,
    }),
  ),
});
export const TeamRunsSchema = Type.Object({
  runs: Type.Array(
    Type.Object({
      runId: S,
      agent: S,
      state: literals(['queued', 'running', 'done', 'failed', 'stopped']),
      rawState: S,
      task: S,
      taskRef: O(S),
      model: O(S),
      cwd: S,
      sessionFile: O(S),
      startedAt: N,
      endedAt: O(N),
      lastUpdate: N,
      currentTool: O(S),
      toolCount: O(N),
      tokens: O(N),
      cost: O(N),
      summary: O(S),
      error: O(S),
      tail: Type.Array(S),
    }),
  ),
});
export const apiContracts = defineApiContract({
  version: 1,
  dynamic: [],
  http: [
    {
      id: 'team.catalog',
      scope: 'session',
      basePath: 'team',
      path: '/catalog',
      method: 'GET',
      authentication: 'owner',
      description: 'Discover the active session agent catalog.',
      responses: jsonApiResponses(TeamCatalogSchema),
    },
    {
      id: 'team.run',
      scope: 'session',
      basePath: 'team',
      path: '/run',
      method: 'POST',
      authentication: 'owner',
      description: 'Launch an agent in the selected headless session.',
      body: {
        required: true,
        contentType: 'application/json',
        schema: Type.Object({
          agent: Type.String({ minLength: 1 }),
          task: S,
          fork: Type.Boolean(),
          model: O(Type.String({ minLength: 1 })),
        }),
      },
      responses: jsonApiResponses(Type.Object({ runId: S }), 201),
    },
  ],
  sockets: (['global', 'workspace'] as const).flatMap((scope) => [
    {
      id: 'team.runs',
      scope,
      service: 'doompi.hub.v1',
      member: 'subagent_runs',
      kind: 'channel',
      direction: 'server-to-client',
      description: 'Subagent run channel payload.',
      input: TeamRunsSchema,
    },
    {
      id: 'team.catalog.channel',
      scope,
      service: 'doompi.hub.v1',
      member: 'subagent_catalog',
      kind: 'channel',
      direction: 'server-to-client',
      description: 'Subagent catalog channel payload.',
      input: TeamCatalogSchema,
    },
  ]),
});
export default apiContracts;
