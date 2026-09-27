export interface SessionGitStatus {
  readonly branch: string;
  /** True when tracked files have uncommitted changes. Untracked files are ignored to keep large trees cheap. */
  readonly dirty: boolean;
}
