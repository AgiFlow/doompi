import { type Static, Type } from 'typebox';

/**
 * The tool's action vocabulary.
 *
 * One tool with an action field rather than six tools, matching `subagent`:
 * the actions share a subject and are meaningless apart from it, and six
 * separate tools would spend six description budgets teaching the same nouns.
 */
export const WORKTREE_ACTIONS = {
  spawn_worktree: 'spawn_worktree',
  close_worktree: 'close_worktree',
  list: 'list',
  status: 'status',
  merge: 'merge',
  prune: 'prune',
  send: 'send',
  messages: 'messages',
} as const;

export type WorktreeAction = (typeof WORKTREE_ACTIONS)[keyof typeof WORKTREE_ACTIONS];

/**
 * Which fields each action accepts.
 *
 * Rejecting an unknown field is what stops a plausible-looking call from doing
 * something other than what it reads like: `close_worktree` with `branch`
 * instead of `id` would otherwise close whatever the default resolved to.
 */
export const WORKTREE_ACTION_FIELDS: Record<WorktreeAction, readonly string[]> = {
  spawn_worktree: ['action', 'branch', 'baseRef', 'task', 'name'],
  close_worktree: ['action', 'id', 'force'],
  list: ['action'],
  status: ['action', 'id'],
  merge: ['action', 'id', 'message'],
  prune: ['action', 'dryRun'],
  send: ['action', 'id', 'message'],
  messages: ['action', 'id'],
};

const SpawnParams = Type.Object(
  {
    action: Type.Literal(WORKTREE_ACTIONS.spawn_worktree),
    branch: Type.String({ minLength: 1 }),
    baseRef: Type.Optional(Type.String({ minLength: 1 })),
    task: Type.Optional(Type.String({ minLength: 1 })),
    name: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const CloseParams = Type.Object(
  {
    action: Type.Literal(WORKTREE_ACTIONS.close_worktree),
    id: Type.String({ minLength: 1 }),
    force: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const ListParams = Type.Object({ action: Type.Literal(WORKTREE_ACTIONS.list) }, { additionalProperties: false });

const StatusParams = Type.Object(
  { action: Type.Literal(WORKTREE_ACTIONS.status), id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const MergeParams = Type.Object(
  {
    action: Type.Literal(WORKTREE_ACTIONS.merge),
    id: Type.String({ minLength: 1 }),
    message: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const PruneParams = Type.Object(
  { action: Type.Literal(WORKTREE_ACTIONS.prune), dryRun: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);

const SendParams = Type.Object(
  {
    action: Type.Literal(WORKTREE_ACTIONS.send),
    id: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const MessagesParams = Type.Object(
  { action: Type.Literal(WORKTREE_ACTIONS.messages), id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const RunWorktreeParams = Type.Union([
  SpawnParams,
  CloseParams,
  ListParams,
  StatusParams,
  MergeParams,
  PruneParams,
  SendParams,
  MessagesParams,
]);

export type RunWorktreeToolParams = Static<typeof RunWorktreeParams>;
