/**
 * The worktrees data channel.
 *
 * DESIGN PATTERNS:
 * - Hub-scoped: it reads this machine's registry files, which a browser cannot.
 *   One entry per session, keyed by the repository that session sits in, so two
 *   sessions in the same checkout see the same list.
 * - Poll, do not watch. The registry is a single small JSON file written by
 *   this package alone, and a watcher on a path that may not exist yet costs
 *   more than re-reading a few hundred bytes.
 * - Publish only what the dock renders. Paths and provenance stay in the
 *   registry; the page gets a view.
 *
 * AVOID:
 * - Throwing out of a poll. A registry that cannot be read is an empty list,
 *   never a broken channel: the dock degrades to "no worktrees", which is the
 *   truth as far as the page can tell.
 */
import type { HubChannelSource, WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import { GIT_WORKTREES_TYPE, type WorktreeView } from '../../types/webWorktrees.ts';
import { registryFile } from '../filesystem/paths.ts';
import { createWorktreeRegistry } from '../worktree/worktreeRegistry.ts';

/** How often a session's registry is re-read. Worktrees change by hand, not by the second. */
const POLL_MS = 4000;

function viewsFor(cwd: string): WorktreeView[] {
  try {
    return createWorktreeRegistry(registryFile(cwd))
      .list()
      .map((record) => ({
        id: record.id,
        branch: record.branch,
        path: record.path,
        sessionId: record.status === 'orphaned' ? null : record.sessionId,
        orphaned: record.status === 'orphaned',
      }));
  } catch {
    return [];
  }
}

function sameList(left: readonly WorktreeView[], right: readonly WorktreeView[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      entry.id === other.id &&
      entry.branch === other.branch &&
      entry.sessionId === other.sessionId &&
      entry.orphaned === other.orphaned
    );
  });
}

/**
 * One poller per managed session, publishing only when the list actually
 * changed so an idle cockpit stays quiet.
 */
export function createWorktreesChannel(intervalMs: number = POLL_MS): WebHubChannel {
  return {
    frameType: GIT_WORKTREES_TYPE,
    start(host) {
      const latest = new Map<string, WorktreeView[]>();
      const timers = new Map<string, ReturnType<typeof setInterval>>();
      const source: HubChannelSource = {
        payloadFor(scope) {
          const worktrees = latest.get(scope.sessionId);
          return worktrees === undefined ? undefined : { worktrees };
        },
        sessionAdded(scope) {
          const publish = (): void => {
            const worktrees = viewsFor(scope.cwd);
            const previous = latest.get(scope.sessionId);
            if (previous !== undefined && sameList(previous, worktrees)) return;
            latest.set(scope.sessionId, worktrees);
            host.publish(scope.sessionId, { worktrees });
          };
          publish();
          const timer = setInterval(publish, intervalMs);
          timer.unref?.();
          timers.set(scope.sessionId, timer);
        },
        sessionRemoved(sessionId) {
          const timer = timers.get(sessionId);
          if (timer !== undefined) clearInterval(timer);
          timers.delete(sessionId);
          latest.delete(sessionId);
        },
        close() {
          for (const timer of timers.values()) clearInterval(timer);
          timers.clear();
          latest.clear();
        },
      };
      return source;
    },
  };
}

/** The named export the generated hub channel registry imports. */
export const webHubChannels: readonly WebHubChannel[] = [createWorktreesChannel()];
