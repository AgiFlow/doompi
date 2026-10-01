import { apiResponse, defineApiRoutes } from '@agimon-ai/doompi-core/web';

import type { GitAuthView } from './gitAuth';
import type { GitReviewFileDiff, GitReviewSummary } from './gitReview';
import type { GitBranchesResponse, GitSessionCreated } from './gitSessions';

/**
 * The routes the page calls, as data.
 *
 * No scope and no base path: the build reads both off
 * `src/extensions/(backend)/api/git/`, which mounts at global scope and so
 * answers workspace and session requests too. Each route answers only where it
 * belongs (auth on a workspace mount, the review on a session mount), so a
 * client accessor on the wrong scope gets a 404 rather than a second way in.
 *
 * Only what the browser calls is listed. The worktree routes stay HTTP for
 * other callers, but the dock drives worktrees over its channel.
 */
export default defineApiRoutes({
  /** Workspace: the new-session dialog's branch list. */
  branches: {
    method: 'GET',
    path: '/branches',
    response: apiResponse<GitBranchesResponse>(),
  },
  /** Workspace: a top-level worktree session on an existing or new branch. */
  createSession: {
    method: 'POST',
    path: '/sessions',
    response: apiResponse<GitSessionCreated>(),
  },
  /** Workspace: that workspace's saved remote auth, never the token itself. */
  auth: {
    method: 'GET',
    path: '/auth',
    query: ['repositoryId'],
    response: apiResponse<GitAuthView>(),
  },
  /** Workspace: replaces that workspace's remote auth. Passkey step-up gated for remote devices. */
  saveAuth: {
    method: 'PUT',
    path: '/auth',
    query: ['repositoryId'],
    response: apiResponse<GitAuthView>(),
  },
  /** Session: the files this session's checkout changed against its base. */
  review: {
    method: 'GET',
    path: '/review',
    response: apiResponse<GitReviewSummary>(),
  },
  /** Session: one changed file's hunks. */
  reviewFile: {
    method: 'GET',
    path: '/review/file',
    query: ['path'],
    response: apiResponse<GitReviewFileDiff>(),
  },
});
