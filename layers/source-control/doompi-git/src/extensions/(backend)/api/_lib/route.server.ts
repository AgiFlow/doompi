import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-core/packageApi';

import { GIT_API_BASE_PATH, GIT_BRANCHES_PATH, GIT_SESSIONS_PATH } from '../../../../constants/git';
import { DoomGitExpectedError } from '../../../../services/errors';
import { createWorktreeGit } from '../../../../services/gitCli';
import { newSessionRequest } from '../../../../services/newSessionRequest';
import { GIT_WORKTREE_LIFECYCLE_EVENT } from '../../../../services/worktreeEvents';
import { createWorktreeOperations } from '../../../../services/worktreeOperations';
import type { GitBranchesResponse, GitSessionCreated } from '../../../../types/gitSessions';

/**
 * The worktree surface the cockpit panel calls.
 *
 * Hub-scoped because worktrees are a property of a repository, not of one
 * session: the panel lists and creates them whether or not the session that
 * made them is focused, and a session-scoped API would disappear with it.
 *
 * The panel names a repository by the hub's opaque id and never by path.
 * `resolveRepository` turns that into an admitted root, so a browser cannot
 * point this at a directory the cockpit was never given.
 */
function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

function failed(error: unknown): Response {
  if (error instanceof DoomGitExpectedError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.retryable ? 503 : 409 });
  }
  // Never the raw message: a git failure can carry a remote URL with a token.
  return Response.json({ error: 'The worktree operation failed.' }, { status: 500 });
}

export const api: DoomApi = {
  basePath: GIT_API_BASE_PATH,
  start(context: DoomApiContext): DoomApiHandler {
    if (context.directEvents === undefined) throw new Error('Git hub API requires the direct event bus.');
    const directEvents = context.directEvents;
    const publishLifecycle = (sessionId: string, repositoryRoot: string): void => {
      directEvents.publish(GIT_WORKTREE_LIFECYCLE_EVENT, sessionId, { version: 1 as const, repositoryRoot });
    };
    const git = createWorktreeGit();
    const operations = createWorktreeOperations({
      git,
      sessionService: context.sessionService,
      ...(context.homeDirectory === undefined ? {} : { homeDir: context.homeDirectory }),
    });

    /**
     * The new-session dialog's routes: the workspace's branches, and a top-level
     * worktree session on one. Workspace-mounted only, and always rooted at the
     * mount's own workspace, so a request can never name another directory.
     */
    const newSession = async (request: Request, url: URL): Promise<Response | undefined> => {
      const isBranches = request.method === 'GET' && url.pathname === GIT_BRANCHES_PATH;
      const isCreate = request.method === 'POST' && url.pathname === GIT_SESSIONS_PATH;
      if (!isBranches && !isCreate) return undefined;
      const workspaceRoot = context.scope === 'workspace' ? context.workspaceRoot : undefined;
      if (workspaceRoot === undefined)
        return Response.json({ error: 'This route belongs to a workspace.' }, { status: 404 });
      if (isBranches) {
        const repositoryRoot = await git.repositoryRoot(workspaceRoot);
        const branches: GitBranchesResponse =
          repositoryRoot === undefined
            ? { repository: false, local: [], remote: [] }
            : { repository: true, ...(await git.listBranches(repositoryRoot)) };
        return Response.json(branches);
      }
      const parsed = newSessionRequest(await request.json().catch(() => undefined));
      if ('error' in parsed) return badRequest(parsed.error);
      const record = await operations.spawn(
        { cwd: workspaceRoot },
        {
          branch: parsed.branch,
          checkout: parsed.mode === 'existing-branch' ? 'existing' : 'new',
          ...(parsed.mode === 'existing-branch' && parsed.remote !== undefined ? { remote: parsed.remote } : {}),
          ...(parsed.mode === 'new-branch' && parsed.baseRef !== undefined ? { baseRef: parsed.baseRef } : {}),
          ...(parsed.name === undefined ? {} : { name: parsed.name }),
        },
      );
      publishLifecycle(record.sessionId, record.repositoryRoot);
      const created: GitSessionCreated = { sessionId: record.sessionId, worktreeId: record.id };
      return Response.json(created, { status: 201 });
    };

    /** The admitted root for a request, or a response explaining why not. */
    const rootOf = (url: URL): string | Response => {
      const repositoryId = url.searchParams.get('repositoryId');
      if (repositoryId === null || repositoryId === '') return badRequest('A repositoryId is required.');
      const root = context.resolveRepository?.(repositoryId);
      if (root === undefined) return badRequest('That repository is not admitted to this cockpit.');
      return root;
    };

    return {
      async fetch(request) {
        const url = new URL(request.url);
        try {
          const answered = await newSession(request, url);
          if (answered !== undefined) return answered;
        } catch (error) {
          context.onNotice(`new-session request failed: ${(error as Error).name}`);
          return failed(error);
        }
        const root = rootOf(url);
        if (root instanceof Response) return root;
        // The operations layer works from a cwd, and an admitted repository
        // root is one.
        const callerContext = { cwd: root, sessionId: url.searchParams.get('sessionId') ?? '' };
        const isMutation =
          (request.method === 'POST' && url.pathname === '/worktrees') ||
          (request.method === 'DELETE' && /^\/worktrees\/[^/]+$/u.test(url.pathname));
        if (isMutation && callerContext.sessionId === '')
          return badRequest('A sessionId is required for worktree mutations.');

        try {
          if (request.method === 'GET' && url.pathname === '/worktrees') {
            return Response.json({ worktrees: await operations.list(callerContext) });
          }
          if (request.method === 'POST' && url.pathname === '/worktrees') {
            const body = (await request.json()) as { branch?: string; baseRef?: string; name?: string };
            if (typeof body.branch !== 'string' || body.branch.trim() === '') {
              return badRequest('A branch is required.');
            }
            const record = await operations.spawn(callerContext, {
              branch: body.branch,
              ...(body.baseRef === undefined ? {} : { baseRef: body.baseRef }),
              ...(body.name === undefined ? {} : { name: body.name }),
            });
            publishLifecycle(callerContext.sessionId, record.repositoryRoot);
            return Response.json({ worktree: record }, { status: 201 });
          }
          const closing = /^\/worktrees\/([^/]+)$/u.exec(url.pathname);
          if (request.method === 'DELETE' && closing) {
            const record = await operations.close(
              callerContext,
              decodeURIComponent(String(closing[1])),
              url.searchParams.get('force') === 'true',
            );
            publishLifecycle(callerContext.sessionId, record.repositoryRoot);
            return Response.json({ worktree: record });
          }
          return Response.json({ error: 'No such worktree route.' }, { status: 404 });
        } catch (error) {
          context.onNotice(`worktree request failed: ${(error as Error).name}`);
          return failed(error);
        }
      },
      close() {},
    };
  },
};

export default api;
