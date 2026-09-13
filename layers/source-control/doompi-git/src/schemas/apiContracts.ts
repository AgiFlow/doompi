import { defineApiContract, jsonApiResponses } from '@agimon-ai/doompi-core/api-contracts';
import { Type } from 'typebox';

const S = Type.String();
const B = Type.Boolean();
const O = Type.Optional;
const literals = <T extends string>(values: T[]) => Type.Union(values.map((value) => Type.Literal(value)));
const RecordSchema = Type.Object({
  version: Type.Literal(1),
  id: S,
  branch: S,
  baseRef: S,
  path: S,
  repositoryRoot: S,
  sessionId: S,
  parentSessionId: S,
  status: literals(['spawning', 'running', 'closing', 'orphaned']),
  createdAt: S,
});
export const WorktreesPayloadSchema = Type.Object({
  worktrees: Type.Array(
    Type.Object({ id: S, branch: S, path: S, sessionId: Type.Union([S, Type.Null()]), orphaned: B, unowned: B }),
  ),
  pending: O(S),
  error: O(S),
});
export const WorktreesCommandSchema = Type.Union([
  Type.Object({ action: Type.Literal('create'), branch: S, baseRef: O(S) }),
  Type.Object({ action: Type.Literal('close'), id: S, force: O(B) }),
]);
const query = [
  { name: 'repositoryId', in: 'query' as const, required: true, schema: S },
  { name: 'sessionId', in: 'query' as const, required: true, schema: S },
];
export const apiContracts = defineApiContract({
  version: 1,
  dynamic: [],
  http: (['global', 'workspace'] as const).flatMap((scope) => [
    {
      id: 'git.list',
      scope,
      basePath: 'git',
      path: '/worktrees',
      method: 'GET',
      authentication: 'owner',
      description: 'List admitted repository worktrees.',
      parameters: query.map((item) => ({ ...item, required: item.name === 'repositoryId' })),
      responses: jsonApiResponses(Type.Object({ worktrees: Type.Array(RecordSchema) })),
    },
    {
      id: 'git.create',
      scope,
      basePath: 'git',
      path: '/worktrees',
      method: 'POST',
      authentication: 'owner',
      description: 'Create a worktree and session.',
      parameters: query,
      body: {
        required: true,
        contentType: 'application/json',
        schema: Type.Object({ branch: Type.String({ minLength: 1 }), baseRef: O(S), name: O(S) }),
      },
      responses: jsonApiResponses(Type.Object({ worktree: RecordSchema }), 201),
    },
    {
      id: 'git.close',
      scope,
      basePath: 'git',
      path: '/worktrees/{id}',
      method: 'DELETE',
      authentication: 'owner',
      description: 'Close a worktree.',
      parameters: [...query, { name: 'force', in: 'query', required: false, schema: B }],
      responses: jsonApiResponses(Type.Object({ worktree: RecordSchema })),
    },
  ]),
  sockets: (['global', 'workspace'] as const).flatMap((scope) => [
    {
      id: 'git.channel',
      scope,
      service: 'doompi.hub.v1',
      member: 'git_worktrees',
      kind: 'channel',
      direction: 'server-to-client',
      description: 'Worktree channel payload.',
      input: WorktreesPayloadSchema,
    },
    {
      id: 'git.command',
      scope,
      service: 'doompi.hub.v1',
      member: 'git_worktrees',
      kind: 'channel',
      direction: 'client-to-server',
      description: 'Worktree channel command payload.',
      input: WorktreesCommandSchema,
    },
  ]),
});
export default apiContracts;
