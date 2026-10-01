import type { SessionFrameSender } from '@agimon-ai/doompi-core/web';

/**
 * Pure wording for what the review tab sends the agent, and the one send.
 *
 * Both messages go as `enqueue_automatic`: the host stores it and starts a turn
 * at once when the agent is idle, or after the current one. A `prompt` frame
 * instead fails while a turn runs, and a review lost to that is the worst kind
 * of lost work.
 */

/** The opening line of a review, naming what was reviewed. */
export function reviewHeading(count: number, branch: string | undefined, base: string | undefined): string {
  const what = branch === undefined ? 'this checkout' : `branch ${branch}`;
  const against = base === undefined ? 'its uncommitted changes' : `its changes against ${base}`;
  const comments = count === 1 ? 'one review comment' : `${String(count)} review comments`;
  const address = count === 1 ? 'Please address it.' : 'Please address them all.';
  return `I reviewed ${what} (${against}) and left ${comments}. ${address}`;
}

/** What "ask agent to resolve" sends: the files, and the steps that finish a paused rebase. */
export function conflictPrompt(branch: string | undefined, conflicts: readonly string[]): string {
  const files =
    conflicts.length === 0 ? '- (git reports no unmerged paths yet)' : conflicts.map((file) => `- ${file}`).join('\n');
  return [
    `A rebase of ${branch ?? 'this checkout'} stopped on conflicts in:`,
    '',
    files,
    '',
    'Please resolve them:',
    '1. Fix the conflict markers in each file, keeping the intent of both sides.',
    '2. `git add` each resolved file.',
    '3. Run `GIT_EDITOR=true git rebase --continue`, and repeat if it stops again.',
    '',
    'Do not push. I will push from the cockpit once the rebase is done.',
  ].join('\n');
}

/**
 * Hands one message to the session's queue. Returns the reason it failed, or
 * undefined once the host took it. The sender throws when the session is not
 * connected, which is the only failure a caller can still act on.
 */
export function deliverToAgent(send: SessionFrameSender, sessionId: string, message: string): string | undefined {
  try {
    send(sessionId, { type: 'enqueue_automatic', message });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'The session did not take the message.';
  }
}
