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

/** The actions that accept `field`, so the declared docs cannot drift from the validator. */
function acceptingActions(field: string): string {
  return Object.values(WORKTREE_ACTIONS)
    .filter((action) => WORKTREE_ACTION_FIELDS[action].includes(field))
    .join(', ');
}

/**
 * The schema declared to the model.
 *
 * A flat object rather than `RunWorktreeParams` itself. A top-level union is
 * `{anyOf:[...]}` with no `properties`, and Pi's Anthropic Messages adapter
 * rebuilds tool input as `{type:'object', properties: schema.properties ?? {},
 * required: schema.required ?? []}`, so the union arrived at the model as an
 * empty object while the host went on validating calls against it. Nothing here
 * relaxes what is accepted: `validateParams` still rejects an unknown action, a
 * field the action does not take, and a missing required one.
 */
export const RunWorktreeToolSchema = Type.Object(
  {
    action: Type.String({
      enum: [...Object.values(WORKTREE_ACTIONS)],
      description: 'The operation to run. Every other field is accepted only by the actions its description names.',
    }),
    branch: Type.Optional(
      Type.String({ minLength: 1, description: `New branch to create. Actions: ${acceptingActions('branch')}.` }),
    ),
    baseRef: Type.Optional(
      Type.String({
        minLength: 1,
        description: `Base ref, defaulting to the current branch. Actions: ${acceptingActions('baseRef')}.`,
      }),
    ),
    task: Type.Optional(
      Type.String({
        minLength: 1,
        description: `First message for the new session. Actions: ${acceptingActions('task')}.`,
      }),
    ),
    name: Type.Optional(
      Type.String({ minLength: 1, description: `Rail label for the worktree. Actions: ${acceptingActions('name')}.` }),
    ),
    id: Type.Optional(Type.String({ minLength: 1, description: `Worktree id. Actions: ${acceptingActions('id')}.` })),
    force: Type.Optional(
      Type.Boolean({ description: `Close even when the tree is dirty. Actions: ${acceptingActions('force')}.` }),
    ),
    message: Type.Optional(
      Type.String({
        minLength: 1,
        description: `Merge commit message, or the text to send. Actions: ${acceptingActions('message')}.`,
      }),
    ),
    dryRun: Type.Optional(
      Type.Boolean({ description: `Report the plan without destroying anything. Actions: ${acceptingActions('dryRun')}.` }),
    ),
  },
  { additionalProperties: false },
);

export type RunWorktreeToolParams = Static<typeof RunWorktreeParams>;
