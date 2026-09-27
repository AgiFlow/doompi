import type { GitBranches, GitSessionCreateRequest } from '../../../../types/gitSessions';

export type NewSessionMode = 'existing' | 'new' | 'plain';

/** One row of the branch picker: a local branch, or a remote-only one. */
export interface BranchOption {
  key: string;
  name: string;
  remote?: string;
  current: boolean;
  /** Set when the branch is checked out elsewhere and cannot get a second worktree. */
  busyAt?: string;
}

export interface NewSessionFormState {
  mode: NewSessionMode;
  /** The picked existing branch. */
  selected?: BranchOption;
  newBranch: string;
  baseRef: string;
  name: string;
}

const MAX_LISTED = 200;

/** Local branches first, then remote-only ones, filtered by a case-insensitive substring. */
export function branchOptions(branches: GitBranches, query: string): BranchOption[] {
  const needle = query.trim().toLowerCase();
  const matches = (text: string): boolean => needle === '' || text.toLowerCase().includes(needle);
  const local = branches.local
    .filter((branch) => matches(branch.name))
    .map((branch) => ({
      key: `local:${branch.name}`,
      name: branch.name,
      current: branch.name === branches.current,
      ...(branch.checkedOutAt === undefined ? {} : { busyAt: branch.checkedOutAt }),
    }));
  const remote = branches.remote
    .filter((branch) => matches(`${branch.remote}/${branch.name}`))
    .map((branch) => ({
      key: `remote:${branch.remote}/${branch.name}`,
      name: branch.name,
      remote: branch.remote,
      current: false,
    }));
  return [...local, ...remote].slice(0, MAX_LISTED);
}

/** Every base a new branch can start from: the default first, then remote-tracking names, then local branches. */
export function baseOptions(branches: GitBranches): string[] {
  const names = new Set([
    ...(branches.defaultBase === undefined ? [] : [branches.defaultBase]),
    ...branches.remote.map((branch) => `${branch.remote}/${branch.name}`),
    ...branches.local.map((branch) => branch.name),
  ]);
  return [...names];
}

/** Why the form cannot be submitted yet, or undefined when it can. */
export function formProblem(state: NewSessionFormState): string | undefined {
  if (state.mode === 'existing') {
    if (state.selected === undefined) return 'Pick a branch.';
    if (state.selected.busyAt !== undefined) return `That branch is checked out at ${state.selected.busyAt}.`;
  }
  if (state.mode === 'new' && state.newBranch.trim() === '') return 'Name the new branch.';
  return undefined;
}

/** The worktree create request for the form, or undefined in plain mode. */
export function createRequest(state: NewSessionFormState): GitSessionCreateRequest | undefined {
  const name = state.name.trim();
  const named = name === '' ? {} : { name };
  if (state.mode === 'existing' && state.selected !== undefined)
    return {
      mode: 'existing-branch',
      branch: state.selected.name,
      ...(state.selected.remote === undefined ? {} : { remote: state.selected.remote }),
      ...named,
    };
  if (state.mode === 'new') {
    const baseRef = state.baseRef.trim();
    return {
      mode: 'new-branch',
      branch: state.newBranch.trim(),
      ...(baseRef === '' ? {} : { baseRef }),
      ...named,
    };
  }
  return undefined;
}
