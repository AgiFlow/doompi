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
          'Existing task id to change. Omit to create a new task. An entry with an id never creates: if the id is unknown, only that entry fails.',
      }),
    ),
    ref: Type.Optional(
      Type.String({
        description:
          'Temporary name for a task created by this entry, so a LATER entry in the same tasks[] can list it in blockedBy before its real id exists. Must start with a letter. Scoped to this one call and never stored; the response reports which real id it became.',
      }),
    ),
    subject: Type.Optional(
      Type.String({
        description:
          "Short imperative subject line (e.g. 'Research existing tool'). Required when the entry has no id; on an entry with an id it renames the task.",
      }),
    ),
    description: Type.Optional(
      Type.String({
        description: 'Long-form task detail. This becomes the brief handed to the subagent when the task is assigned.',
      }),
    ),
    activeForm: Type.Optional(
      Type.String({
        description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
      }),
    ),
    status: Type.Optional(
      Type.String({
        enum: [...TASK_STATUSES],
        description:
          'Starting status for a new entry (default pending; deleted is rejected), or the target status for an entry with an id, where the transition must be legal.',
      }),
    ),
    blockedBy: Type.Optional(
      Type.Array(DepTokenSchema, {
        description:
          'Dependencies for a NEW entry (one with no id): this task is blocked by each target. A number is an existing task id; a string is the ref of a task created by an EARLIER entry in this same array. Use addBlockedBy / removeBlockedBy on an entry that has an id.',
      }),
    ),
    addBlockedBy: Type.Optional(
      Type.Array(DepTokenSchema, {
        description:
          'Dependencies to add, for an entry with an id. Task ids, or refs declared by an earlier entry. Additive merge — do not resend the full array.',
      }),
    ),
    removeBlockedBy: Type.Optional(
      Type.Array(DepTokenSchema, {
        description: 'Dependencies to remove, for an entry with an id. Additive merge — do not resend the full array.',
      }),
    ),
    owner: Type.Optional(
      Type.String({ description: 'Owner label for this task. assign sets this to the subagent name automatically.' }),
    ),
    metadata: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: 'Arbitrary metadata merged into the task; pass null as a value to delete that key',
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
        description: `Files already read or located for this task. Paths are relative to the working directory; at most ${MAX_BRIEF_FILES} are used.`,
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
  action: Type.String({
    enum: [...TASK_ACTIONS],
    description:
      'upsert (create new tasks and change existing ones, one or many per call), list, get, delete (tombstone), clear (close/reset the list), assign (delegate one or more tasks through assignments[]), cancel (stop a delegated run)',
  }),
  tasks: Type.Optional(
    Type.Array(TaskItemSchema, {
      minItems: 1,
      description:
        'upsert only. One entry per task: an entry with an id changes that task, an entry without an id creates one. Entries apply in array order, so a later entry can depend on an earlier one by ref. Each entry succeeds or fails on its own: the ones that succeed are committed and the ones that fail are reported by their array index.',
    }),
  ),
  assignments: Type.Optional(
    Type.Array(TaskAssignmentSchema, {
      minItems: 1,
      description:
        'Required for assign, including one task. Each entry selects its own pending, unblocked task, agent, model, and context pack; successful entries remain delegated if another entry fails. assign has no top-level single-task form.',
    }),
  ),
  id: Type.Optional(
    Type.Integer({
      description:
        'Task id, for get, delete, and cancel. For assign, put every id inside assignments[]. upsert does not accept this field — put the id inside the tasks[] entry you want to change.',
    }),
  ),
  status: Type.Optional(
    Type.String({
      enum: [...TASK_STATUSES],
      description:
        'list only: return just the tasks in this status. To SET a status, use upsert with the task id inside tasks[].',
    }),
  ),
  includeDeleted: Type.Optional(
    Type.Boolean({
      description: 'If true, list returns deleted (tombstoned) tasks as well. Default: false.',
    }),
  ),
});

export type TaskItemParams = Static<typeof TaskItemSchema>;
export type TaskAssignmentParams = Static<typeof TaskAssignmentSchema>;
export type TaskParams = Static<typeof TaskParamsSchema>;
