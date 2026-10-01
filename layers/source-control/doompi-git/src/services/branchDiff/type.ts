import type { GitChangesView, GitReviewFileDiff, GitReviewSummary } from '../../types/gitReview';

/** Where a checkout's review starts from. */
export interface ReviewBase {
  /** The ref named in the UI, absent when nothing resolved and only uncommitted work counts. */
  ref?: string;
  /** The commit the diff is taken against: the merge base, HEAD, or the empty tree. */
  from: string;
  /** Short sha of the merge base, for the header. */
  mergeBase?: string;
}

export interface BranchReview {
  summary: GitReviewSummary;
  changes: GitChangesView;
  base: ReviewBase;
  /** Toplevel of the checkout, the directory every later call runs in. */
  root: string;
}

export interface BranchDiffOptions {
  /** The base the worktree was created from, when the session owns a registry record. */
  recordedBaseRef?: string;
}

export interface BranchDiff {
  /** The whole picture for one checkout, or undefined outside a git repository. */
  review(cwd: string, options?: BranchDiffOptions): Promise<BranchReview | undefined>;
  /** One changed file's hunks. The path must come from the change set the caller just computed. */
  fileDiff(review: BranchReview, path: string): Promise<GitReviewFileDiff>;
}
