/**
 * The dock's view of this session's worktrees.
 *
 * DESIGN PATTERNS:
 * - Session-scoped store fed by one hub channel. The hub is authoritative; the
 *   page never reads a registry and never guesses.
 * - Actions are prompts, the same route the runner's launcher takes. The agent
 *   owns the tool, so the panel asks for the work rather than performing it,
 *   and a worktree made from the dock is indistinguishable from one the agent
 *   made on its own.
 *
 * AVOID:
 * - Calling the hub package API from here. A dock slot gets no sealed request
 *   transport, and raw fetch breaks the remote cockpit.
 */
import { defineSessionStore, type SessionFrameSender } from '@agimon-ai/doompi-web-contracts';
import { GIT_WORKTREES_TYPE, type WorktreeView } from '../../types/webWorktrees.ts';

export interface WorktreesSession {
  /** The worktrees the hub last reported for this session's repository. */
  worktrees: WorktreeView[];
}

export const worktreeActivity = defineSessionStore<WorktreesSession>({ worktrees: [] });

/**
 * Keeps the group visible whenever this repository has worktrees.
 *
 * A worktree is standing state, not a burst of work: it stays until someone
 * closes it, so its presence is what the dock reports.
 */
export const worktreeActivitySource = {
  subscribe(listener: () => void) {
    const subscription = worktreeActivity.store.subscribe(listener);
    return () => subscription.unsubscribe();
  },
  isActive(sessionId: string | null) {
    return worktreeActivity.select(worktreeActivity.store.state, sessionId).worktrees.length > 0;
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The plugin's session data channel: 'git_worktrees' payloads into the store. */
export const worktreesChannel = worktreeActivity.channel<WorktreesSession>({
  channel: GIT_WORKTREES_TYPE,
  parse(input) {
    if (!isRecord(input) || !Array.isArray(input.worktrees)) return null;
    return { worktrees: input.worktrees.filter(isRecord) as unknown as WorktreeView[] };
  },
  reduce(_current, next) {
    return next;
  },
});

/** Asks the agent for a worktree, through the tool it already owns. */
export function requestWorktreeCreate(
  send: SessionFrameSender,
  sessionId: string,
  branch: string,
  baseRef: string,
): void {
  const base = baseRef.trim() === '' ? '' : ` from ${baseRef.trim()}`;
  send(sessionId, {
    type: 'prompt',
    message: `Create a git worktree on branch ${branch.trim()}${base} using the run_worktree tool.`,
  });
}

/** Asks the agent to close one worktree. Refusal on a dirty tree stays the tool's call. */
export function requestWorktreeClose(send: SessionFrameSender, sessionId: string, id: string): void {
  send(sessionId, {
    type: 'prompt',
    message: `Close the git worktree ${id} using the run_worktree tool.`,
  });
}
