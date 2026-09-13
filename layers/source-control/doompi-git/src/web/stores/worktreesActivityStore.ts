/**
 * The dock's view of this session's worktrees, and the commands it sends.
 *
 * DESIGN PATTERNS:
 * - Session-scoped store fed by one hub channel. The hub is authoritative; the
 *   page never reads a registry and never guesses.
 * - Actions are channel frames, not prompts. The hub half owns the tool's
 *   operations, so the panel names the work and the hub performs it; a
 *   worktree made from the dock is the same object the tool makes, without
 *   spending a turn of the conversation to ask for it.
 * - The sender lives in a store rather than a module variable, because a web
 *   plugin keeps no mutable module state and the page may reconnect.
 *
 * AVOID:
 * - Calling the hub package API from here. A dock slot gets no sealed request
 *   transport, and raw fetch breaks the remote cockpit.
 * - `sendSessionFrame` for a command. It envelopes the frame as a session
 *   command bound for the agent, which never reaches a channel's `receive`.
 */
import { defineGlobalStore, defineSessionStore, type WebPluginRuntime } from '@agimon-ai/doompi-core/web';

import { GIT_WORKTREES_TYPE, type GitWorktreesCommand, type WorktreeView } from '../../types/webWorktrees';

export interface WorktreesSession {
  /** The worktrees the hub last reported for this session's repository. */
  worktrees: WorktreeView[];
  /** Label of the operation the hub is running for this session. */
  pending: string | undefined;
  /** The last failure the hub reported, shown until the next command. */
  error: string | undefined;
}

export const worktreeActivity = defineSessionStore<WorktreesSession>({
  worktrees: [],
  pending: undefined,
  error: undefined,
});

/**
 * The page's hub socket sender, held for as long as the plugin runs.
 *
 * Undefined before `startWorktreeRuntime` and after it disposes; a command
 * sent in that window is dropped rather than queued, because a queue would
 * replay a worktree create against a socket that has since changed sessions.
 */
const worktreeSender = defineGlobalStore<WebPluginRuntime['sendHubFrame'] | undefined>(undefined);

/** Binds the page's hub socket. The plugin host calls this once per page. */
export function startWorktreeRuntime(runtime: WebPluginRuntime): () => void {
  // Wrapped rather than referenced: an unbound method would lose the runtime
  // it belongs to the moment the store hands it back.
  const send = (frame: Record<string, unknown>): void => {
    runtime.sendHubFrame(frame);
  };
  worktreeSender.update(() => send);
  return () => {
    worktreeSender.update((current) => (current === send ? undefined : current));
  };
}

/**
 * Whether this session has worktree work in flight.
 *
 * A standing worktree is state, not work: it sits there until someone closes
 * it, so counting it would leave the session reading as busy forever, with a
 * "background work is still running" notice under a conversation where
 * nothing is running. Only a create or close actually in progress counts.
 *
 * The group stays visible either way. Declaring an active source at all is
 * what keeps it in the dock; this answers how it is drawn, not whether it is
 * there.
 */
export const worktreeActivitySource = {
  subscribe(listener: () => void) {
    const subscription = worktreeActivity.store.subscribe(listener);
    return () => subscription.unsubscribe();
  },
  isActive(sessionId: string | null) {
    return worktreeActivity.select(worktreeActivity.store.state, sessionId).pending !== undefined;
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The plugin's session data channel: 'git_worktrees' payloads into the store. */
export const worktreesChannel = worktreeActivity.channel<WorktreesSession>({
  channel: GIT_WORKTREES_TYPE,
  parse(input) {
    if (!isRecord(input) || !Array.isArray(input.worktrees)) return null;
    return {
      worktrees: input.worktrees.filter(isRecord) as unknown as WorktreeView[],
      pending: optionalText(input.pending),
      error: optionalText(input.error),
    };
  },
  reduce(_current, next) {
    return next;
  },
});

/** Sends one command to the session's worktrees channel. */
function command(sessionId: string, payload: GitWorktreesCommand): void {
  worktreeSender.store.state?.({ type: GIT_WORKTREES_TYPE, sessionId, payload });
}

/** Asks the hub for a worktree. The hub answers on the same channel. */
export function requestWorktreeCreate(sessionId: string, branch: string, baseRef: string): void {
  const trimmedBase = baseRef.trim();
  command(sessionId, {
    action: 'create',
    branch: branch.trim(),
    ...(trimmedBase === '' ? {} : { baseRef: trimmedBase }),
  });
}

/** Asks the hub to close one worktree. Refusal on a dirty tree stays the hub's call. */
export function requestWorktreeClose(sessionId: string, id: string): void {
  command(sessionId, { action: 'close', id });
}
