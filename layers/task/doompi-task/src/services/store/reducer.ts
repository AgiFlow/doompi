import { isTransitionValid } from './invariants.ts';
import { detectCycle } from './taskGraph.ts';
import {
  DELETED_STATUS,
  type DepToken,
  isDelegationActive,
  type Task,
  type TaskAction,
  type TaskDocument,
  type TaskItemMutation,
  type TaskMutationParams,
  type TaskStatus,
  type UpsertItemOutcome,
} from './types.ts';

/** Default board capacity when a caller does not provide a configured limit. */
const DEFAULT_REDUCER_MAX_TASKS = 15;

/** Bounds the work one call can do, and with it the size of one committed write. */
export const MAX_UPSERT_ITEMS = 100;

/**
 * A ref must start with a letter, which makes it structurally unconfusable with
 * a stringified id. That is why resolving a dependency token is just a `typeof`
 * check with no coercion heuristics.
 */
export const REF_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/**
 * Reducer outcome. Closed tagged union: adding an action requires extending
 * this union and the response formatter, which the compiler enforces.
 *
 * `upsert` carries one outcome per request item. It is returned even when every
 * item failed — `error` is reserved for whole-call faults — so the tool layer
 * still has the per-item messages to report.
 */
export type Op =
  | { kind: 'upsert'; items: UpsertItemOutcome[]; applied: number; failed: number }
  | { kind: 'delete'; id: number; subject: string }
  | { kind: 'list'; statusFilter?: TaskStatus; includeDeleted: boolean }
  | { kind: 'get'; task: Task }
  | { kind: 'clear'; count: number }
  | { kind: 'error'; message: string };

export interface ApplyResult {
  document: TaskDocument;
  op: Op;
}

/** Actions the reducer owns. `assign`/`cancel` are handled by the delegation manager. */
export type ReducerAction = Exclude<TaskAction, 'assign' | 'cancel'>;

/**
 * Does this op represent state that must reach disk?
 *
 * The exhaustive switch is the point: a future `Op` variant cannot be added
 * without declaring its persistence intent, so nothing silently starts or stops
 * bumping `rev`.
 */
export function isCommittingOp(op: Op): boolean {
  switch (op.kind) {
    case 'error':
    case 'list':
    case 'get':
      return false;
    case 'upsert':
      return op.items.some((item) => item.kind === 'created' || item.kind === 'updated');
    case 'delete':
    case 'clear':
      return true;
  }
}

/** Joined per-item failures, for the thrown error when an upsert applied nothing. */
export function formatUpsertFailure(op: Extract<Op, { kind: 'upsert' }>): string {
  return op.items
    .filter((item) => item.kind === 'failed')
    .map((item) => `item[${item.index}]: ${item.message}`)
    .join('\n');
}

/** The single item's outcome, for callers that only ever send a batch of one. */
export function singleItemOutcome(op: Op): UpsertItemOutcome | undefined {
  return op.kind === 'upsert' ? op.items[0] : undefined;
}

function errorResult(document: TaskDocument, message: string): ApplyResult {
  return { document, op: { kind: 'error', message } };
}

function sameNumberList(a: number[] | undefined, b: number[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((value, index) => value === y[index]);
}

function sameRecord(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Did this update change anything? A no-effect update (status re-set to its
 * current value, fields re-sent unchanged) reports "No change" rather than
 * "Updated #N" — without the distinction a model can loop re-issuing the same
 * call believing it never landed.
 */
function taskChanged(before: Task, after: Task): boolean {
  return (
    before.subject !== after.subject ||
    before.status !== after.status ||
    before.description !== after.description ||
    before.activeForm !== after.activeForm ||
    before.owner !== after.owner ||
    !sameNumberList(before.blockedBy, after.blockedBy) ||
    !sameRecord(before.metadata, after.metadata)
  );
}

function withTasks(document: TaskDocument, tasks: Task[], nextId = document.nextId): TaskDocument {
  return { ...document, tasks, nextId };
}

/** Merge incoming metadata over a base; a `null` value deletes its key. */
function mergeMetadata(
  base: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return Object.keys(merged).length ? merged : undefined;
}

/** Copy the optional scalar fields an item may set onto a task, in place. */
function assignScalars(target: Task, item: TaskItemMutation): void {
  if (item.subject !== undefined) target.subject = item.subject;
  if (item.description !== undefined) target.description = item.description;
  if (item.activeForm !== undefined) target.activeForm = item.activeForm;
  if (item.owner !== undefined) target.owner = item.owner;
  if (item.metadata !== undefined) {
    const merged = mergeMetadata(target.metadata, item.metadata);
    if (merged === undefined) delete target.metadata;
    else target.metadata = merged;
  }
}

/**
 * Working state threaded item to item, so entry N observes every effect of
 * entries 1..N-1. `refIds` and `failedRefs` are what make the cascade work:
 * refs resolve backward only, so an entry that names a failed sibling is always
 * processed after the failure that killed it.
 */
interface UpsertContext {
  tasks: Task[];
  nextId: number;
  maxTasks: number;
  refIds: Map<string, number>;
  failedRefs: Map<string, number>;
}

type Resolved = { ok: true; id: number } | { ok: false; message: string };

function resolveDep(context: UpsertContext, field: string, token: DepToken): Resolved {
  if (typeof token === 'number') return { ok: true, id: token };
  if (!REF_PATTERN.test(token)) {
    return { ok: false, message: `${field}: "${token}" is not a valid ref; pass an existing task id as a number` };
  }
  const id = context.refIds.get(token);
  if (id !== undefined) return { ok: true, id };
  const failedAt = context.failedRefs.get(token);
  if (failedAt !== undefined) {
    return { ok: false, message: `${field}: ref "${token}" refers to item[${failedAt}], which failed` };
  }
  return {
    ok: false,
    message: `${field}: unknown ref "${token}" — a ref must be declared by an earlier entry in the same call`,
  };
}

type ItemResult = { ok: true; outcome: UpsertItemOutcome } | { ok: false; message: string };

function fail(message: string): ItemResult {
  return { ok: false, message };
}

/** Structural checks that apply to every entry, whichever kind it is. */
function checkShape(context: UpsertContext, item: TaskItemMutation): string | undefined {
  if (item.ref !== undefined) {
    if (item.id !== undefined) return 'ref is only valid when creating a task; drop the id, or drop the ref';
    if (!REF_PATTERN.test(item.ref)) {
      return `ref "${item.ref}" is invalid: a ref must start with a letter and contain only letters, digits, - or _`;
    }
    const owner = context.refIds.get(item.ref) !== undefined || context.failedRefs.has(item.ref);
    if (owner) return `duplicate ref "${item.ref}": it was already declared by an earlier entry`;
  }
  return undefined;
}

function applyCreateItem(context: UpsertContext, item: TaskItemMutation, index: number, now: string): ItemResult {
  if (item.subject === undefined) return fail('subject is required when the entry has no id');
  if (!item.subject.trim()) return fail('subject must not be blank');
  if (item.addBlockedBy !== undefined || item.removeBlockedBy !== undefined) {
    return fail('addBlockedBy / removeBlockedBy are only for an entry with an id; a new task uses blockedBy');
  }
  // A task created as a tombstone is invisible to every view and can never
  // leave `deleted`, so it would be a write-only black hole.
  if (item.status === DELETED_STATUS) {
    return fail('cannot create a task with status deleted; create it, then use action delete');
  }

  const taskCount = context.tasks.filter((task) => task.status !== DELETED_STATUS).length;
  if (taskCount >= context.maxTasks) {
    return fail(`task limit of ${context.maxTasks} reached; delete completed tasks first before creating new tasks`);
  }

  const blockedBy: number[] = [];
  for (const token of item.blockedBy ?? []) {
    const resolved = resolveDep(context, 'blockedBy', token);
    if (!resolved.ok) return fail(resolved.message);
    const dep = context.tasks.find((task) => task.id === resolved.id);
    if (!dep) return fail(`blockedBy: #${resolved.id} not found`);
    if (dep.status === DELETED_STATUS) return fail(`blockedBy: #${resolved.id} is deleted`);
    if (!blockedBy.includes(resolved.id)) blockedBy.push(resolved.id);
  }

  // No cycle check is needed: the id is freshly allocated, so nothing already
  // in the document can point at it yet.
  const created: Task = {
    id: context.nextId,
    subject: item.subject,
    status: item.status ?? 'pending',
    createdAt: now,
    updatedAt: now,
  };
  assignScalars(created, item);
  if (blockedBy.length) created.blockedBy = blockedBy;

  context.nextId += 1;
  context.tasks.push(created);
  if (item.ref) context.refIds.set(item.ref, created.id);

  return {
    ok: true,
    outcome: {
      index,
      kind: 'created',
      id: created.id,
      subject: created.subject,
      status: created.status,
      ...(item.ref ? { ref: item.ref } : {}),
      ...(blockedBy.length ? { blockedBy } : {}),
    },
  };
}

function applyUpdateItem(context: UpsertContext, item: TaskItemMutation, index: number, now: string): ItemResult {
  const id = item.id as number;
  const at = context.tasks.findIndex((task) => task.id === id);
  if (at === -1) return fail(`#${id} not found`);
  if (item.blockedBy !== undefined) {
    return fail('blockedBy is only for a new entry; use addBlockedBy / removeBlockedBy on an entry that has an id');
  }

  const hasMutation =
    item.subject !== undefined ||
    item.description !== undefined ||
    item.activeForm !== undefined ||
    item.status !== undefined ||
    item.owner !== undefined ||
    item.metadata !== undefined ||
    Boolean(item.addBlockedBy?.length) ||
    Boolean(item.removeBlockedBy?.length);
  if (!hasMutation) {
    return fail(
      'nothing to change: provide at least one of subject, description, activeForm, status, owner, metadata, addBlockedBy, or removeBlockedBy',
    );
  }

  const current = context.tasks[at];

  // The Task Space overlay commits free text from an inline editor, so a blank
  // subject reaches the reducer as a real update rather than as a missing
  // field. Persisting it would leave an unidentifiable row.
  if (item.subject !== undefined && !item.subject.trim()) return fail('subject must not be blank');

  let newStatus = current.status;
  if (item.status !== undefined) {
    if (!isTransitionValid(current.status, item.status)) {
      return fail(`illegal transition ${current.status} -> ${item.status}`);
    }
    newStatus = item.status;
  }

  let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
  for (const token of item.removeBlockedBy ?? []) {
    const resolved = resolveDep(context, 'removeBlockedBy', token);
    if (!resolved.ok) return fail(resolved.message);
    // Removing an id that is not there is a well-defined no-op, so unlike the
    // add path this deliberately skips the existence check.
    newBlockedBy = newBlockedBy.filter((dep) => dep !== resolved.id);
  }
  for (const token of item.addBlockedBy ?? []) {
    const resolved = resolveDep(context, 'addBlockedBy', token);
    if (!resolved.ok) return fail(resolved.message);
    if (resolved.id === id) return fail(`cannot block #${id} on itself`);
    const dep = context.tasks.find((task) => task.id === resolved.id);
    if (!dep) return fail(`addBlockedBy: #${resolved.id} not found`);
    if (dep.status === DELETED_STATUS) return fail(`addBlockedBy: #${resolved.id} is deleted`);
    if (!newBlockedBy.includes(resolved.id)) newBlockedBy.push(resolved.id);
  }

  const updated: Task = { ...current, status: newStatus };
  assignScalars(updated, item);
  if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
  else delete updated.blockedBy;

  // The candidate is written before the check because `detectCycle` unions the
  // node's stored edges with the ones passed in: checking against the old array
  // would resurrect an edge `removeBlockedBy` just stripped and reject a
  // remove+add that legitimately breaks a cycle.
  const candidate = [...context.tasks];
  candidate[at] = updated;
  if (item.addBlockedBy?.length && detectCycle(candidate, id, newBlockedBy)) {
    return fail('addBlockedBy would create a cycle in the blockedBy graph');
  }

  const changed = taskChanged(current, updated);
  if (changed) updated.updatedAt = now;
  context.tasks = candidate;

  return {
    ok: true,
    outcome: changed
      ? { index, kind: 'updated', id, fromStatus: current.status, toStatus: newStatus }
      : { index, kind: 'unchanged', id, status: newStatus },
  };
}

/**
 * Apply every entry in request order, threading the document.
 *
 * Each entry lands completely or not at all: a create whose dependencies fail
 * is not kept dependency-free, because handing back an unblocked task the
 * caller asked to be blocked is a lie it may immediately act on.
 */
function applyUpsert(document: TaskDocument, items: TaskItemMutation[], now: string, maxTasks: number): ApplyResult {
  const context: UpsertContext = {
    tasks: [...document.tasks],
    nextId: document.nextId,
    maxTasks,
    refIds: new Map(),
    failedRefs: new Map(),
  };
  const outcomes: UpsertItemOutcome[] = [];
  let applied = 0;

  for (const [index, item] of items.entries()) {
    const shapeError = checkShape(context, item);
    const result = shapeError
      ? fail(shapeError)
      : item.id === undefined
        ? applyCreateItem(context, item, index, now)
        : applyUpdateItem(context, item, index, now);

    if (result.ok) {
      outcomes.push(result.outcome);
      applied += 1;
      continue;
    }
    // A ref whose owner failed must not read as a typo to the entries that
    // depend on it, so the dead ref is recorded rather than left unknown.
    if (item.ref && REF_PATTERN.test(item.ref) && !context.refIds.has(item.ref)) {
      context.failedRefs.set(item.ref, index);
    }
    outcomes.push({
      index,
      kind: 'failed',
      message: result.message,
      ...(item.id === undefined ? {} : { id: item.id }),
      ...(item.ref ? { ref: item.ref } : {}),
    });
  }

  return {
    // Nothing applied means nothing to write: returning the original object by
    // reference keeps the caller's write-skip path identical to a hard error.
    document: applied > 0 ? withTasks(document, context.tasks, context.nextId) : document,
    op: { kind: 'upsert', items: outcomes, applied, failed: outcomes.length - applied },
  };
}

/**
 * Pure reducer: (document, action, params) -> (document, op).
 *
 * All validation is in-line: structural guards plus state-aware checks
 * (transition legality, dangling or deleted blockedBy, self-block, cycles,
 * in-flight delegations). The caller owns persistence and formatting.
 */
export function applyTaskMutation(
  document: TaskDocument,
  action: ReducerAction,
  params: TaskMutationParams,
  now: string = new Date().toISOString(),
  maxTasks = DEFAULT_REDUCER_MAX_TASKS,
): ApplyResult {
  switch (action) {
    case 'upsert': {
      const items = params.tasks;
      if (!Array.isArray(items) || items.length === 0) {
        return errorResult(
          document,
          'upsert requires a non-empty tasks array, e.g. {"action":"upsert","tasks":[{"subject":"Write tests"}]}',
        );
      }
      if (items.length > MAX_UPSERT_ITEMS) {
        return errorResult(
          document,
          `upsert accepts at most ${MAX_UPSERT_ITEMS} entries per call (received ${items.length})`,
        );
      }
      return applyUpsert(document, items, now, maxTasks);
    }

    case 'list': {
      return {
        document,
        op: {
          kind: 'list',
          includeDeleted: params.includeDeleted === true,
          ...(params.status !== undefined ? { statusFilter: params.status } : {}),
        },
      };
    }

    case 'get': {
      if (params.id === undefined) return errorResult(document, 'id required for get');
      const task = document.tasks.find((candidate) => candidate.id === params.id);
      if (!task) return errorResult(document, `#${params.id} not found`);
      return { document, op: { kind: 'get', task } };
    }

    case 'delete': {
      if (params.id === undefined) return errorResult(document, 'id required for delete');
      const index = document.tasks.findIndex((task) => task.id === params.id);
      if (index === -1) return errorResult(document, `#${params.id} not found`);
      const current = document.tasks[index];
      if (current.status === DELETED_STATUS) return errorResult(document, `#${current.id} is already deleted`);
      if (isDelegationActive(current)) {
        return errorResult(document, `#${current.id} has a running delegation — cancel it before deleting`);
      }

      const tasks = [...document.tasks];
      tasks[index] = { ...current, status: DELETED_STATUS, updatedAt: now };
      return {
        document: withTasks(document, tasks),
        op: { kind: 'delete', id: current.id, subject: current.subject },
      };
    }

    case 'clear': {
      const active = document.tasks.filter(isDelegationActive);
      if (active.length > 0) {
        const ids = active.map((task) => `#${task.id}`).join(', ');
        return errorResult(document, `cannot clear while delegations are running (${ids}) — cancel them first`);
      }
      const count = document.tasks.length;
      return {
        document: withTasks(document, [], 1),
        op: { kind: 'clear', count },
      };
    }
  }
}
