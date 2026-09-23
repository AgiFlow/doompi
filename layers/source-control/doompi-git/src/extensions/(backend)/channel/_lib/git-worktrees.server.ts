/**
 * The worktrees data channel, and the commands the dock sends back through it.
 *
 * The registry is durable state only. Live lifecycle changes arrive through the
 * hub-owned direct event bus, so this channel never polls or claims files.
 */
import type {
  DoomHubChannel,
  DoomHubChannelSource,
  DoomHubSessionScope,
  DoomHubSessionService,
} from '@agimon-ai/doompi-core/hubChannel';

import { DoomGitExpectedError, HubUnavailableError } from '../../../../services/errors';
import { createWorktreeGit } from '../../../../services/gitCli';
import { registryFile } from '../../../../services/paths';
import { GIT_WORKTREE_LIFECYCLE_EVENT, isWorktreeLifecycleEvent } from '../../../../services/worktreeEvents';
import { createWorktreeOperations, type WorktreeOperations } from '../../../../services/worktreeOperations';
import { createWorktreeRegistry } from '../../../../services/worktreeRegistry';
import {
  GIT_WORKTREES_TYPE,
  type GitWorktreesCommand,
  type WorktreeErrorTarget,
  type WorktreeView,
} from '../../../../types/webWorktrees';

interface SessionState {
  worktrees: WorktreeView[];
  pending: string | undefined;
  error: string | undefined;
  errorTarget: WorktreeErrorTarget | undefined;
}

function payloadOf(state: SessionState): Record<string, unknown> {
  return {
    worktrees: state.worktrees,
    ...(state.pending === undefined ? {} : { pending: state.pending }),
    ...(state.error === undefined ? {} : { error: state.error }),
    ...(state.errorTarget === undefined ? {} : { errorTarget: state.errorTarget }),
  };
}

/** What the channel needs from its surroundings, injected so tests stay off this machine. */
export interface WorktreesChannelOptions {
  operations?: WorktreeOperations;
  homeDir?: string;
}

interface ViewDeps {
  homeDir: string | undefined;
  sessionService: DoomHubSessionService;
}

/** Worktrees visible to this session, using the hub's live session table for ownership. */
function viewsFor(scope: DoomHubSessionScope, deps: ViewDeps): WorktreeView[] {
  try {
    return createWorktreeRegistry(registryFile(scope.cwd, deps.homeDir))
      .list()
      .flatMap((record) => {
        const owned = record.parentSessionId === scope.sessionId;
        const unowned = !owned && !deps.sessionService.isLive(record.parentSessionId);
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

function errorTargetFor(command: GitWorktreesCommand): WorktreeErrorTarget {
  return command.action === 'create' ? { action: 'create' } : { action: 'close', id: command.id };
}

/** A command the page sent, or undefined when the frame was not one. */
function parseCommand(payload: unknown): GitWorktreesCommand | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = payload as Record<string, unknown>;
  if (value.action === 'create') {
    if (typeof value.branch !== 'string' || value.branch.trim() === '') return undefined;
    if (
      value.reservationId !== undefined &&
      (typeof value.reservationId !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value.reservationId))
    )
      return undefined;
    return {
      action: 'create',
      branch: value.branch.trim(),
      ...(typeof value.baseRef === 'string' && value.baseRef.trim() !== '' ? { baseRef: value.baseRef.trim() } : {}),
      ...(typeof value.reservationId === 'string' ? { reservationId: value.reservationId } : {}),
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

/** Starts one direct-event subscription per managed session. */
export function createWorktreesChannel(options: WorktreesChannelOptions = {}): DoomHubChannel {
  // Assigned by start, because receive is reachable only while the channel is
  // running and the command needs the state the direct event subscriptions keep.
  let receiveCommand: ((scope: DoomHubSessionScope, payload: unknown) => void) | undefined;

  return {
    frameType: GIT_WORKTREES_TYPE,
    start(host) {
      const sessionService = host.sessionService;
      if (sessionService === undefined) {
        throw new HubUnavailableError('The cockpit session service is unavailable. Start the cockpit and try again.');
      }
      const worktrees =
        options.operations ??
        createWorktreeOperations({
          git: createWorktreeGit(),
          sessionService,
        });
      const unregisterWorktreeProvisioner = sessionService.registerReservedWorktreeProvisioner?.(
        async ({ reservationId, parentSessionId, signal }) => {
          const parent = host.sessions().find((scope) => scope.sessionId === parentSessionId);
          if (parent === undefined) throw new Error('The conversation parent session is unavailable.');
          const branch = `doompi/conversation-${reservationId.slice(0, 12)}`;
          await worktrees.spawn(
            { cwd: parent.cwd, sessionId: parent.sessionId },
            { branch, name: `conversation ${reservationId.slice(0, 8)}`, reservationId },
            { signal },
          );
          const reservations = sessionService.reservations;
          if (reservations === undefined) throw new Error('Conversation reservations are unavailable.');
          return reservations.complete(reservationId, parentSessionId);
        },
      );
      const views: ViewDeps = { homeDir: options.homeDir, sessionService };
      const latest = new Map<string, SessionState>();
      const subscriptions = new Map<string, () => void>();
      const busy = new Set<string>();
      const generations = new Map<string, symbol>();
      const newGeneration = (sessionId: string): symbol => {
        const generation = Symbol(sessionId);
        generations.set(sessionId, generation);
        return generation;
      };

      /** Republishes a session, skipping a frame that would say nothing new. */
      const publish = (scope: DoomHubSessionScope, force: boolean): void => {
        const previous = latest.get(scope.sessionId);
        const next: SessionState = {
          worktrees: viewsFor(scope, views),
          pending: previous?.pending,
          error: previous?.error,
          errorTarget: previous?.errorTarget,
        };
        if (
          !force &&
          previous !== undefined &&
          sameList(previous.worktrees, next.worktrees) &&
          previous.pending === next.pending &&
          previous.error === next.error &&
          previous.errorTarget === next.errorTarget
        ) {
          return;
        }
        latest.set(scope.sessionId, next);
        host.publish(scope.sessionId, payloadOf(next));
      };

      const mark = (
        scope: DoomHubSessionScope,
        pending: string | undefined,
        error: string | undefined,
        errorTarget: WorktreeErrorTarget | undefined,
      ): void => {
        const previous = latest.get(scope.sessionId);
        latest.set(scope.sessionId, {
          worktrees: previous?.worktrees ?? viewsFor(scope, views),
          pending,
          error,
          errorTarget,
        });
        publish(scope, true);
      };

      /** Announces a successful mutation to this session's lifecycle subscribers. */
      const publishLifecycle = (scope: DoomHubSessionScope, repositoryRoot: string): void => {
        host.directEvents.publish(GIT_WORKTREE_LIFECYCLE_EVENT, scope.sessionId, {
          version: 1,
          repositoryRoot,
        });
      };

      const run = async (
        scope: DoomHubSessionScope,
        command: GitWorktreesCommand,
        generation: symbol,
      ): Promise<void> => {
        const context = { cwd: scope.cwd, sessionId: scope.sessionId };
        const markCurrent = (
          pending: string | undefined,
          error: string | undefined,
          errorTarget: WorktreeErrorTarget | undefined,
        ): void => {
          if (generations.get(scope.sessionId) !== generation) return;
          mark(scope, pending, error, errorTarget);
        };
        if (command.action === 'create') {
          markCurrent(`creating ${command.branch}…`, undefined, undefined);
          const record = await worktrees.spawn(
            context,
            {
              branch: command.branch,
              ...(command.baseRef === undefined ? {} : { baseRef: command.baseRef }),
              ...(command.reservationId === undefined ? {} : { reservationId: command.reservationId }),
            },
            // Each phase replaces the label, so the panel says what is
            // happening instead of holding one line for the whole wait.
            { onProgress: (label) => markCurrent(label, undefined, undefined) },
          );
          if (generations.get(scope.sessionId) !== generation) return;
          publishLifecycle(scope, record.repositoryRoot);
          return;
        }
        markCurrent(`closing ${command.id}…`, undefined, undefined);
        const record = await worktrees.close(context, command.id, command.force ?? false);
        if (generations.get(scope.sessionId) !== generation) return;
        publishLifecycle(scope, record.repositoryRoot);
      };

      const source: DoomHubChannelSource = {
        payloadFor(scope) {
          const state = latest.get(scope.sessionId);
          return state === undefined ? undefined : payloadOf(state);
        },
        sessionAdded(scope) {
          newGeneration(scope.sessionId);
          publish(scope, false);
          const unsubscribe = host.directEvents.subscribe(GIT_WORKTREE_LIFECYCLE_EVENT, scope.sessionId, (payload) => {
            if (!isWorktreeLifecycleEvent(payload)) return;
            let sameRepository = false;
            try {
              sameRepository =
                registryFile(scope.cwd, options.homeDir) === registryFile(payload.repositoryRoot, options.homeDir);
            } catch {
              sameRepository = false;
            }
            if (sameRepository) publish(scope, false);
          });
          subscriptions.set(scope.sessionId, unsubscribe);
        },
        sessionRemoved(sessionId) {
          newGeneration(sessionId);
          subscriptions.get(sessionId)?.();
          subscriptions.delete(sessionId);
          latest.delete(sessionId);
          busy.delete(sessionId);
        },
        close() {
          unregisterWorktreeProvisioner?.();
          for (const unsubscribe of subscriptions.values()) unsubscribe();
          subscriptions.clear();
          latest.clear();
          busy.clear();
          generations.clear();
        },
      };
      receiveCommand = (scope, payload) => {
        const command = parseCommand(payload);
        if (command === undefined) return;
        // One operation per session. A create runs for minutes, and a second
        // click must not start a second worktree behind the first.
        if (busy.has(scope.sessionId)) return;
        const generation = generations.get(scope.sessionId);
        if (generation === undefined) return;
        busy.add(scope.sessionId);
        void run(scope, command, generation)
          .then(() => {
            if (generations.get(scope.sessionId) !== generation) return;
            mark(scope, undefined, undefined, undefined);
          })
          .catch((error: unknown) => {
            if (generations.get(scope.sessionId) !== generation) return;
            host.onNotice(`worktree command failed for ${scope.sessionId} (${failureText(error)})`);
            mark(scope, undefined, failureText(error), errorTargetFor(command));
          })
          .finally(() => {
            if (generations.get(scope.sessionId) === generation) busy.delete(scope.sessionId);
          });
      };

      return source;
    },
    receive(scope, payload) {
      receiveCommand?.(scope, payload);
    },
  };
}

export default createWorktreesChannel;
