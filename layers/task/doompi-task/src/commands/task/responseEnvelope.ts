import type { Op } from '../../services/store/reducer.ts';
import { deriveBlocks, isTaskListComplete } from '../../services/store/taskGraph.ts';
import type {
  AssignmentSummary,
  Task,
  TaskAction,
  TaskDetails,
  TaskDocument,
  TaskMutationParams,
  UpsertItemOutcome,
} from '../../services/store/types.ts';

export const MSG_ALL_COMPLETE_CLEAR =
  'All tasks are completed. Review the full task list once more, then close it with task {"action":"clear"}.';

/**
 * Steering for a mixed batch. Unlike a batch of spawned subagents, a failed
 * entry here had no side effect at all, so retrying the failures is the safe
 * move and the model must be told so or it will do nothing. The hazard is the
 * other half: resending an applied create would make a second task.
 */
export const MSG_UPSERT_PARTIAL =
  'The applied entries are committed. Resend only the failed entries, corrected — a failed entry changed nothing, so a corrected retry is safe. Do not resend an entry that already applied: an entry without an id creates a second task.';

export const MSG_UPSERT_NONE_APPLIED = 'No task changed, so the whole call can be resent once corrected.';

export const MSG_ASSIGN_PARTIAL =
  'Successful assignments are already running. Retry only the failed entries after correcting their task state or arguments; do not resend successful entries.';

export interface AssignmentItemResult {
  index: number;
  id: number;
  agent: string;
  ok: boolean;
  message: string;
}

/** LLM-facing report for a native assignment batch. */
export function formatAssignmentResults(items: readonly AssignmentItemResult[]): string {
  if (items.length === 1) return items[0].message;

  const succeeded = items.filter((item) => item.ok).length;
  const failed = items.length - succeeded;
  const lines = [
    `Assigned ${succeeded}/${items.length} tasks${failed > 0 ? `; ${failed} failed` : ''}.`,
    ...items.map((item) =>
      item.ok
        ? `- [${item.index}] Delegated #${item.id} to ${item.agent}`
        : `- [${item.index}] Failed #${item.id} → ${item.agent}: ${item.message}`,
    ),
  ];

  if (failed > 0 && succeeded > 0) lines.push('', MSG_ASSIGN_PARTIAL);
  if (failed === 0) {
    lines.push(
      '',
      'All assignments are running independently in the background. Continue non-overlapping work, or end your turn.',
    );
  }
  return lines.join('\n');
}

/** `[status] #id subject (activeForm) [agent] ⛓ #dep` — the `list` line format. */
function formatListLine(task: Task): string {
  const block = task.blockedBy?.length ? ` ⛓ ${task.blockedBy.map((id) => `#${id}`).join(',')}` : '';
  const form = task.status === 'in_progress' && task.activeForm ? ` (${task.activeForm})` : '';
  const delegated = task.delegation && task.delegation.state !== 'cancelled' ? ` [${task.delegation.agent}]` : '';
  return `[${task.status}] #${task.id} ${task.subject}${form}${delegated}${block}`;
}

function formatDelegationLines(task: Task): string[] {
  const delegation = task.delegation;
  if (!delegation) return [];

  const lines = [`  delegated to: ${delegation.agent} (${delegation.state})`];
  if (delegation.model) lines.push(`  model: ${delegation.model}`);
  if (delegation.result?.error) lines.push(`  error: ${delegation.result.error}`);
  if (delegation.result?.outputPath) lines.push(`  output file: ${delegation.result.outputPath}`);
  if (delegation.result?.output) lines.push(`  output: ${delegation.result.output}`);
  return lines;
}

function formatGetLines(task: Task, document: TaskDocument): string {
  const blocks = deriveBlocks(document.tasks).get(task.id) ?? [];
  const lines = [`#${task.id} [${task.status}] ${task.subject}`];
  if (task.description) lines.push(`  description: ${task.description}`);
  if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
  if (task.blockedBy?.length) lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(', ')}`);
  if (blocks.length) lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(', ')}`);
  if (task.owner) lines.push(`  owner: ${task.owner}`);
  lines.push(...formatDelegationLines(task));
  return lines.join('\n');
}

/** One entry's outcome. Batch lines prefix this with `- [n] `. */
function formatUpsertItem(item: UpsertItemOutcome): string {
  switch (item.kind) {
    case 'created': {
      const ref = item.ref ? ` (ref "${item.ref}")` : '';
      const deps = item.blockedBy?.length ? ` — blocked by ${item.blockedBy.map((id) => `#${id}`).join(', ')}` : '';
      return `Created #${item.id}${ref}: ${item.subject} (${item.status})${deps}`;
    }
    case 'updated': {
      const transition = item.fromStatus === item.toStatus ? '' : ` (${item.fromStatus} -> ${item.toStatus})`;
      return `Updated #${item.id}${transition}`;
    }
    case 'unchanged':
      return `No change: #${item.id} already matches the requested values (status: ${item.status})`;
    case 'failed':
      return `Failed${item.id === undefined ? '' : ` #${item.id}`}: ${item.message}`;
  }
}

/**
 * The thrown message when an upsert applied nothing. Kept separate from
 * `formatContent` because the caller wraps it in the actionable Options block
 * rather than returning it as a successful result.
 */
export function formatUpsertFailureText(op: Extract<Op, { kind: 'upsert' }>): string {
  if (op.items.length === 1) return op.items[0].kind === 'failed' ? op.items[0].message : 'no entry was applied';
  return [
    'no entry was applied.',
    ...op.items.map((item) => `- [${item.index}] ${formatUpsertItem(item)}`),
    MSG_UPSERT_NONE_APPLIED,
  ].join('\n');
}

/**
 * Pure formatter: `(op, document) -> string`. The switch is closed over `Op`,
 * so a new reducer variant fails to compile until it is handled here.
 */
export function formatContent(op: Op, document: TaskDocument): string {
  switch (op.kind) {
    case 'upsert': {
      // A batch of one is the common case and must not read like a bulk
      // report, so it keeps the exact single-line shape it has always had.
      const lines =
        op.items.length === 1
          ? [formatUpsertItem(op.items[0])]
          : [
              `Upsert applied ${op.applied}/${op.items.length} entries${op.failed > 0 ? `; ${op.failed} failed` : ''}.`,
              ...op.items.map((item) => `- [${item.index}] ${formatUpsertItem(item)}`),
              ...(op.failed > 0 ? ['', MSG_UPSERT_PARTIAL] : []),
            ];
      // Once, last, and only when something landed: emitting it per entry
      // would repeat it for every completion in a batch.
      if (op.applied > 0 && isTaskListComplete(document.tasks)) lines.push(MSG_ALL_COMPLETE_CLEAR);
      return lines.join('\n');
    }
    case 'delete':
      return `Deleted #${op.id}: ${op.subject}`;
    case 'clear':
      return `Closed task list (cleared ${op.count} tasks)`;
    case 'list': {
      let view = document.tasks;
      if (!op.includeDeleted) view = view.filter((task) => task.status !== 'deleted');
      if (op.statusFilter) view = view.filter((task) => task.status === op.statusFilter);
      return view.length === 0 ? 'No tasks' : view.map(formatListLine).join('\n');
    }
    case 'get':
      return formatGetLines(op.task, document);
    case 'error':
      return `Error: ${op.message}`;
  }
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: TaskDetails;
}

/** Build the LLM-facing envelope. `details` carries the post-mutation snapshot. */
export function buildToolResult(
  action: TaskAction,
  params: TaskMutationParams,
  document: TaskDocument,
  op: Op,
): ToolResult {
  return {
    content: [{ type: 'text', text: formatContent(op, document) }],
    details: {
      action,
      params: params as Record<string, unknown>,
      tasks: document.tasks,
      nextId: document.nextId,
      rev: document.rev,
      ...(op.kind === 'error' ? { error: op.message } : {}),
      // Deliberately no `error` on a partial success: renderResult treats
      // `details.error` as total failure and would hide the rows for the
      // entries that did land.
      ...(op.kind === 'upsert'
        ? {
            upsert: {
              applied: op.items.flatMap((item) => (item.kind === 'failed' ? [] : [item.id])),
              failed: op.failed,
            },
          }
        : {}),
    },
  };
}

/** Envelope for a native assignment batch, including ids used by the consolidated TUI result. */
export function buildAssignmentResult(
  params: TaskMutationParams,
  document: TaskDocument,
  text: string,
  assignment: AssignmentSummary,
): ToolResult {
  return {
    content: [{ type: 'text', text }],
    details: {
      action: 'assign',
      params: params as Record<string, unknown>,
      tasks: document.tasks,
      nextId: document.nextId,
      rev: document.rev,
      assignment,
    },
  };
}

/** Envelope for delegation actions, which do not flow through the reducer. */
export function buildTextResult(
  action: TaskAction,
  params: TaskMutationParams,
  document: TaskDocument,
  text: string,
  error?: string,
): ToolResult {
  return {
    content: [{ type: 'text', text: error ? `Error: ${error}` : text }],
    details: {
      action,
      params: params as Record<string, unknown>,
      tasks: document.tasks,
      nextId: document.nextId,
      rev: document.rev,
      ...(error ? { error } : {}),
    },
  };
}
