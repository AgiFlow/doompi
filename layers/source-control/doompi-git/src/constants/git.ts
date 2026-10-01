export const COMMAND_NAME = 'doom-git';
export const COMMAND_DESCRIPTION = 'Show git worktrees owned by this session';
/** The package API base path; the cockpit mounts it at /api/workspaces/<id>/plugins/git. */
export const GIT_API_BASE_PATH = 'git';
/** Workspace-mounted routes behind the new-session dialog. */
export const GIT_BRANCHES_PATH = '/branches';
export const GIT_SESSIONS_PATH = '/sessions';
/** Workspace-mounted: that workspace's remote auth for manual pull, push and rebase. */
export const GIT_AUTH_PATH = '/auth';
/** Session-mounted: the session's change against its base, and one file's hunks. */
export const GIT_REVIEW_PATH = '/review';
export const GIT_REVIEW_FILE_PATH = '/review/file';
