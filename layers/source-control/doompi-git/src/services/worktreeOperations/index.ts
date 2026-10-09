import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import type { DoomHubSessionService } from '@agimon-ai/doompi-core/hubChannel';
import { removeSyncLocation, resolveWorktreeSyncLocation } from '@agimon-ai/doompi-core/syncLocation';
import type { DoomSessionDeliveryService } from '@agimon-ai/doompi-session';

import { WORKTREE_RECORD_VERSION } from '../../types/worktreeRegistry';
import type { WorktreeGit, WorktreeRecord } from '../../types/worktreeRegistry';
import { DoomGitExpectedError, HubUnavailableError } from '../errors';
import { registryFile, worktreesRoot } from '../paths';
import { repositoryId, repositoryLabel, shortId } from '../repositoryIdentity';
import { MAX_WORKTREE_MESSAGE_BYTES, type WorktreeMessageInbox, type WorktreeMessageParty } from '../worktreeEvents';
import { planPrune, reconcile, refuseClose, refuseSpawn, validRefName, worktreeDirectory } from '../worktreeNaming';
import { createWorktreeRegistry } from '../worktreeRegistry';

const GIT_WORKTREE_DELEGATION_KIND = 'git.worktree.delegation';
const GIT_WORKTREE_MESSAGE_KIND = 'git.worktree.message';
const GIT_WORKTREE_REPORT_KIND = 'git.worktree.report';
export interface WorktreeContext {
  /** Where the calling session is working, used to find the repository. */
  cwd: string;
  /**
   * The calling session, recorded as the new session's parent. Absent when the
   * new-session dialog opens a top-level worktree session for the workspace.
   */
  sessionId?: string;
}

export interface SpawnWorktreeRequest {
  branch: string;
  baseRef?: string;
  name?: string;
  task?: string;
  /** Host-owned execution setup, exposed by the UI rather than the agent tool. */
  reservationId?: string;
  /** `existing` checks out a branch that already exists instead of creating one from `baseRef`. */
  checkout?: 'new' | 'existing';
  /** With `existing`: the branch exists only on this remote; a local tracking branch is created. */
  remote?: string;
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
  messages(context: WorktreeContext, id: string): Promise<import('../worktreeEvents').WorktreeMessage[]>;
}

export interface WorktreeOperationsDeps {
  git: WorktreeGit;
  /** The canonical hub-owned session lifecycle. */
  sessionService?: DoomHubSessionService;
  /** Legacy in-memory fallback used outside the fixed Session composition. */
  messageInbox?: WorktreeMessageInbox;
  /** Reads the active Session provider when an operation executes. */
  sessionDelivery?: () => DoomSessionDeliveryService | undefined;
  /** Injected so tests can observe generated-storage cleanup without touching real sync state. */
  cleanupStorage?: (repositoryRoot: string, worktreeRoot: string) => void;
  homeDir?: string;
  /** Injected so a record's createdAt is reproducible in a test. */
  now?: () => Date;
}

export function createWorktreeOperations(deps: WorktreeOperationsDeps): WorktreeOperations {
  const { git } = deps;
  const sessionService = deps.sessionService;
  const removeStorage =
    deps.cleanupStorage ??
    ((repositoryRoot: string, worktreeRoot: string): void => {
      removeSyncLocation(resolveWorktreeSyncLocation(repositoryRoot, worktreeRoot, deps.homeDir));
    });
  const cleanupStorage = (repositoryRoot: string, worktreeRoot: string): void => {
    try {
      removeStorage(repositoryRoot, worktreeRoot);
    } catch (error) {
      throw new DoomGitExpectedError(
        'worktree_cleanup_failed',
        `The worktree checkout was removed, but its generated storage could not be deleted (${error instanceof Error ? error.message : String(error)}).`,
        true,
        'Retry close or prune after fixing the storage permissions.',
      );
    }
  };
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
  const readSessionDelivery = (): DoomSessionDeliveryService | undefined => deps.sessionDelivery?.();
  const requireSessionDelivery = (): DoomSessionDeliveryService => {
    const delivery = readSessionDelivery();
    if (delivery === undefined)
      throw new HubUnavailableError('The Session delivery service is unavailable. Start the cockpit and try again.');
    return delivery;
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
    if (record.parentSessionId === undefined || !requireSessionService().isLive(record.parentSessionId)) return;
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
    if (record.parentSessionId === undefined)
      throw new DoomGitExpectedError(
        'worktree_peer_unavailable',
        `Worktree ${record.id} was opened on its own and has no parent session to message.`,
        false,
        'Message a worktree this session created.',
      );
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

  const operations: WorktreeOperations = {
    async spawn(context, request, options) {
      const parentSessionId = context.sessionId;
      const parented = parentSessionId === undefined ? {} : { parentSessionId };
      const { root, store, records } = await resolve(context);
      const reservations = request.reservationId === undefined ? undefined : requireSessionService().reservations;
      if (request.reservationId !== undefined && (!reservations || request.task !== undefined))
        throw new DoomGitExpectedError(
          'invalid_request',
          'Reserved worktree sessions require host setup and cannot start a task.',
          false,
          'Create the session from its pending setup card.',
        );
      const reserved =
        request.reservationId === undefined ? undefined : reservations!.read(request.reservationId, parentSessionId!);
      const existing =
        reserved === undefined ? undefined : records.find((record) => record.sessionId === reserved.sessionId);
      if (existing) {
        const expectedPath = worktreeDirectory({
          worktreesRoot: worktreesRoot(deps.homeDir),
          repositoryLabel: repositoryLabel(root),
          repositoryId: repositoryId(root),
          branch: request.branch,
          shortId: shortId(reserved!.sessionId),
        });
        if (
          existing.parentSessionId !== parentSessionId ||
          existing.repositoryRoot !== root ||
          existing.branch !== request.branch ||
          existing.path !== expectedPath ||
          existing.path !== reserved?.cwd ||
          (request.baseRef !== undefined && existing.baseRef !== request.baseRef) ||
          !fs.existsSync(existing.path) ||
          !(await git.listWorktreePaths(root)).includes(existing.path) ||
          (await git.repositoryRoot(existing.path)) !== existing.path ||
          (await git.currentBranch(existing.path)) !== request.branch
        )
          throw new DoomGitExpectedError(
            'invalid_request',
            'The reserved checkout no longer matches this setup.',
            false,
            'Inspect the existing branch and checkout; they will not be replaced.',
          );
        if (!requireSessionService().isLive(existing.sessionId)) {
          const session = await requireSessionService().create({
            cwd: existing.path,
            name: request.name ?? request.branch,
            parentSessionId,
            sessionProvenance: 'worktree',
            reservationId: request.reservationId,
            ...(options?.signal === undefined ? {} : { signal: options.signal }),
          });
          if (session.sessionId !== existing.sessionId)
            throw new Error('The host did not use the reserved session identity.');
        }
        await reservations!.complete(request.reservationId!, parentSessionId!);
        return existing;
      }
      const refusal = refuseSpawn({ branch: request.branch, existing: records });
      if (refusal !== undefined) {
        throw new DoomGitExpectedError('worktree_exists', refusal, false, 'Pick another branch name, or close it.');
      }
      const taskDelivery = request.task === undefined ? undefined : requireSessionDelivery();
      const existingBranch = request.checkout === 'existing';
      if (existingBranch) {
        const branches = await git.listBranches(root);
        const local = branches.local.find((branch) => branch.name === request.branch);
        const available =
          request.remote === undefined
            ? local !== undefined && local.checkedOutAt === undefined
            : local === undefined &&
              branches.remote.some((branch) => branch.remote === request.remote && branch.name === request.branch);
        if (!available)
          throw new DoomGitExpectedError(
            'invalid_request',
            local?.checkedOutAt === undefined
              ? `The branch ${request.branch} is not available to check out.`
              : `The branch ${request.branch} is already checked out at ${local.checkedOutAt}.`,
            false,
            'Pick another branch, or create a new one.',
          );
      } else {
        // ponytail: the branch list caps at 2,000 refs; use show-ref --verify if older duplicates need covering.
        if ((await git.listBranches(root)).local.some((branch) => branch.name === request.branch))
          throw new DoomGitExpectedError(
            'invalid_request',
            `The branch ${request.branch} already exists.`,
            false,
            'Pick another name, or open it as an existing branch.',
          );
      }
      const baseRef = existingBranch
        ? request.remote === undefined
          ? request.branch
          : `${request.remote}/${request.branch}`
        : (request.baseRef ?? (await git.remoteBaseRef(root)));
      if (baseRef === undefined) {
        throw new DoomGitExpectedError(
          'git_failed',
          'No remote base branch is available for this repository.',
          false,
          'Fetch a remote branch or pass an explicit baseRef.',
        );
      }
      const id = shortId(reserved?.sessionId ?? randomUUID());
      let path = worktreeDirectory({
        worktreesRoot: worktreesRoot(deps.homeDir),
        repositoryLabel: repositoryLabel(root),
        repositoryId: repositoryId(root),
        branch: request.branch,
        shortId: id,
      });
      if (request.reservationId !== undefined) {
        path = (await reservations!.prepare(request.reservationId, parentSessionId!, path)).cwd;
      }
      const recovering = reserved?.cwd !== undefined && fs.existsSync(path);
      if (
        recovering &&
        (!(await git.listWorktreePaths(root)).includes(path) || (await git.currentBranch(path)) !== request.branch)
      )
        throw new DoomGitExpectedError(
          'invalid_request',
          'The reserved checkout no longer matches this setup.',
          false,
          'Inspect the existing directory; it will not be replaced.',
        );
      // The worktree and the branch are made by one command, so they are undone
      // by one too. `worktree remove` leaves the branch behind, and a branch
      // nobody asked for is what a failed spawn used to leave on the floor.
      const cancelled = (): boolean => options?.signal?.aborted === true;
      const rollback = async (): Promise<string> => {
        if (reserved) return ` The reserved checkout at ${path} was retained for recovery.`;
        await git.removeWorktree({ repositoryRoot: root, path, force: true }).catch(() => undefined);
        // A branch that existed before this spawn is never deleted; only one it created is.
        if (existingBranch && request.remote === undefined) return '';
        const deleted = await git.deleteBranch({ repositoryRoot: root, branch: request.branch }).catch(() => false);
        return deleted ? '' : ` The branch ${request.branch} has work on it and was kept.`;
      };

      options?.onProgress?.(`creating branch ${request.branch}\u2026`);
      if (!recovering) {
        if (existingBranch)
          await git.addExistingWorktree({
            repositoryRoot: root,
            path,
            branch: request.branch,
            ...(request.remote === undefined ? {} : { remote: request.remote }),
          });
        else await git.addWorktree({ repositoryRoot: root, path, branch: request.branch, baseRef });
      }

      // Checked here rather than only inside the session call: this is the
      // point where a checkout exists that nothing has recorded yet, which is
      // exactly the state an interrupted spawn used to leave behind.
      if (cancelled()) {
        const kept = await rollback();
        throw new DoomGitExpectedError(
          'spawn_cancelled',
          `Cancelled before the session started.${kept}`,
          false,
          reserved
            ? 'Retry setup with the same branch to recover the reserved checkout.'
            : 'The worktree was removed; run it again when you are ready.',
        );
      }

      // The worktree exists from here on, so every later failure has to leave
      // it removed or recorded. An unrecorded directory on disk is the one
      // outcome with no way back: nothing would ever list it again.
      options?.onProgress?.('starting session\u2026');
      let sessionId: string;
      try {
        const session = await requireSessionService().create({
          cwd: path,
          name: request.name ?? request.branch,
          ...parented,
          sessionProvenance: 'worktree',
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          ...(request.reservationId === undefined ? {} : { reservationId: request.reservationId }),
        });
        sessionId = session.sessionId;
        if (reserved && sessionId !== reserved.sessionId)
          throw new Error('The host did not use the reserved session identity.');
      } catch (error) {
        const kept = await rollback();
        if (cancelled()) {
          throw new DoomGitExpectedError(
            'spawn_cancelled',
            `Cancelled while the session was starting.${kept}`,
            false,
            reserved
              ? 'Retry setup with the same branch to recover the reserved checkout.'
              : 'The worktree was removed; run it again when you are ready.',
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
        ...parented,
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
      if (request.task !== undefined && taskDelivery !== undefined) {
        try {
          const receipt = await taskDelivery.deliver({
            recipientKey: sessionId,
            kind: GIT_WORKTREE_DELEGATION_KIND,
            prompt: request.task,
            metadata: {
              worktreeId: record.id,
              fromRole: 'parent',
              text: request.task,
              sentAt: record.createdAt,
            },
          });
          const admission = await taskDelivery.waitForAdmission(receipt.deliveryId);
          if (admission !== 'admitted') {
            throw new DoomGitExpectedError(
              'task_delivery_failed',
              `Worktree ${record.id} was created and task delivery ${receipt.deliveryId} was persisted, but admission ${admission === 'recovery_required' ? 'requires recovery' : 'was not confirmed before the timeout'}.`,
              true,
              admission === 'recovery_required'
                ? `Call messages from worktree ${record.id} to recover the task in the recipient session. Do not resend it automatically.`
                : `Check delivery ${receipt.deliveryId} in the sender outbox or call messages from worktree ${record.id} in the recipient session before deciding whether to resend.`,
            );
          }
        } catch (error) {
          if (error instanceof DoomGitExpectedError) throw error;
          throw new DoomGitExpectedError(
            'task_delivery_failed',
            `Worktree ${record.id} was created, but task delivery failed (${String(error)}).`,
            true,
            `Inspect worktree ${record.id} and the sender outbox before using send to deliver the task. Do not recreate the worktree.`,
          );
        }
      }
      if (request.reservationId !== undefined) await reservations!.complete(request.reservationId, parentSessionId!);
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
      cleanupStorage(root, record.path);
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
      const sentAt = new Date().toISOString();
      const delivery = readSessionDelivery();
      if (delivery !== undefined) {
        const kind = peer.party === 'parent' ? GIT_WORKTREE_MESSAGE_KIND : GIT_WORKTREE_REPORT_KIND;
        const receipt = await delivery.deliver({
          recipientKey: peer.sessionId,
          kind,
          prompt:
            peer.party === 'parent'
              ? `Parent message for worktree ${record.id}:\n\n${message}`
              : `Report from worktree ${record.id}:\n\n${message}`,
          metadata: { worktreeId: record.id, fromRole: peer.party, text: message, sentAt },
        });
        const admission = await delivery.waitForAdmission(receipt.deliveryId);
        if (admission !== 'admitted') {
          throw new DoomGitExpectedError(
            'message_delivery_failed',
            `Worktree ${record.id} persisted message delivery ${receipt.deliveryId}, but admission ${admission === 'recovery_required' ? 'requires recovery' : 'was not confirmed before the timeout'}.`,
            true,
            admission === 'recovery_required'
              ? `Call messages from the recipient session to recover delivery ${receipt.deliveryId}. Do not resend it automatically.`
              : `Check delivery ${receipt.deliveryId} in the sender outbox or call messages from the recipient session before deciding whether to resend.`,
          );
        }
        return;
      }
      requireMessageInbox().send(peer.sessionId, {
        version: 1,
        worktreeId: record.id,
        // peerFor only answers for the worktree's parent or child session, so the caller has one.
        fromSessionId: context.sessionId!,
        from: peer.party,
        text: message,
        sentAt,
      });
    },

    async messages(context, id) {
      const { records } = await resolve(context);
      const record = require(records, id);
      const peer = peerFor(context, record);
      const delivery = readSessionDelivery();
      if (delivery === undefined) return requireMessageInbox().receive(record.id);
      const entries = delivery
        .inbox({ consumed: false, metadata: { worktreeId: record.id } })
        .filter(
          (entry) =>
            entry.senderKey === peer.sessionId &&
            (entry.state === 'admitted' || entry.state === 'recovery_required') &&
            (peer.party === 'parent'
              ? entry.kind === GIT_WORKTREE_REPORT_KIND
              : entry.kind === GIT_WORKTREE_MESSAGE_KIND || entry.kind === GIT_WORKTREE_DELEGATION_KIND),
        );
      return entries.map((entry) => {
        delivery.consume(entry.deliveryId);
        return {
          version: 1,
          worktreeId: record.id,
          fromSessionId: entry.senderKey,
          from: peer.party === 'parent' ? ('child' as const) : ('parent' as const),
          text:
            entry.state === 'recovery_required'
              ? `[Recovery required: prompt admission was not confirmed] ${entry.metadata.text ?? entry.prompt}`
              : (entry.metadata.text ?? entry.prompt),
          sentAt: entry.metadata.sentAt ?? '',
        };
      });
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
        cleanupStorage(root, record.path);
      }
      for (const record of plan.forget) cleanupStorage(root, record.path);
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
  const locked = async <T>(context: WorktreeContext, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    try {
      const { store } = await resolve(context);
      return await store.transaction(operation, signal);
    } catch (error) {
      if (signal?.aborted && !(error instanceof DoomGitExpectedError))
        throw new DoomGitExpectedError(
          'spawn_cancelled',
          'The worktree operation was cancelled.',
          false,
          'Inspect its recorded state before retrying.',
        );
      if (['ENOTDIR', 'EACCES', 'EROFS', 'ENOSPC'].includes(String((error as NodeJS.ErrnoException).code)))
        throw new DoomGitExpectedError(
          'registry_write_failed',
          'The worktree registry is not writable.',
          true,
          'Check permissions and free space before retrying.',
        );
      throw error;
    }
  };
  // ponytail: serialize Git lifecycle mutations, not session execution. Keeping
  // the lock across startup avoids a second lease system for partially created trees.
  return {
    ...operations,
    spawn: (context, request, options) => {
      if (sessionService === undefined)
        return Promise.reject(
          new DoomGitExpectedError(
            'hub_unavailable',
            'The cockpit session service is unavailable.',
            true,
            'Use the cockpit worktree tool after its Git server facet is available.',
          ),
        );
      // Checked before the repository lock, so unsafe input never reaches git at all.
      if (!validRefName(request.branch) || (request.baseRef !== undefined && !validRefName(request.baseRef)))
        return Promise.reject(
          new DoomGitExpectedError('invalid_request', 'That is not a valid branch name.', false, 'Pick another name.'),
        );
      if (request.reservationId !== undefined && context.sessionId === undefined)
        return Promise.reject(
          new DoomGitExpectedError(
            'invalid_request',
            'A reserved worktree session requires its owning parent.',
            false,
            'Create the session from its pending setup card.',
          ),
        );
      return locked(context, () => operations.spawn(context, request, options), options?.signal);
    },
    close: (context, id, force) => locked(context, () => operations.close(context, id, force)),
    list: (context) => locked(context, () => operations.list(context)),
    merge: (context, id, message) => locked(context, () => operations.merge(context, id, message)),
    prune: (context, dryRun) => locked(context, () => operations.prune(context, dryRun)),
  };
}
