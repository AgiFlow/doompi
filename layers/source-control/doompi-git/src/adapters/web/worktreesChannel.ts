/**
 * The worktrees data channel, and the commands the dock sends back through it.
 *
 * DESIGN PATTERNS:
 * - Hub-scoped: it reads this machine's registry files, which a browser cannot.
 * - Scoped to the session that owns the worktree, not to the repository. Two
 *   sessions in one checkout are two pieces of work; showing each the other's
 *   worktrees offered a close button for something the reader never made.
 *   A worktree whose parent session is gone is the exception: it is shown to
 *   everyone in the repository, marked unowned, or nobody could ever close it.
 * - Poll, do not watch. The registry is a single small JSON file written by
 *   this package alone, and a watcher on a path that may not exist yet costs
 *   more than re-reading a few hundred bytes.
 * - Commands run the same `worktreeOperations` the tool runs, so the panel and
 *   the agent cannot drift into two ideas of what creating a worktree means.
 * - Publish only what the dock renders. Paths and provenance stay in the
 *   registry; the page gets a view.
 *
 * AVOID:
 * - Throwing out of a poll or a command. A registry that cannot be read is an
 *   empty list, and a failed command is an error string on the next frame:
 *   the dock degrades to what it can tell the reader, never to a dead channel.
 */
import type { HubChannelSource, HubSessionScope, WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import { GIT_WORKTREES_TYPE, type GitWorktreesCommand, type WorktreeView } from '../../types/webWorktrees.ts';
import { DoomGitExpectedError } from '../../services/support/errors.ts';
import { hubRegistryDir, registryFile } from '../filesystem/paths.ts';
import { sessionIsLive } from '../hub/hubClient.ts';
import { createWorktreeGit } from '../worktree/gitCli.ts';
import { createWorktreeOperations, type WorktreeOperations } from '../worktree/worktreeOperations.ts';
import { createWorktreeRegistry } from '../worktree/worktreeRegistry.ts';

/** How often a session's registry is re-read. Worktrees change by hand, not by the second. */
const POLL_MS = 4000;

interface SessionState {
  worktrees: WorktreeView[];
  pending: string | undefined;
  error: string | undefined;
}

function payloadOf(state: SessionState): Record<string, unknown> {
  return {
    worktrees: state.worktrees,
    ...(state.pending === undefined ? {} : { pending: state.pending }),
    ...(state.error === undefined ? {} : { error: state.error }),
  };
}

/** What the channel needs from its surroundings, injected so tests stay off this machine. */
export interface WorktreesChannelOptions {
  intervalMs?: number;
  operations?: WorktreeOperations;
  homeDir?: string;
  registryDir?: string;
  isSessionLive?: (registryDir: string, sessionId: string) => boolean;
}

interface ViewDeps {
  registryDir: string;
  homeDir: string | undefined;
  isSessionLive: (registryDir: string, sessionId: string) => boolean;
}

/**
 * The worktrees one session may see: its own, plus any whose parent session
 * has gone. Liveness is the registry record's presence, the same signal the
 * rail uses to decide a session exists at all.
 */
function viewsFor(scope: HubSessionScope, deps: ViewDeps): WorktreeView[] {
  try {
    return createWorktreeRegistry(registryFile(scope.cwd, deps.homeDir))
      .list()
      .flatMap((record) => {
        const owned = record.parentSessionId === scope.sessionId;
        const unowned = !owned && !deps.isSessionLive(deps.registryDir, record.parentSessionId);
        if (!owned && !unowned) return [];
        return [
          {
            id: record.id,
            branch: record.branch,
            path: record.path,
            sessionId: record.status === 'orphaned' ? null : record.sessionId,
            orphaned: record.status === 'orphaned',
            unowned,
          },
        ];
      });
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
      entry.orphaned === other.orphaned &&
      entry.unowned === other.unowned
    );
  });
}

/** A command the page sent, or undefined when the frame was not one. */
function parseCommand(payload: unknown): GitWorktreesCommand | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = payload as Record<string, unknown>;
  if (value.action === 'create') {
    if (typeof value.branch !== 'string' || value.branch.trim() === '') return undefined;
    return {
      action: 'create',
      branch: value.branch.trim(),
      ...(typeof value.baseRef === 'string' && value.baseRef.trim() !== '' ? { baseRef: value.baseRef.trim() } : {}),
    };
  }
  if (value.action === 'close') {
    if (typeof value.id !== 'string' || value.id === '') return undefined;
    return { action: 'close', id: value.id, ...(value.force === true ? { force: true } : {}) };
  }
  return undefined;
}

/**
 * What the reader is told when a command fails.
 *
 * An expected failure explains itself. Anything else is summarised, never
 * echoed: a git error can carry a remote URL with a token in it.
 */
function failureText(error: unknown): string {
  return error instanceof DoomGitExpectedError ? error.message : 'The worktree operation failed.';
}

/**
 * One poller per managed session, publishing only when the list actually
 * changed so an idle cockpit stays quiet.
 */
export function createWorktreesChannel(options: WorktreesChannelOptions = {}): WebHubChannel {
  const intervalMs = options.intervalMs ?? POLL_MS;
  // Assigned by start, because receive is reachable only while the channel is
  // running and the command needs the state the poller keeps.
  let receiveCommand: ((scope: HubSessionScope, payload: unknown) => void) | undefined;

  return {
    frameType: GIT_WORKTREES_TYPE,
    start(host) {
      const worktrees = options.operations ?? createWorktreeOperations({ git: createWorktreeGit() });
      const views: ViewDeps = {
        registryDir: options.registryDir ?? hubRegistryDir(),
        homeDir: options.homeDir,
        isSessionLive: options.isSessionLive ?? sessionIsLive,
      };
      const latest = new Map<string, SessionState>();
      const scopes = new Map<string, HubSessionScope>();
      const timers = new Map<string, ReturnType<typeof setInterval>>();
      const busy = new Set<string>();

      /** Republishes a session, skipping a frame that would say nothing new. */
      const publish = (scope: HubSessionScope, force: boolean): void => {
        const previous = latest.get(scope.sessionId);
        const next: SessionState = {
          worktrees: viewsFor(scope, views),
          pending: previous?.pending,
          error: previous?.error,
        };
        if (
          !force &&
          previous !== undefined &&
          sameList(previous.worktrees, next.worktrees) &&
          previous.pending === next.pending &&
          previous.error === next.error
        ) {
          return;
        }
        latest.set(scope.sessionId, next);
        host.publish(scope.sessionId, payloadOf(next));
      };

      /** Sets the operation label and clears the last failure, then publishes. */
      const mark = (scope: HubSessionScope, pending: string | undefined, error: string | undefined): void => {
        const previous = latest.get(scope.sessionId);
        latest.set(scope.sessionId, {
          worktrees: previous?.worktrees ?? viewsFor(scope, views),
          pending,
          error,
        });
        publish(scope, true);
      };

      const run = async (scope: HubSessionScope, command: GitWorktreesCommand): Promise<void> => {
        const context = { cwd: scope.cwd, sessionId: scope.sessionId };
        if (command.action === 'create') {
          mark(scope, `creating ${command.branch}\u2026`, undefined);
          await worktrees.spawn(context, {
            branch: command.branch,
            ...(command.baseRef === undefined ? {} : { baseRef: command.baseRef }),
          });
          return;
        }
        mark(scope, `closing ${command.id}\u2026`, undefined);
        await worktrees.close(context, command.id, command.force ?? false);
      };

      const source: HubChannelSource = {
        payloadFor(scope) {
          const state = latest.get(scope.sessionId);
          return state === undefined ? undefined : payloadOf(state);
        },
        sessionAdded(scope) {
          scopes.set(scope.sessionId, scope);
          publish(scope, false);
          const timer = setInterval(() => {
            publish(scope, false);
          }, intervalMs);
          timer.unref?.();
          timers.set(scope.sessionId, timer);
        },
        sessionRemoved(sessionId) {
          const timer = timers.get(sessionId);
          if (timer !== undefined) clearInterval(timer);
          timers.delete(sessionId);
          latest.delete(sessionId);
          scopes.delete(sessionId);
          busy.delete(sessionId);
        },
        close() {
          for (const timer of timers.values()) clearInterval(timer);
          timers.clear();
          latest.clear();
          scopes.clear();
          busy.clear();
        },
      };
      receiveCommand = (scope, payload) => {
        const command = parseCommand(payload);
        if (command === undefined) return;
        // One operation per session. A create runs for minutes, and a second
        // click must not start a second worktree behind the first.
        if (busy.has(scope.sessionId)) return;
        busy.add(scope.sessionId);
        void run(scope, command)
          .then(() => {
            mark(scope, undefined, undefined);
          })
          .catch((error: unknown) => {
            host.onNotice(`worktree command failed for ${scope.sessionId} (${failureText(error)})`);
            mark(scope, undefined, failureText(error));
          })
          .finally(() => {
            busy.delete(scope.sessionId);
          });
      };

      return source;
    },
    receive(scope, payload) {
      receiveCommand?.(scope, payload);
    },
  };
}

/** The named export the generated hub channel registry imports. */
export const webHubChannels: readonly WebHubChannel[] = [createWorktreesChannel()];
