// @scaffold-generated
import type { GitSessionCreateRequest } from '../../types/gitSessions';

/** A validated worktree-session request, or why the dialog's request was refused. */
export type NewSessionRequestResult = GitSessionCreateRequest | { readonly error: string };
