/**
 * This session's code change against its base, and the manual sync beside it.
 *
 * DESIGN PATTERNS:
 * - Its own session store and hub channel, apart from worktrees. Worktrees are
 *   repository management; this is the session's diff.
 * - The hub is authoritative: it computes the counts, runs pull, push and
 *   rebase one at a time, and reports pending, errors and a paused rebase here.
 * - The sender lives in a store rather than a module variable, because a web
 *   plugin keeps no mutable module state and the page may reconnect.
 *
 * AVOID:
 * - `sendSessionFrame` for a sync command. That frame is bound for the agent
 *   and never reaches a channel's `receive`.
 */
import { defineGlobalStore, defineSessionStore, type WebPluginRuntime } from '@agimon-ai/doompi-core/web';

import {
  GIT_CHANGES_TYPE,
  type GitChangesCommand,
  type GitChangesView,
  type GitSyncAction,
  type GitSyncErrorTarget,
} from '../../../../../types/gitReview';

export interface GitChangesSession {
  /** Absent until the hub reports, and outside a git checkout. */
  changes: GitChangesView | undefined;
  pending: string | undefined;
  error: string | undefined;
  errorTarget: GitSyncErrorTarget | undefined;
}

export const gitChanges = defineSessionStore<GitChangesSession>({
  changes: undefined,
  pending: undefined,
  error: undefined,
  errorTarget: undefined,
});

/** The page's hub socket sender; undefined before start and after dispose, when a command is dropped. */
const changesSender = defineGlobalStore<WebPluginRuntime['sendHubFrame'] | undefined>(undefined);

/** Binds the page's hub socket for sync commands. The plugin host calls this once per page. */
export function startGitChangesRuntime(runtime: WebPluginRuntime): () => void {
  const send = (frame: Record<string, unknown>): void => {
    runtime.sendHubFrame(frame);
  };
  changesSender.update(() => send);
  return () => {
    changesSender.update((current) => (current === send ? undefined : current));
  };
}

/** Whether a sync command is running for this session. */
export const gitChangesActivitySource = {
  subscribe(listener: () => void) {
    const subscription = gitChanges.store.subscribe(listener);
    return () => subscription.unsubscribe();
  },
  isActive(sessionId: string | null) {
    return gitChanges.select(gitChanges.store.state, sessionId).pending !== undefined;
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The page never trusts a frame's shape: a malformed field drops, the rest still renders. */
const MAX_CONFLICTS = 100;

function optionalChanges(value: unknown): GitChangesView | undefined {
  if (!isRecord(value)) return undefined;
  const added = count(value.added);
  const removed = count(value.removed);
  const files = count(value.files);
  if (added === undefined || removed === undefined || files === undefined) return undefined;
  const branch = optionalText(value.branch);
  const base = optionalText(value.base);
  const upstream = isRecord(value.upstream) ? value.upstream : undefined;
  const ahead = count(upstream?.ahead);
  const behind = count(upstream?.behind);
  const upstreamRef = optionalText(upstream?.ref);
  const conflicts =
    isRecord(value.rebase) && Array.isArray(value.rebase.conflicts)
      ? value.rebase.conflicts.filter((file): file is string => typeof file === 'string').slice(0, MAX_CONFLICTS)
      : undefined;
  return {
    added,
    removed,
    files,
    ...(branch === undefined ? {} : { branch }),
    ...(base === undefined ? {} : { base }),
    ...(value.truncated === true ? { truncated: true } : {}),
    ...(upstreamRef === undefined || ahead === undefined || behind === undefined
      ? {}
      : { upstream: { ref: upstreamRef, ahead, behind } }),
    ...(conflicts === undefined ? {} : { rebase: { conflicts } }),
  };
}

function optionalErrorTarget(value: unknown): GitSyncErrorTarget | undefined {
  if (!isRecord(value)) return undefined;
  if (value.action === 'pull' || value.action === 'rebase' || value.action === 'abort-rebase')
    return { action: value.action };
  if (value.action === 'push')
    return value.forceRequired === true ? { action: 'push', forceRequired: true } : { action: 'push' };
  return undefined;
}

/** The session data channel: 'git_changes' payloads into the store. */
export const gitChangesChannel = gitChanges.channel<GitChangesSession>({
  channel: GIT_CHANGES_TYPE,
  parse(input) {
    if (!isRecord(input)) return null;
    return {
      changes: optionalChanges(input.changes),
      pending: optionalText(input.pending),
      error: optionalText(input.error),
      errorTarget: optionalErrorTarget(input.errorTarget),
    };
  },
  reduce(_current, next) {
    return next;
  },
});

/**
 * Asks the hub to pull, push, rebase or abort a paused rebase. `force` is only
 * ever sent after the reader confirmed a lease force for a rejected push.
 */
export function requestGitSync(sessionId: string, action: GitSyncAction, force = false): void {
  const payload: GitChangesCommand = action === 'push' && force ? { action: 'push', force: true } : { action };
  changesSender.store.state?.({ type: GIT_CHANGES_TYPE, sessionId, payload });
}
