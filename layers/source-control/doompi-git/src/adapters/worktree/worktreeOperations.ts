import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { installDependencies } from './dependencyInstall.ts';
import { createWorktreeSession, HubUnavailableError, sessionIsLive, stopWorktreeSession } from '../hub/hubClient.ts';
import { channelRoot, hubRegistryDir, registryFile, worktreesRoot } from '../filesystem/paths.ts';
import { repositoryId, repositoryLabel, shortId } from './repositoryIdentity.ts';
import { createWorktreeChannel } from '../channel/worktreeChannel.ts';
import type { ChannelMessage, ChannelParty } from '../channel/worktreeChannel.ts';
import { createWorktreeRegistry } from './worktreeRegistry.ts';
import { WORKTREE_RECORD_VERSION } from '../../types/worktreeRegistry.ts';
import type { WorktreeGit, WorktreeRecord } from '../../types/worktreeRegistry.ts';
import { planPrune, reconcile, refuseClose, refuseSpawn, worktreeDirectory } from '../../services/worktreeNaming.ts';
import { DoomGitExpectedError } from '../../services/support/errors.ts';

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

export interface WorktreeOperations {
  spawn(context: WorktreeContext, request: SpawnWorktreeRequest): Promise<WorktreeRecord>;
  close(context: WorktreeContext, id: string, force: boolean): Promise<WorktreeRecord>;
  list(context: WorktreeContext): Promise<WorktreeRecord[]>;
  status(context: WorktreeContext, id: string): Promise<{ record: WorktreeRecord; dirtyFiles: string[] }>;
  merge(context: WorktreeContext, id: string, message?: string): Promise<WorktreeRecord>;
  prune(context: WorktreeContext, dryRun: boolean): Promise<ReturnType<typeof planPrune>>;
  send(context: WorktreeContext, id: string, message: string): Promise<void>;
  messages(context: WorktreeContext, id: string): Promise<ChannelMessage[]>;
}

export interface WorktreeOperationsDeps {
  git: WorktreeGit;
  /** Injected so tests never reach the network. */
  createSession?: typeof createWorktreeSession;
  /** Injected so tests never run a package manager. */
  install?: typeof installDependencies;
  stopSession?: typeof stopWorktreeSession;
  isSessionLive?: typeof sessionIsLive;
  homeDir?: string;
  registryDir?: string;
  /** Injected so a record's createdAt is reproducible in a test. */
  now?: () => Date;
}

export function createWorktreeOperations(deps: WorktreeOperationsDeps): WorktreeOperations {
  const { git } = deps;
  const createSession = deps.createSession ?? createWorktreeSession;
  const install = deps.install ?? installDependencies;
  const stopSession = deps.stopSession ?? stopWorktreeSession;
  const isSessionLive = deps.isSessionLive ?? sessionIsLive;
  const registryDir = deps.registryDir ?? hubRegistryDir();
  const now = deps.now ?? (() => new Date());
  const probe = {
    alive: (record: WorktreeRecord) => isSessionLive(registryDir, record.sessionId),
    exists: (path: string) => fs.existsSync(path),
  };

  /**
   * Everything an action needs about the repository it is acting on.
   *
   * Resolved per call rather than cached: a session's cwd is stable, but the
   * registry file is shared with the cockpit panel and another process may
   * have written it since the last call.
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

  return {
    async spawn(context, request) {
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

      await git.addWorktree({ repositoryRoot: root, path, branch: request.branch, baseRef });

      // Before the session, not after. The session resolves this repository's
      // composition, and every workspace package path in it points at a
      // directory that exists only once dependencies are linked. Starting the
      // session first makes it fall back to the global bundle and quietly lose
      // the repository's own packages.
      const installed = await install(path);
      if (installed.kind === 'failed') {
        await git.removeWorktree({ repositoryRoot: root, path, force: true }).catch(() => undefined);
        throw new DoomGitExpectedError(
          'install_failed',
          `${installed.command} install failed in the new worktree (exit ${String(installed.code ?? 'unknown')}).`,
          true,
          'Run the install by hand in the repository to see what it reports, then try again.',
        );
      }

      // The worktree exists from here on, so every later failure has to leave
      // it removed or recorded. An unrecorded directory on disk is the one
      // outcome with no way back: nothing would ever list it again.
      let sessionId: string;
      try {
        sessionId = await createSession({
          cwd: path,
          name: request.name ?? request.branch,
          parentSessionId: context.sessionId,
          registryDir,
        });
      } catch (error) {
        await git.removeWorktree({ repositoryRoot: root, path, force: true }).catch(() => undefined);
        if (error instanceof HubUnavailableError) {
          throw new DoomGitExpectedError('hub_unavailable', error.message, true, 'Start the cockpit and try again.');
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
      store.replace([...records, record]);
      return record;
    },

    async close(context, id, force) {
      const { root, store, records } = await resolve(context);
      const record = require(records, id);
      const dirtyFiles = fs.existsSync(record.path) ? await git.dirtyFiles(record.path) : [];
      const refusal = refuseClose({ record, dirtyFiles, force });
      if (refusal !== undefined) {
        throw new DoomGitExpectedError('worktree_dirty', refusal, false, 'Commit the work, or pass force: true.');
      }
      // The session is stopped before the directory goes. Removing a checkout
      // while a process still holds files open in it is how a half-removed
      // worktree and a stale git administrative entry are made.
      await stopSession(registryDir, record.sessionId);
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

    /**
     * Which side of the channel the caller is.
     *
     * A worktree session is the child of the record it belongs to, and the
     * parent for everything else. Deciding from the session id rather than a
     * flag means neither side can address itself by mistake.
     */
    async send(context, id, message) {
      const { records } = await resolve(context);
      const record = require(records, id);
      const party: ChannelParty = context.sessionId === record.sessionId ? 'parent' : 'child';
      createWorktreeChannel(channelRoot(record.id, deps.homeDir)).send(party, message);
    },

    async messages(context, id) {
      const { records } = await resolve(context);
      const record = require(records, id);
      const channel = createWorktreeChannel(channelRoot(record.id, deps.homeDir));
      channel.sweep();
      const party: ChannelParty = context.sessionId === record.sessionId ? 'child' : 'parent';
      return channel.receive(party);
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
      const dropped = new Set([...plan.remove, ...plan.forget].map((record) => record.id));
      store.replace(reconciled.records.filter((record) => !dropped.has(record.id)));
      return plan;
    },
  };
}
