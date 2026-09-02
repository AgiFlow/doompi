import { InlineAgentSchema } from '@agimon-ai/doompi-extension-contracts/subagent-tool';
import { type Static, Type } from 'typebox';
import { MAX_BRIEF_FILES } from '../types/delegation';
import type { TaskAction } from '../services/store/types.ts';

export const TASK_ACTIONS = ['upsert', 'list', 'get', 'delete', 'clear', 'assign', 'cancel'] as const;
export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'deleted'] as const;
export const TASK_CONTEXTS = ['fresh', 'fork'] as const;

export const TOOL_NAME = 'task';
export const TOOL_LABEL = 'Task';
export const COMMAND_NAME = 'tasks';

export const ERR_REQUIRES_INTERACTIVE = '/tasks requires interactive mode';
export const MSG_NO_TASKS = 'No tasks yet. Ask the agent to add some!';

/**
 * Which top-level fields each action accepts.
 *
 * The params object is flat and shared across every action, so the schema alone
 * cannot express "upsert has no top-level id". That gap matters: a call like
 * `{"action":"upsert","id":3,"tasks":[{"status":"completed"}]}` would otherwise
 * silently create a duplicate task, because the entry itself carries no id.
 */
export const TASK_ACTION_FIELDS = {
  upsert: ['action', 'tasks'],
  list: ['action', 'status', 'includeDeleted'],
  get: ['action', 'id'],
  delete: ['action', 'id'],
  clear: ['action'],
  assign: ['action', 'assignments'],
  cancel: ['action', 'id'],
} as const satisfies Record<TaskAction, readonly string[]>;

export function taskActionAcceptsField(action: TaskAction, field: string): boolean {
  return (TASK_ACTION_FIELDS[action] as readonly string[]).includes(field);
}

/** Correction hint appended when a per-task field lands at the top level. */
export const MSG_UPSERT_FIELD_MISPLACED =
  'Per-task fields belong inside each tasks[] entry, not at the top level: {"action":"upsert","tasks":[{"id":3,"status":"completed"}]}.';

/**
 * A dependency target: an existing task id, or the `ref` of a task created
 * earlier in the same call.
 */
const DepTokenSchema = Type.Union([Type.Integer(), Type.String()]);

/**
 * One entry of an upsert. `additionalProperties: false` is load-bearing: pi
 * validates tool arguments against this schema before `execute` runs, so a
 * stray `{"action":"update"}` inside an entry is rejected at the boundary.
 */
export const TaskItemSchema = Type.Object(
  {
    id: Type.Optional(
      Type.Integer({
        description:
          'Existing task id to change. Omit to create. An unknown id fails only that entry; it never creates.',
      }),
    ),
    ref: Type.Optional(
      Type.String({
        description:
          'Temporary name for a task created by this entry, so a LATER entry in this array can list it in blockedBy. Must start with a letter; never stored.',
      }),
    ),
    subject: Type.Optional(
      Type.String({
        description: 'Short imperative subject. Required when the entry has no id; on an entry with an id it renames.',
      }),
    ),
    description: Type.Optional(
      Type.String({ description: 'Long-form detail; becomes the brief handed to the subagent on assign.' }),
    ),
    activeForm: Type.Optional(
      Type.String({ description: "Present-continuous label shown while in_progress (e.g. 'writing tests')" }),
    ),
    status: Type.Optional(
      Type.String({
        enum: [...TASK_STATUSES],
        description:
          'New entries default to pending and cannot start deleted; on an entry with an id the transition must be legal.',
      }),
    ),
    blockedBy: Type.Optional(
      Type.Array(DepTokenSchema, {
        description:
          'Dependencies for a NEW entry: task ids, or refs of tasks created EARLIER in this array. On an entry with an id use addBlockedBy / removeBlockedBy instead.',
      }),
    ),
    addBlockedBy: Type.Optional(
      Type.Array(DepTokenSchema, {
        description: 'Dependencies to add (ids or earlier refs). Additive; do not resend the full array.',
      }),
    ),
    removeBlockedBy: Type.Optional(
      Type.Array(DepTokenSchema, {
        description: 'Dependencies to remove. Additive; do not resend the full array.',
      }),
    ),
    owner: Type.Optional(Type.String({ description: 'Owner label; assign sets it to the subagent name.' })),
    metadata: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: 'Merged into the task; a null value deletes that key.',
      }),
    ),
  },
  { additionalProperties: false },
);

/** One task-to-agent handoff in a native assignment batch. */
export const TaskAssignmentSchema = Type.Object(
  {
    id: Type.Integer({ description: 'Pending, unblocked task id to delegate' }),
    agent: Type.String({ description: 'Exact discovered subagent name' }),
    inlineAgent: Type.Optional(InlineAgentSchema),
    instructions: Type.Optional(Type.String({ description: 'Extra instructions appended to this delegated brief' })),
    relevantFiles: Type.Optional(
      Type.Array(Type.String(), {
        description: `Files already read or located, relative to the working directory; at most ${MAX_BRIEF_FILES} are used.`,
      }),
    ),
    priorFindings: Type.Optional(
      Type.String({ description: 'Established facts this child should consume rather than re-derive' }),
    ),
    model: Type.Optional(Type.String({ description: 'Model override for this delegated run' })),
    context: Type.Optional(
      Type.String({
        enum: [...TASK_CONTEXTS],
        description: "Starting context for this child: 'fresh' or 'fork'",
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * Tool parameters. Every `description` doubles as LLM-facing prompt copy, so
 * wording changes here change model behaviour.
 */
export const TaskParamsSchema = Type.Object({
  action: Type.String({ enum: [...TASK_ACTIONS] }),
  tasks: Type.Optional(
    Type.Array(TaskItemSchema, {
      minItems: 1,
      description:
        'upsert only. An entry with an id changes that task, an entry without an id creates one. Entries apply in array order, so a later entry can depend on an earlier one by ref.',
    }),
  ),
  assignments: Type.Optional(
    Type.Array(TaskAssignmentSchema, {
      minItems: 1,
      description: 'Required for assign, one entry per task, including when there is only one.',
    }),
  ),
  id: Type.Optional(
    Type.Integer({
      description:
        'Task id, for get, delete and cancel. Not accepted by upsert or assign: those carry ids inside tasks[] and assignments[] entries.',
    }),
  ),
  status: Type.Optional(
    Type.String({
      enum: [...TASK_STATUSES],
      description: 'list only: return just the tasks in this status. To SET a status, upsert the task by id.',
    }),
  ),
  includeDeleted: Type.Optional(
    Type.Boolean({ description: 'list only: also return deleted tombstones. Default false.' }),
  ),
});

export type TaskItemParams = Static<typeof TaskItemSchema>;
export type TaskAssignmentParams = Static<typeof TaskAssignmentSchema>;
export type TaskParams = Static<typeof TaskParamsSchema>;
