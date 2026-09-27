/** A local branch; `checkedOutAt` names the worktree that has it checked out, if any. */
export interface GitLocalBranch {
  name: string;
  checkedOutAt?: string;
}

/** A remote-tracking branch with no local branch of the same name. */
export interface GitRemoteBranch {
  remote: string;
  name: string;
}

/** A repository's branches for the new-session dialog, most recently committed first. */
export interface GitBranches {
  /** The branch the repository root has checked out; absent when detached. */
  current?: string;
  /** Where new branches start by default: the remote's default branch, else the current one. */
  defaultBase?: string;
  local: GitLocalBranch[];
  remote: GitRemoteBranch[];
}

/** `GET` branches for the workspace; `repository` is false when the workspace is not a git checkout. */
export type GitBranchesResponse = GitBranches & { repository: boolean };

/** A worktree session: on an existing branch (a remote one gets a local tracking branch), or on a new one. */
export type GitSessionCreateRequest =
  | { mode: 'existing-branch'; branch: string; remote?: string; name?: string }
  | { mode: 'new-branch'; branch: string; baseRef?: string; name?: string };

export interface GitSessionCreated {
  sessionId: string;
  worktreeId: string;
}
