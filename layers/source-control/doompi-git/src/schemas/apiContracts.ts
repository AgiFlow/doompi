import { defineApiContract, jsonApiResponses } from '@agimon-ai/doompi-core/apiContracts';
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
  parentSessionId: Type.Optional(S),
  status: literals(['spawning', 'running', 'closing', 'orphaned']),
  createdAt: S,
});
const ErrorTargetSchema = Type.Union([
  Type.Object({ action: Type.Literal('create') }),
  Type.Object({ action: Type.Literal('close'), id: S }),
]);
export const WorktreesPayloadSchema = Type.Object({
  worktrees: Type.Array(
    Type.Object({ id: S, branch: S, path: S, sessionId: Type.Union([S, Type.Null()]), orphaned: B, unowned: B }),
  ),
  pending: O(S),
  error: O(S),
  errorTarget: O(ErrorTargetSchema),
});
export const WorktreesCommandSchema = Type.Union([
  Type.Object({
    action: Type.Literal('create'),
    branch: S,
    baseRef: O(S),
    reservationId: O(Type.String({ minLength: 1, pattern: '^[A-Za-z0-9_-]+$' })),
  }),
  Type.Object({ action: Type.Literal('close'), id: S, force: O(B) }),
]);
const N = Type.Integer({ minimum: 0 });
const ChangesSchema = Type.Object({
  branch: O(S),
  base: O(S),
  added: N,
  removed: N,
  files: N,
  truncated: O(B),
  upstream: O(Type.Object({ ref: S, ahead: N, behind: N })),
  rebase: O(Type.Object({ conflicts: Type.Array(S) })),
});
const SyncErrorTargetSchema = Type.Union([
  Type.Object({ action: literals(['pull', 'rebase', 'abort-rebase']) }),
  Type.Object({ action: Type.Literal('push'), forceRequired: O(Type.Literal(true)) }),
]);
export const GitChangesPayloadSchema = Type.Object({
  changes: O(ChangesSchema),
  pending: O(S),
  error: O(S),
  errorTarget: O(SyncErrorTargetSchema),
});
export const GitChangesCommandSchema = Type.Union([
  Type.Object({ action: literals(['pull', 'rebase', 'abort-rebase']) }),
  Type.Object({ action: Type.Literal('push'), force: O(Type.Literal(true)) }),
]);
const AuthViewSchema = Type.Object({
  method: literals(['none', 'ssh', 'https']),
  ssh: O(Type.Object({ keyPath: O(S) })),
  https: O(Type.Object({ host: S, username: S, hasToken: B })),
});
const AuthSaveSchema = Type.Union([
  Type.Object({ method: Type.Literal('none') }),
  Type.Object({ method: Type.Literal('ssh'), keyPath: O(S) }),
  Type.Object({ method: Type.Literal('https'), host: S, username: S, token: O(Type.String({ writeOnly: true })) }),
]);
const DiffRowSchema = Type.Object({ marker: literals(['+', '-', ' ']), line: N, content: S });
const ReviewSummarySchema = Type.Object({
  repository: B,
  branch: O(S),
  base: O(S),
  mergeBase: O(S),
  truncated: O(B),
  files: Type.Array(
    Type.Object({
      path: S,
      status: literals(['added', 'modified', 'deleted', 'untracked', 'conflicted']),
      added: N,
      removed: N,
      binary: O(B),
    }),
  ),
});
const ReviewFileSchema = Type.Object({
  path: S,
  hunks: Type.Array(Type.Object({ start: N, rows: Type.Array(DiffRowSchema) })),
  binary: O(Type.Literal(true)),
  tooLarge: O(Type.Literal(true)),
});
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
    // The new-session dialog's routes and a workspace's remote auth exist only on a workspace mount.
    ...(scope === 'workspace'
      ? [
          {
            id: 'git.auth.read',
            scope,
            basePath: 'git',
            path: '/auth',
            method: 'GET' as const,
            authentication: 'owner' as const,
            description: "Read a workspace's remote auth for manual sync. The token is never returned.",
            parameters: [{ name: 'repositoryId', in: 'query' as const, required: true, schema: S }],
            responses: jsonApiResponses(AuthViewSchema),
          },
          {
            id: 'git.auth.save',
            scope,
            basePath: 'git',
            path: '/auth',
            method: 'PUT' as const,
            authentication: 'owner' as const,
            description: "Replace a workspace's remote auth. Passkey step-up gated for remote devices.",
            parameters: [{ name: 'repositoryId', in: 'query' as const, required: true, schema: S }],
            body: { required: true, contentType: 'application/json', schema: AuthSaveSchema },
            responses: jsonApiResponses(AuthViewSchema),
          },
          {
            id: 'git.branches',
            scope,
            basePath: 'git',
            path: '/branches',
            method: 'GET' as const,
            authentication: 'owner' as const,
            description: 'List the workspace branches for the new-session dialog.',
            responses: jsonApiResponses(
              Type.Object({
                repository: B,
                current: O(S),
                defaultBase: O(S),
                local: Type.Array(Type.Object({ name: S, checkedOutAt: O(S) })),
                remote: Type.Array(Type.Object({ remote: S, name: S })),
              }),
            ),
          },
          {
            id: 'git.sessions.create',
            scope,
            basePath: 'git',
            path: '/sessions',
            method: 'POST' as const,
            authentication: 'owner' as const,
            description: 'Start a top-level worktree session on an existing or new branch.',
            body: {
              required: true,
              contentType: 'application/json',
              schema: Type.Union([
                Type.Object({ mode: Type.Literal('existing-branch'), branch: S, remote: O(S), name: O(S) }),
                Type.Object({ mode: Type.Literal('new-branch'), branch: S, baseRef: O(S), name: O(S) }),
              ]),
            },
            responses: jsonApiResponses(Type.Object({ sessionId: S, worktreeId: S }), 201),
          },
        ]
      : []),
    // The review routes exist only on a session mount; listed once, beside the global entries.
    ...(scope === 'global'
      ? [
          {
            id: 'git.review.summary',
            scope: 'session' as const,
            basePath: 'git',
            path: '/review',
            method: 'GET' as const,
            authentication: 'owner' as const,
            description: "List the files the session's checkout changed against its base.",
            responses: jsonApiResponses(ReviewSummarySchema),
          },
          {
            id: 'git.review.file',
            scope: 'session' as const,
            basePath: 'git',
            path: '/review/file',
            method: 'GET' as const,
            authentication: 'owner' as const,
            description: "One changed file's hunks; the path must be in the session's change set.",
            parameters: [{ name: 'path', in: 'query' as const, required: true, schema: Type.String({ minLength: 1 }) }],
            responses: jsonApiResponses(ReviewFileSchema),
          },
        ]
      : []),
  ]),
  sockets: (['global', 'workspace'] as const).flatMap((scope) => [
    {
      id: 'git.changes.channel',
      scope,
      service: 'doompi.hub.v1',
      member: 'git_changes',
      kind: 'channel',
      direction: 'server-to-client',
      description: "The session's change against its base, and manual sync state.",
      input: GitChangesPayloadSchema,
    },
    {
      id: 'git.changes.command',
      scope,
      service: 'doompi.hub.v1',
      member: 'git_changes',
      kind: 'channel',
      direction: 'client-to-server',
      description: 'Manual pull, push, rebase or abort-rebase for the session.',
      input: GitChangesCommandSchema,
    },
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
