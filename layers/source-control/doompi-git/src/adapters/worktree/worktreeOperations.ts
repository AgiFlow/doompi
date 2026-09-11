import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mirrorComposition } from './compositionMirror.ts';
import type { DoomHubSessionService } from '@agimon-ai/doompi-extension-contracts/hub-channel';
import { registryFile, worktreesRoot } from '../filesystem/paths.ts';
import { repositoryId, repositoryLabel, shortId } from './repositoryIdentity.ts';
import { MAX_WORKTREE_MESSAGE_BYTES, type WorktreeMessageInbox, type WorktreeMessageParty } from './worktreeEvents.ts';
import { createWorktreeRegistry } from './worktreeRegistry.ts';
import { WORKTREE_RECORD_VERSION } from '../../types/worktreeRegistry.ts';
import type { WorktreeGit, WorktreeRecord } from '../../types/worktreeRegistry.ts';
import { planPrune, reconcile, refuseClose, refuseSpawn, worktreeDirectory } from '../../services/worktreeNaming.ts';
import { DoomGitExpectedError, HubUnavailableError } from '../../services/support/errors.ts';

export interface WorktreeContext {
  /** Where the calling session is working, used to find the repository. */
  cwd: string;
  /** The calling session, recorded as the new session's parent. */
  sessionId: string;
}

export interface SpawnWorktreeRequest {
  branch: string;
  baseRef?: string;
  name?: string;
}

export interface SpawnOptions {
  /** Aborted when the caller gives up, so a spawn nobody is waiting for stops. */
  signal?: AbortSignal;
  /** Phase labels, for a caller that can show them while the work runs. */
  onProgress?: (label: string) => void;
}

export interface WorktreeOperations {
  spawn(context: WorktreeContext, request: SpawnWorktreeRequest, options?: SpawnOptions): Promise<WorktreeRecord>;
  close(context: WorktreeContext, id: string, force: boolean): Promise<WorktreeRecord>;
  list(context: WorktreeContext): Promise<WorktreeRecord[]>;
  status(context: WorktreeContext, id: string): Promise<{ record: WorktreeRecord; dirtyFiles: string[] }>;
  merge(context: WorktreeContext, id: string, message?: string): Promise<WorktreeRecord>;
  prune(context: WorktreeContext, dryRun: boolean): Promise<ReturnType<typeof planPrune>>;
  send(context: WorktreeContext, id: string, message: string): Promise<void>;
  messages(context: WorktreeContext, id: string): Promise<import('./worktreeEvents.ts').WorktreeMessage[]>;
}

export interface WorktreeOperationsDeps {
  git: WorktreeGit;
  /** The canonical hub-owned session lifecycle. */
  sessionService?: DoomHubSessionService;
  /** Session-local inbox for parent/worktree messages. */
  messageInbox?: WorktreeMessageInbox;
  /** Injected so a test never copies a real dependency tree. */
  mirror?: typeof mirrorComposition;
  homeDir?: string;
  /** Injected so a record's createdAt is reproducible in a test. */
  now?: () => Date;
}

export function createWorktreeOperations(deps: WorktreeOperationsDeps): WorktreeOperations {
  const { git } = deps;
  const sessionService = deps.sessionService;
  const mirror = deps.mirror ?? mirrorComposition;
  const now = deps.now ?? (() => new Date());
  const requireSessionService = (): DoomHubSessionService => {
    if (sessionService === undefined)
      throw new HubUnavailableError('The cockpit session service is unavailable. Start the cockpit and try again.');
    return sessionService;
  };
  const requireMessageInbox = (): WorktreeMessageInbox => {
    if (deps.messageInbox === undefined)
      throw new HubUnavailableError('The Git message service is unavailable. Start the cockpit and try again.');
    return deps.messageInbox;
  };
  const probe = {
    alive: (record: WorktreeRecord) => requireSessionService().isLive(record.sessionId),
    exists: (path: string) => fs.existsSync(path),
  };

  /**
   * Everything an action needs about the repository it is acting on.
   *
   * Resolved per call rather than cached: a session's cwd is stable, but the
   * worktree registry is shared and another process may have written it since
   * the last call.
   */
  const resolve = async (context: WorktreeContext) => {
    const root = await git.repositoryRoot(context.cwd);
    if (root === undefined) {
      throw new DoomGitExpectedError(
        'not_a_repository',
        `${context.cwd} is not inside a git repository.`,
        false,
        'Run this from a repository checkout.',
      );
    }
    const store = createWorktreeRegistry(registryFile(root, deps.homeDir));
    return { root, store, records: store.list() };
  };

  const require = (records: readonly WorktreeRecord[], id: string): WorktreeRecord => {
    const record = records.find((entry) => entry.id === id);
    if (record === undefined) {
      throw new DoomGitExpectedError(
        'worktree_not_found',
        `No worktree with id ${id}.`,
        false,
        'Call list to see the current ids.',
      );
    }
    return record;
  };

  /**
   * Refuses to destroy or merge a worktree another live session is using.
   *
   * `parentSessionId` records who asked for the worktree. Two sessions in one
   * checkout share this registry, so without the check either could close the
   * other's work in progress by id.
   *
   * Once that session is gone there is no owner left to protect, and refusing
   * would strand the worktree: nothing else could ever close it.
   */
  const requireOwner = (context: WorktreeContext, record: WorktreeRecord, action: string): void => {
    if (record.parentSessionId === context.sessionId) return;
    if (!requireSessionService().isLive(record.parentSessionId)) return;
    throw new DoomGitExpectedError(
      'worktree_not_owned',
      `Worktree ${record.id} belongs to another session.`,
      false,
      `Ask the session that created it to ${action} it, or close that session first.`,
    );
  };

  const peerFor = (
    context: WorktreeContext,
    record: WorktreeRecord,
  ): { sessionId: string; party: WorktreeMessageParty } => {
    if (context.sessionId === record.parentSessionId) return { sessionId: record.sessionId, party: 'parent' };
    if (context.sessionId === record.sessionId) return { sessionId: record.parentSessionId, party: 'child' };
    throw new DoomGitExpectedError(
      'worktree_not_owned',
      `Worktree ${record.id} belongs to another session.`,
      false,
      'Use a worktree owned by this session.',
    );
  };

  const requirePeerLive = (peerSessionId: string): void => {
    if (!requireSessionService().isLive(peerSessionId)) {
      throw new DoomGitExpectedError(
        'worktree_peer_unavailable',
        'The other worktree session is no longer live.',
        false,
        'Start a new worktree session before sending a message.',
      );
    }
  };

  return {
    async spawn(context, request, options) {
      const { root, store, records } = await resolve(context);
      const refusal = refuseSpawn({ branch: request.branch, existing: records });
      if (refusal !== undefined) {
        throw new DoomGitExpectedError('worktree_exists', refusal, false, 'Pick another branch name, or close it.');
      }
      const baseRef = request.baseRef ?? (await git.currentBranch(root)) ?? 'HEAD';
      const id = shortId(randomUUID());
      const path = worktreeDirectory({
        worktreesRoot: worktreesRoot(deps.homeDir),
        repositoryLabel: repositoryLabel(root),
        repositoryId: repositoryId(root),
        branch: request.branch,
        shortId: id,
      });

      // The worktree and the branch are made by one command, so they are undone
      // by one too. `worktree remove` leaves the branch behind, and a branch
      // nobody asked for is what a failed spawn used to leave on the floor.
      const cancelled = (): boolean => options?.signal?.aborted === true;
      const rollback = async (): Promise<string> => {
        await git.removeWorktree({ repositoryRoot: root, path, force: true }).catch(() => undefined);
        const deleted = await git.deleteBranch({ repositoryRoot: root, branch: request.branch }).catch(() => false);
        return deleted ? '' : ` The branch ${request.branch} has work on it and was kept.`;
      };

      options?.onProgress?.(`creating branch ${request.branch}\u2026`);
      await git.addWorktree({ repositoryRoot: root, path, branch: request.branch, baseRef });

      // Checked here rather than only inside the session call: this is the
      // point where a checkout exists that nothing has recorded yet, which is
      // exactly the state an interrupted spawn used to leave behind.
      if (cancelled()) {
        const kept = await rollback();
        throw new DoomGitExpectedError(
          'spawn_cancelled',
          `Cancelled before the session started.${kept}`,
          false,
          'The worktree was removed; run it again when you are ready.',
        );
      }

      // Before the session, because the session composes the extensions this
      // repository's config names and those live in build output git does not
      // track. A worktree without it starts and dies on the first package it
      // cannot resolve. Nothing here can fail the spawn: a repository with no
      // build output to mirror simply has none.
      options?.onProgress?.('mirroring build output\u2026');
      mirror(root, path);

      // The worktree exists from here on, so every later failure has to leave
      // it removed or recorded. An unrecorded directory on disk is the one
      // outcome with no way back: nothing would ever list it again.
      options?.onProgress?.('starting session\u2026');
      let sessionId: string;
      try {
        const session = await requireSessionService().create({
          cwd: path,
          name: request.name ?? request.branch,
          parentSessionId: context.sessionId,
          sessionProvenance: 'worktree',
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        });
        sessionId = session.sessionId;
      } catch (error) {
        const kept = await rollback();
        if (cancelled()) {
          throw new DoomGitExpectedError(
            'spawn_cancelled',
            `Cancelled while the session was starting.${kept}`,
            false,
            'The worktree was removed; run it again when you are ready.',
          );
        }
        if (error instanceof HubUnavailableError) {
          throw new DoomGitExpectedError(
            'hub_unavailable',
            `${error.message}${kept}`,
            true,
            'Start the cockpit and try again.',
          );
        }
        throw error;
      }

      const record: WorktreeRecord = {
        version: WORKTREE_RECORD_VERSION,
        id,
        branch: request.branch,
        baseRef,
        path,
        repositoryRoot: root,
        sessionId,
        parentSessionId: context.sessionId,
        status: 'running',
        createdAt: now().toISOString(),
      };
      try {
        store.replace([...records, record]);
      } catch (error) {
        // A live session with no record is the worst outcome available here:
        // it runs, and no id anything can name points at it. The session goes
        // back too, rather than being left for someone to find by hand.
        await requireSessionService()
          .close(sessionId)
          .catch(() => undefined);
        const kept = await rollback();
        throw new DoomGitExpectedError(
          'registry_write_failed',
          `The worktree was created but the registry could not be written (${(error as Error).message}).${kept}`,
          true,
          'Check the registry file for permissions or free space, then try again.',
        );
      }
      return record;
    },

    async close(context, id, force) {
      const { root, store, records } = await resolve(context);
      const record = require(records, id);
      requireOwner(context, record, 'close');
      const dirtyFiles = fs.existsSync(record.path) ? await git.dirtyFiles(record.path) : [];
      const refusal = refuseClose({ record, dirtyFiles, force });
      if (refusal !== undefined) {
        throw new DoomGitExpectedError('worktree_dirty', refusal, false, 'Commit the work, or pass force: true.');
      }
      // The session is stopped before the directory goes. Removing a checkout
      // while a process still holds files open in it is how a half-removed
      // worktree and a stale git administrative entry are made.
      await requireSessionService().close(record.sessionId);
      await git.removeWorktree({ repositoryRoot: root, path: record.path, force });
      store.replace(records.filter((entry) => entry.id !== id));
      return record;
    },

    async list(context) {
      const { store, records } = await resolve(context);
      const outcome = reconcile(records, probe);
      if (outcome.changed.length > 0) store.replace(outcome.records);
      return outcome.records;
    },

    async status(context, id) {
      const { records } = await resolve(context);
      const record = require(records, id);
      const dirtyFiles = fs.existsSync(record.path) ? await git.dirtyFiles(record.path) : [];
      return { record, dirtyFiles };
    },

    async merge(context, id, message) {
      const { root, records } = await resolve(context);
      const record = require(records, id);
      requireOwner(context, record, 'merge');
      // The merge lands in the parent, so the parent is what must be clean. A
      // dirty parent would mix the person's in-flight edits into a merge commit
      // they did not intend to make.
      const parentDirty = await git.dirtyFiles(root);
      if (parentDirty.length > 0) {
        throw new DoomGitExpectedError(
          'worktree_dirty',
          `The parent checkout has ${String(parentDirty.length)} uncommitted file(s): ${parentDirty.slice(0, 10).join(', ')}.`,
          false,
          'Commit or stash the parent checkout first.',
        );
      }
      await git.mergeBranch({
        repositoryRoot: root,
        branch: record.branch,
        ...(message === undefined ? {} : { message }),
      });
      return record;
    },

    /** Sends only between the parent session and its own worktree session. */
    async send(context, id, message) {
      if (Buffer.byteLength(message, 'utf8') > MAX_WORKTREE_MESSAGE_BYTES) {
        throw new DoomGitExpectedError(
          'message_too_large',
          `A message may not exceed ${String(MAX_WORKTREE_MESSAGE_BYTES)} bytes.`,
          false,
          'Send a shorter message.',
        );
      }
      const { records } = await resolve(context);
      const record = require(records, id);
      const peer = peerFor(context, record);
      requirePeerLive(peer.sessionId);
      requireMessageInbox().send(peer.sessionId, {
        version: 1,
        worktreeId: record.id,
        fromSessionId: context.sessionId,
        from: peer.party,
        text: message,
        sentAt: new Date().toISOString(),
      });
    },

    async messages(context, id) {
      const { records } = await resolve(context);
      const record = require(records, id);
      peerFor(context, record);
      return requireMessageInbox().receive(record.id);
    },

    async prune(context, dryRun) {
      const { root, store, records } = await resolve(context);
      const reconciled = reconcile(records, probe);
      const gitPaths = await git.listWorktreePaths(root);
      const dirtyByPath = new Map<string, readonly string[]>();
      for (const record of reconciled.records) {
        if (record.status === 'orphaned' && fs.existsSync(record.path)) {
          dirtyByPath.set(record.path, await git.dirtyFiles(record.path));
        }
      }
      const plan = planPrune({
        records: reconciled.records,
        gitPaths,
        worktreesRoot: worktreesRoot(deps.homeDir),
        dirtyByPath,
      });
      if (dryRun) {
        store.replace(reconciled.records);
        return plan;
      }
      for (const record of plan.remove) {
        await git.removeWorktree({ repositoryRoot: root, path: record.path, force: false });
      }
      // The checkout goes, so the branch it was made for goes with it. Safe
      // delete only: git keeps anything holding commits, and the plan says
      // which ones it kept rather than leaving the reader to notice later.
      for (const record of [...plan.remove, ...plan.forget]) {
        const deleted = await git.deleteBranch({ repositoryRoot: root, branch: record.branch }).catch(() => false);
        if (!deleted) plan.keptBranches.push(record.branch);
      }
      const dropped = new Set([...plan.remove, ...plan.forget].map((record) => record.id));
      store.replace(reconciled.records.filter((record) => !dropped.has(record.id)));
      return plan;
    },
  };
}
