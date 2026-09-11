import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-extension-contracts/package-api';
import { createWorktreeGit } from './worktree/gitCli.ts';
import { createWorktreeOperations } from './worktree/worktreeOperations.ts';
import { DoomGitExpectedError } from '../services/support/errors.ts';
import { GIT_WORKTREE_LIFECYCLE_EVENT } from './worktree/worktreeEvents.ts';

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
  basePath: 'git',
  start(context: DoomApiContext): DoomApiHandler {
    if (context.directEvents === undefined) throw new Error('Git hub API requires the direct event bus.');
    const directEvents = context.directEvents;
    const publishLifecycle = (sessionId: string, repositoryRoot: string): void => {
      directEvents.publish(GIT_WORKTREE_LIFECYCLE_EVENT, sessionId, { version: 1 as const, repositoryRoot });
    };
    const operations = createWorktreeOperations({
      git: createWorktreeGit(),
      sessionService: context.sessionService,
    });

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
