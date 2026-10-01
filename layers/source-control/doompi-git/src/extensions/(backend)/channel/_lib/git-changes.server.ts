/**
 * The '# diff' data channel: this session's change against its base, and the
 * manual sync commands the review tab sends back through it.
 *
 * DESIGN PATTERNS:
 * - Apart from the worktrees channel. Worktrees are repository management;
 *   this is the session's own code change.
 * - Push, not poll. The session facet publishes a "changed" event after every
 *   tool call and settled turn; recounts are coalesced to one in flight plus
 *   one rerun, so a burst of tool calls costs at most two.
 * - One sync command per session. A rebase and a push must never overlap.
 * - Auth is read fresh for each command from the session's workspace, and goes
 *   only into that command's git child.
 *
 * AVOID:
 * - Echoing git output. Failures go through classifyGitFailure, which matches
 *   stderr and drops it, because a remote URL in it can carry a token.
 */
import os from 'node:os';

import type { DoomHubChannel, DoomHubChannelSource, DoomHubSessionScope } from '@agimon-ai/doompi-core/hubChannel';

import { createBranchDiff } from '../../../../services/branchDiff';
import type { BranchDiff } from '../../../../services/branchDiff/type';
import { DoomGitExpectedError } from '../../../../services/errors';
import { createGitAuthStore } from '../../../../services/gitAuth';
import type { GitAuthStore } from '../../../../services/gitAuth/type';
import { createGitSync } from '../../../../services/gitSync';
import type { GitSync, GitSyncOutcome } from '../../../../services/gitSync/type';
import { registryFile } from '../../../../services/paths';
import { GIT_SESSION_CHANGED_EVENT, isSessionChangedEvent } from '../../../../services/worktreeEvents';
import { createWorktreeRegistry } from '../../../../services/worktreeRegistry';
import {
  GIT_CHANGES_TYPE,
  type GitChangesCommand,
  type GitChangesPayload,
  type GitChangesView,
  type GitSyncErrorTarget,
} from '../../../../types/gitReview';

interface SessionState {
  changes: GitChangesView | undefined;
  pending: string | undefined;
  error: string | undefined;
  errorTarget: GitSyncErrorTarget | undefined;
}

/** What the channel needs from its surroundings, injected so tests stay off this machine's home. */
export interface GitChangesChannelOptions {
  homeDir?: string;
  diff?: BranchDiff;
  sync?: GitSync;
  auth?: GitAuthStore;
}

function payloadOf(state: SessionState): GitChangesPayload {
  return {
    ...(state.changes === undefined ? {} : { changes: state.changes }),
    ...(state.pending === undefined ? {} : { pending: state.pending }),
    ...(state.error === undefined ? {} : { error: state.error }),
    ...(state.errorTarget === undefined ? {} : { errorTarget: state.errorTarget }),
  };
}

/** A command the page sent, or undefined when the frame was not one. */
export function parseChangesCommand(payload: unknown): GitChangesCommand | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = payload as Record<string, unknown>;
  if (value.action === 'pull' || value.action === 'rebase' || value.action === 'abort-rebase')
    return { action: value.action };
  if (value.action === 'push') return value.force === true ? { action: 'push', force: true } : { action: 'push' };
  return undefined;
}

const PENDING: Readonly<Record<GitChangesCommand['action'], string>> = {
  pull: 'pulling…',
  push: 'pushing…',
  rebase: 'rebasing…',
  'abort-rebase': 'aborting the rebase…',
};

/** The error target a failure maps to: a rejected plain push asks for a confirmed lease force. */
function errorTargetFor(command: GitChangesCommand, error: unknown): GitSyncErrorTarget {
  if (command.action !== 'push') return { action: command.action };
  const needsForce =
    error instanceof DoomGitExpectedError && error.code === 'push_needs_force' && command.force !== true;
  return needsForce ? { action: 'push', forceRequired: true } : { action: 'push' };
}

function failureText(error: unknown): string {
  // The expected error's message carries its own `[code]` prefix and recovery
  // line; the page shows the human part.
  if (error instanceof DoomGitExpectedError)
    return error.message.replace(/^\[[a-z_]+\] /u, '').replace('\nRecovery: ', ' ');
  return 'The git command failed.';
}

export function createGitChangesChannel(options: GitChangesChannelOptions = {}): DoomHubChannel {
  let receiveCommand: ((scope: DoomHubSessionScope, payload: unknown) => void) | undefined;

  return {
    frameType: GIT_CHANGES_TYPE,
    start(host) {
      const homeDir = options.homeDir ?? os.homedir();
      const diff = options.diff ?? createBranchDiff();
      const sync = options.sync ?? createGitSync({ homeDir });
      const auth = options.auth ?? createGitAuthStore(homeDir);
      const latest = new Map<string, SessionState>();
      const subscriptions = new Map<string, () => void>();
      const scopes = new Map<string, DoomHubSessionScope>();
      const inFlight = new Set<string>();
      const rerun = new Set<string>();
      const busy = new Set<string>();

      /** The base the session's own worktree was created from, when it has one. */
      const recordedBaseRef = (scope: DoomHubSessionScope): string | undefined => {
        try {
          return createWorktreeRegistry(registryFile(scope.cwd, homeDir))
            .list()
            .find((record) => record.sessionId === scope.sessionId)?.baseRef;
        } catch {
          return undefined;
        }
      };

      /** Republishes a session, skipping a frame that would say nothing new. */
      const publish = (sessionId: string, next: SessionState): void => {
        const previous = latest.get(sessionId);
        latest.set(sessionId, next);
        if (previous !== undefined && JSON.stringify(payloadOf(previous)) === JSON.stringify(payloadOf(next))) return;
        host.publish(sessionId, payloadOf(next));
      };

      const update = (sessionId: string, patch: Partial<SessionState>): void => {
        const previous = latest.get(sessionId) ?? {
          changes: undefined,
          pending: undefined,
          error: undefined,
          errorTarget: undefined,
        };
        publish(sessionId, { ...previous, ...patch });
      };

      /** Recounts one session; a request while one runs schedules exactly one more. */
      const refresh = (sessionId: string): void => {
        const scope = scopes.get(sessionId);
        if (scope === undefined) return;
        if (inFlight.has(sessionId)) {
          rerun.add(sessionId);
          return;
        }
        inFlight.add(sessionId);
        const base = recordedBaseRef(scope);
        void diff
          .review(scope.cwd, base === undefined ? {} : { recordedBaseRef: base })
          .then((review) => {
            if (scopes.has(sessionId)) update(sessionId, { changes: review?.changes });
          })
          .catch((error: unknown) => {
            host.onNotice(
              `git diff refresh failed for ${sessionId} (${error instanceof Error ? error.name : 'unknown'})`,
            );
          })
          .finally(() => {
            inFlight.delete(sessionId);
            if (rerun.delete(sessionId)) refresh(sessionId);
          });
      };

      const run = (scope: DoomHubSessionScope, command: GitChangesCommand): Promise<GitSyncOutcome> => {
        const workspaceRoot = scope.sessionContext?.workspaceRoot ?? scope.cwd;
        const base = recordedBaseRef(scope);
        const context = {
          cwd: scope.cwd,
          auth: auth.read(workspaceRoot),
          ...(base === undefined ? {} : { recordedBaseRef: base }),
        };
        if (command.action === 'pull') return sync.pull(context);
        if (command.action === 'push') return sync.push(context, command.force === true);
        if (command.action === 'rebase') return sync.rebase(context);
        return sync.abortRebase(context);
      };

      const source: DoomHubChannelSource = {
        payloadFor(scope) {
          const state = latest.get(scope.sessionId);
          return state === undefined ? undefined : payloadOf(state);
        },
        sessionAdded(scope) {
          scopes.set(scope.sessionId, scope);
          refresh(scope.sessionId);
          const unsubscribe = host.directEvents.subscribe(GIT_SESSION_CHANGED_EVENT, scope.sessionId, (payload) => {
            if (isSessionChangedEvent(payload)) refresh(scope.sessionId);
          });
          subscriptions.set(scope.sessionId, unsubscribe);
        },
        sessionRemoved(sessionId) {
          subscriptions.get(sessionId)?.();
          subscriptions.delete(sessionId);
          scopes.delete(sessionId);
          latest.delete(sessionId);
          rerun.delete(sessionId);
          busy.delete(sessionId);
        },
        close() {
          for (const unsubscribe of subscriptions.values()) unsubscribe();
          subscriptions.clear();
          scopes.clear();
          latest.clear();
          rerun.clear();
          busy.clear();
        },
      };

      receiveCommand = (scope, payload) => {
        const command = parseChangesCommand(payload);
        if (command === undefined || !scopes.has(scope.sessionId)) return;
        if (busy.has(scope.sessionId)) return;
        busy.add(scope.sessionId);
        update(scope.sessionId, { pending: PENDING[command.action], error: undefined, errorTarget: undefined });
        void run(scope, command)
          .then(() => update(scope.sessionId, { pending: undefined }))
          .catch((error: unknown) => {
            host.onNotice(
              `git ${command.action} failed for ${scope.sessionId} (${error instanceof DoomGitExpectedError ? error.code : 'unexpected'})`,
            );
            update(scope.sessionId, {
              pending: undefined,
              error: failureText(error),
              errorTarget: errorTargetFor(command, error),
            });
          })
          .finally(() => {
            busy.delete(scope.sessionId);
            // A paused rebase, a moved upstream and new commits all show in the recount.
            refresh(scope.sessionId);
          });
      };

      return source;
    },
    receive(scope, payload) {
      receiveCommand?.(scope, payload);
    },
  };
}

export default createGitChangesChannel;
