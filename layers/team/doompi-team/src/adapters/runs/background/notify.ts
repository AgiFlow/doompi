/**
 * Formats a run's terminal result into a completion notification and hands
 * it to `ResultWatcher` as its `ResultConsumer`, batching successful
 * completions and bypassing that batching for anything that needs the
 * operator's attention right away.
 *
 * WHY `completion-dedupe.ts` IS NOT PORTED:
 * The predecessor deduped completion notifications with its own TTL-keyed
 * map (`completion-dedupe.ts`), independently of the identically-shaped TTL
 * dedupe `resultWatcher.ts` already does before it ever calls a consumer.
 * Those two copies could disagree - the exact bug class `resultWatcher.ts`'s
 * header now documents fixing. This package has exactly one producer of
 * completions today: `ResultWatcher`, which only calls its consumer once per
 * `runId` per TTL window. `CompletionNotifier.deliver()` is that consumer, so
 * it trusts that guarantee instead of re-implementing it. The predecessor
 * needed its own copy because it had two independent producers (async result
 * files AND a synchronous foreground-run event); this package is async-only
 * (see `spawnHandshake.ts`'s header) and has not ported foreground runs. IF
 * a second completion producer is added later, `deliver()` can no longer
 * assume `ResultWatcher` already deduped for it, and this module will need
 * its own dedupe again at that point - not before.
 *
 * DESIGN PATTERNS:
 * - `deliver()` matches `ResultConsumer`'s exact shape
 *   (`(result: RunResultFile) => boolean | Promise<boolean>`), so this class
 *   is meant to be registered directly as `ResultWatcher`'s consumer, not
 *   subscribed to a separate event bus the way the predecessor's notifier
 *   subscribed to two
 * - Batching (`completionBatcher.ts`) only ever holds a *successful*
 *   completion. A failure or a pause is exactly the situation batching's
 *   debounce would otherwise delay reporting, so those flush whatever is
 *   already held for the same group and emit immediately, unbatched
 * - One batcher per group key (by `sessionId`, falling back to `cwd`, then a
 *   shared `'unknown'` bucket), created lazily and kept for the process
 *   lifetime: siblings of the same run share a group, unrelated runs never
 *   hold each other up
 * - `deliver()`'s returned promise resolves only once the item's group
 *   actually emits (immediately for a bypass, after the batcher's debounce
 *   for a grouped success). `ResultWatcher` awaits this before deciding
 *   whether to release the claim, so a claim legitimately stays in flight for
 *   as long as its group is held open - that is intended, not a stall
 *
 * WHY `sendMessage` IS INERT UNTIL A HOST IS ATTACHED:
 * The host channel arrives at runtime, not at construction: this is a
 * container singleton, and the `ExtensionAPI` that owns the chat surface only
 * exists once `extensions/pi.ts` is activated. `attachHost` is what closes
 * that gap, and until it is called - in the runner child, in a test, or in
 * any process with no TUI - returning `false` rather than claiming success is
 * deliberate. It is the honest answer ("this was not actually shown to
 * anyone"), and it is what lets `ResultWatcher`'s retry keep the claim around
 * to be flushed later instead of dropping the completion on the floor.
 *
 * AVOID:
 * - Reintroducing a dedupe map here "just in case"; see the header note above
 * - Calling `batcher.push()` for anything whose status is not `'completed'`
 */

import {
  type CompletionBatchConfig,
  type CompletionBatcher,
  createCompletionBatcher,
  resolveCompletionBatchConfig,
} from './completionBatcher';
import type { RunResultFile } from '../../resultWatcher';

export type CompletionStatus = 'completed' | 'failed' | 'paused';

const EMPTY_OUTPUT = '(no output)';
const UNKNOWN_VALUE = 'unknown';
const RECENT_TRANSCRIPT_LINES = 80;
const SINGLE_SUCCESS_ACTION = 'Handle this result now: incorporate it, reject it with a reason, or mark it irrelevant.';
const GROUPED_SUCCESS_ACTION =
  'Handle each result now: incorporate it, reject it with a reason, or mark it irrelevant.';

/** What a completion actually renders as, independent of the raw result shape. */
export interface CompletionNotifyDetails {
  agent: string;
  /**
   * The run this completion belongs to.
   *
   * Load-bearing, not decoration: a completion is the ONLY message the model
   * gets when a background run ends, and every follow-up it might want -
   * `{action:'status', id}`, `steer`, `resume`, tailing a transcript - is
   * keyed by run id. Without it the model has to re-list every run and guess
   * which one just finished, which is exactly the wasted turn the sibling
   * implementation avoids by putting `<task-id>` in its own notification.
   */
  runId: string;
  status: CompletionStatus;
  resultPreview: string;
  taskInfo?: string;
  durationMs?: number;
  sessionLabel?: string;
  sessionValue?: string;
  handoffPath?: string;
}

/**
 * Return the one next action justified by this result. A usable summary should
 * be handled directly. Transcript recovery is reserved for missing or
 * insufficient output, and every example matches the strict status schema.
 */
function completionAction(details: CompletionNotifyDetails): string {
  const hasPreview = details.resultPreview.trim().length > 0;
  const transcriptRequest = `{ action: "status", id: "${details.runId}", transcriptLines: ${RECENT_TRANSCRIPT_LINES} }`;
  if (details.status === 'completed') {
    return hasPreview
      ? SINGLE_SUCCESS_ACTION
      : `No summary was produced. Inspect recent output with ${transcriptRequest} before handling this result.`;
  }
  if (details.status === 'paused') {
    return `Run is paused. Inspect it with { action: "status", id: "${details.runId}" }, then restore it only if status reports it as resumable.`;
  }
  return hasPreview
    ? `Use the failure summary first. If it does not explain the failure, inspect recent output with ${transcriptRequest}.`
    : `No failure summary was produced. Inspect recent output with ${transcriptRequest}.`;
}

function formatSessionLine(details: CompletionNotifyDetails): string | undefined {
  if (!details.sessionValue) return undefined;
  return details.sessionLabel ? `${details.sessionLabel}: ${details.sessionValue}` : details.sessionValue;
}

export function formatSingleCompletion(details: CompletionNotifyDetails): string {
  const sessionLine = formatSessionLine(details);
  return [
    `Background task ${details.status}: **${details.agent}**${details.taskInfo ?? ''}`,
    `run id: ${details.runId}`,
    '',
    details.resultPreview.trim() ? details.resultPreview : EMPTY_OUTPUT,
    details.handoffPath ? '' : undefined,
    details.handoffPath ? `Parallel handoff: ${details.handoffPath}` : undefined,
    sessionLine ? '' : undefined,
    sessionLine,
    '',
    completionAction(details),
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

export function formatGroupedCompletion(details: CompletionNotifyDetails[]): string {
  const header = `Background tasks completed (${details.length}): ${details.map((d) => `**${d.agent}**${d.taskInfo ?? ''}`).join(', ')}`;
  const blocks: string[] = [header, ''];
  for (let index = 0; index < details.length; index++) {
    const detail = details[index];
    if (!detail) continue;
    const sessionLine = formatSessionLine(detail);
    const hasPreview = detail.resultPreview.trim().length > 0;
    blocks.push(`${index + 1}. ${detail.agent}${detail.taskInfo ?? ''} - run id: ${detail.runId}`);
    blocks.push(hasPreview ? detail.resultPreview : EMPTY_OUTPUT);
    if (detail.handoffPath) blocks.push(`Parallel handoff: ${detail.handoffPath}`);
    if (sessionLine) blocks.push(sessionLine);
    if (!hasPreview) blocks.push(completionAction(detail));
    blocks.push('');
  }
  blocks.push(GROUPED_SUCCESS_ACTION);
  return blocks.join('\n').trimEnd();
}

/** Narrow an opaque `RunResultFile` field to a string, the same defensive read used throughout. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function completionGroupKey(result: RunResultFile): string {
  const sessionId = asString(result.sessionId)?.trim();
  if (sessionId) return `session:${sessionId}`;
  const cwd = asString(result.cwd)?.trim();
  return cwd ? `cwd:${cwd}` : UNKNOWN_VALUE;
}

/** Turn a raw, opaque result record into what `formatSingleCompletion`/`formatGroupedCompletion` render. */
export function buildCompletionDetails(result: RunResultFile): CompletionNotifyDetails {
  const agent = asString(result.agent) ?? UNKNOWN_VALUE;
  const summary = asString(result.summary) ?? '';
  const success = typeof result.success === 'boolean' ? result.success : undefined;
  const state = asString(result.state);
  const paused = success === false && (state === 'paused' || summary.startsWith('Paused after interrupt.'));
  const status: CompletionStatus = paused ? 'paused' : success === false ? 'failed' : 'completed';

  const taskIndex = asNumber(result.taskIndex);
  const totalTasks = asNumber(result.totalTasks);
  const taskInfo =
    taskIndex !== undefined && totalTasks !== undefined ? ` (${taskIndex + 1}/${totalTasks})` : undefined;

  const parallelHandoff =
    typeof result.parallelHandoff === 'object' && result.parallelHandoff !== null
      ? (result.parallelHandoff as { path?: unknown })
      : undefined;
  const handoffPath = asString(parallelHandoff?.path);

  const shareUrl = asString(result.shareUrl);
  const shareError = asString(result.shareError);
  const sessionFile = asString(result.sessionFile);
  const session = shareUrl
    ? { label: 'Session', value: shareUrl }
    : shareError
      ? { label: 'Session share error', value: shareError }
      : sessionFile
        ? { label: 'Session file', value: sessionFile }
        : undefined;

  return {
    agent,
    // `RunResultFile` guarantees `runId` (see `resultWatcher.ts`), so there is
    // no honest fallback to invent here - an empty string would be a run id the
    // model could not use, dressed up as one it could.
    runId: result.runId,
    status,
    resultPreview: summary,
    ...(taskInfo ? { taskInfo } : {}),
    ...(asNumber(result.durationMs) !== undefined ? { durationMs: asNumber(result.durationMs) } : {}),
    ...(handoffPath ? { handoffPath } : {}),
    ...(session ? { sessionLabel: session.label, sessionValue: session.value } : {}),
  };
}

interface PendingCompletion {
  details: CompletionNotifyDetails;
  triggerTurn: boolean;
  resolve(delivered: boolean): void;
}

/**
 * The host capability this notifier needs, narrowed to the one method it
 * calls. Structural rather than `ExtensionAPI` itself so the runs domain does
 * not take a dependency on the host type for a single call, and so a test can
 * supply a recorder without constructing a whole extension API.
 */
export interface CompletionNotifyHost {
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: CompletionNotifyDetails[] },
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' },
  ): void;
}

export type CompletionNotifierContract = {
  /** Matches `ResultConsumer` exactly; register this directly with `ResultWatcher.start()`. */
  deliver(result: RunResultFile): Promise<boolean>;
  /**
   * Give the notifier the host channel to render into. Called by the parent
   * composition root (`extensions/pi.ts`); until it is, `sendMessage` stays
   * inert and honestly reports non-delivery - see the module header.
   */
  attachHost(host: CompletionNotifyHost): void;
  /** Flush every held batch immediately (unemitted items resolve `false`) and stop accepting new ones. */
  dispose(): void;
};

/**
 * The custom-message type the parent renders completions under. Cross-process
 * significant in the same way the nested-event tokens are: the child-side
 * prompt runtime strips messages of this type out of a child's inherited
 * history (`stripParentOnlySubagentMessages`), so the two sides must agree on
 * the literal.
 */
export const SUBAGENT_NOTIFY_MESSAGE_TYPE = 'subagent-notify';

export class CompletionNotifier implements CompletionNotifierContract {
  /**
   * Runtime tuning seam for tests, kept out of the dependency constructor.
   */
  protected readonly batchConfig: CompletionBatchConfig | undefined = undefined;

  private readonly batchers = new Map<string, CompletionBatcher<PendingCompletion>>();
  private disposed = false;
  private host: CompletionNotifyHost | undefined;

  /**
   * Last host attachment wins. A reload that rebuilds the extension against a
   * fresh `ExtensionAPI` re-attaches rather than stacking channels, matching
   * how every other registration in `extensions/pi.ts` is idempotent.
   */
  attachHost(host: CompletionNotifyHost): void {
    this.host = host;
  }

  /**
   * Deliver a formatted completion message. Inert until `attachHost` supplies
   * a host (see the module header for why non-delivery is reported honestly
   * rather than optimistically). Not `async`: `emit()` below does not await it
   * either way - see its doc comment for why.
   *
   * A throw from the host is caught and reported as non-delivery rather than
   * propagated: `emit()` is a batcher callback running on a timer with no
   * caller to catch for it, and a failed render must leave `ResultWatcher`'s
   * claim in place for a retry, which is exactly what `false` does.
   */
  protected sendMessage(
    content: string,
    options: { triggerTurn: boolean; details: CompletionNotifyDetails[] },
  ): boolean {
    if (!this.host) return false;
    try {
      this.host.sendMessage(
        { customType: SUBAGENT_NOTIFY_MESSAGE_TYPE, content, display: true, details: options.details },
        { triggerTurn: options.triggerTurn, deliverAs: 'steer' },
      );
      return true;
    } catch {
      return false;
    }
  }

  async deliver(result: RunResultFile): Promise<boolean> {
    if (result.internal === true) return true;
    if (this.disposed) return false;
    const details = buildCompletionDetails(result);
    const triggerTurn = result.triggerTurn !== false;

    return new Promise<boolean>((resolve) => {
      const item: PendingCompletion = { details, triggerTurn, resolve };
      const batcher = this.getBatcher(result);
      if (details.status !== 'completed') {
        // A failure or a pause must not sit behind a debounce meant for
        // grouping good news; flush whatever this group was already holding,
        // then emit this one immediately, unbatched.
        batcher.flush();
        this.emit([item]);
        return;
      }
      batcher.push(item);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const batcher of this.batchers.values()) {
      for (const item of batcher.dispose()) item.resolve(false);
    }
    this.batchers.clear();
  }

  private getBatcher(result: RunResultFile): CompletionBatcher<PendingCompletion> {
    const key = completionGroupKey(result);
    let batcher = this.batchers.get(key);
    if (!batcher) {
      batcher = createCompletionBatcher<PendingCompletion>({
        config: resolveCompletionBatchConfig(this.batchConfig),
        emit: (items) => this.emit(items),
      });
      this.batchers.set(key, batcher);
    }
    return batcher;
  }

  /**
   * The batcher's `emit` callback: format the group (single vs. grouped
   * rendering, `formatSingleCompletion`/`formatGroupedCompletion`) and hand
   * it to `sendMessage`. Deliberately not `async` and does not await
   * `sendMessage`: `createCompletionBatcher`'s `emit` option is a synchronous
   * callback (see its own contract), and every item's promise still resolves
   * correctly here regardless, since `sendMessage`'s result is available
   * synchronously to whichever implementation is active.
   */
  private emit(items: PendingCompletion[]): void {
    if (items.length === 0) return;
    const details = items.map((item) => item.details);
    const content = details.length === 1 ? formatSingleCompletion(details[0]!) : formatGroupedCompletion(details);
    const delivered = this.sendMessage(content, {
      triggerTurn: items.some((item) => item.triggerTurn),
      details,
    });
    for (const item of items) item.resolve(delivered);
  }
}
