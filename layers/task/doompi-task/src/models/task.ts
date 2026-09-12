/**
 * Domain types for the file-backed task store.
 *
 * The on-disk document is the durable source of truth (unlike rpiv-todo, which
 * replayed state from the transcript). Every field here round-trips through
 * JSON, so nothing may hold non-serializable values.
 */

import type { InlineAgent } from '@agimon-ai/doompi-extension-contracts/subagent-tool';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'deleted';

export const DELETED_STATUS: TaskStatus = 'deleted';

export type TaskAction = 'upsert' | 'list' | 'get' | 'delete' | 'clear' | 'assign' | 'cancel';

export type DelegationState = 'requested' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Terminal result of a delegated subagent run, copied off the delegation response. */
export interface DelegationResult {
  status: string;
  output?: string;
  outputPath?: string;
  sessionFile?: string;
  error?: string;
  durationMs?: number;
  toolCount?: number;
}

/**
 * Delegation bookkeeping attached to a task that was handed to a subagent.
 *
 * `pid` is the harness process that owns the run: it is the only way to tell an
 * genuinely-running delegation from one orphaned by a harness crash, since the
 * child dies with its parent but the file survives.
 */
export interface TaskDelegation {
  requestId: string;
  agent: string;
  state: DelegationState;
  sessionId?: string;
  pid?: number;
  runId?: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  result?: DelegationResult;
}

export interface Task {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  delegation?: TaskDelegation;
}

export const STORE_SCHEMA_VERSION = 1;

/** The complete on-disk document. `rev` increments on every committed write. */
export interface TaskDocument {
  version: number;
  rev: number;
  nextId: number;
  tasks: Task[];
}

export function emptyDocument(): TaskDocument {
  return { version: STORE_SCHEMA_VERSION, rev: 0, nextId: 1, tasks: [] };
}

/**
 * A dependency target inside an upsert item: an existing task id, or the `ref`
 * of a task created earlier in the same call.
 *
 * Refs must start with a letter (see `REF_PATTERN`), so a ref is structurally
 * unconfusable with a stringified id and the discrimination is just `typeof`.
 */
export type DepToken = number | string;

/**
 * One entry of an `upsert` call. No `id` creates a task; an `id` updates one.
 *
 * `blockedBy` (absolute set) is create-only and `addBlockedBy`/`removeBlockedBy`
 * (additive merge) are update-only, matching the split the two former actions
 * had. A field used against the wrong kind fails that item rather than being
 * silently ignored.
 */
export interface TaskItemMutation {
  id?: number;
  ref?: string;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  blockedBy?: DepToken[];
  addBlockedBy?: DepToken[];
  removeBlockedBy?: DepToken[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

/**
 * What one upsert item did. `index` is its position in the request array, so a
 * model reading a partial result can tell which entries still need resending.
 *
 * `message` is unprefixed: the `item[N] failed:` framing belongs to the
 * formatter, because the Task Space overlay shows this text on its own.
 */
export type UpsertItemOutcome =
  | {
      index: number;
      kind: 'created';
      id: number;
      subject: string;
      status: TaskStatus;
      ref?: string;
      blockedBy?: number[];
    }
  | { index: number; kind: 'updated'; id: number; fromStatus: TaskStatus; toStatus: TaskStatus }
  | { index: number; kind: 'unchanged'; id: number; status: TaskStatus }
  | { index: number; kind: 'failed'; message: string; id?: number; ref?: string };

/** Which tasks an upsert touched, so renderResult names them instead of guessing. */
export interface UpsertSummary {
  /** Ids of applied entries, in request order. A failed entry contributes nothing. */
  applied: number[];
  failed: number;
}

/** One task-to-agent handoff inside a native assignment batch. */
export interface TaskAssignment {
  id: number;
  agent: string;
  inlineAgent?: InlineAgent;
  instructions?: string;
  relevantFiles?: string[];
  priorFindings?: string;
  model?: string;
  context?: 'fresh' | 'fork';
}

/** Which assignment entries started, so renderResult can show one consolidated batch. */
export interface AssignmentSummary {
  /** Ids of successful entries, in request order. A failed entry contributes nothing. */
  assigned: number[];
  failed: number;
}

/**
 * Open-shape input bag the reducer accepts. The index signature lets the
 * runtime pass a TypeBox `Static<typeof TaskParamsSchema>` through without
 * casting each field.
 *
 * Per-task fields live on `tasks[]`, not here: a top-level `subject` or
 * `status` would be ambiguous once one call can carry many tasks.
 */
export interface TaskMutationParams {
  [key: string]: unknown;
  tasks?: TaskItemMutation[];
  /** `assign` only: independent task-to-agent handoffs dispatched by one tool call. */
  assignments?: TaskAssignment[];
  /** `list` filter only. To set a status, upsert the task by id. */
  status?: TaskStatus;
  /** `get`, `delete`, and `cancel` only. Assign ids live in `assignments[]`. */
  id?: number;
  includeDeleted?: boolean;
}

/** Snapshot returned under a tool result's `details` for renderResult. */
export interface TaskDetails {
  action: TaskAction;
  params: Record<string, unknown>;
  tasks: Task[];
  nextId: number;
  rev: number;
  error?: string;
  upsert?: UpsertSummary;
  assignment?: AssignmentSummary;
}

/** A delegation is "live" while the owning run may still produce a response. */
export function isDelegationActive(task: Task): boolean {
  const state = task.delegation?.state;
  return state === 'requested' || state === 'running';
}
