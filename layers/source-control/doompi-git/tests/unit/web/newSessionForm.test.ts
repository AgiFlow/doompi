import { describe, expect, it } from 'vitest';

import {
  baseOptions,
  branchOptions,
  createRequest,
  formProblem,
  type NewSessionFormState,
} from '../../../src/extensions/workspaces/(frontend)/_lib/newSessionForm';
import type { GitBranches } from '../../../src/types/gitSessions';

const branches: GitBranches = {
  current: 'main',
  defaultBase: 'origin/main',
  local: [{ name: 'main', checkedOutAt: '/repo' }, { name: 'feature/existing' }, { name: 'fix/login' }],
  remote: [{ remote: 'origin', name: 'remote-only' }],
};

const form = (patch: Partial<NewSessionFormState>): NewSessionFormState => ({
  mode: 'existing',
  newBranch: '',
  baseRef: '',
  name: '',
  ...patch,
});

describe('branchOptions', () => {
  it('lists local branches first, marks the current and checked-out ones, then remote-only branches', () => {
    expect(branchOptions(branches, '')).toEqual([
      { key: 'local:main', name: 'main', current: true, busyAt: '/repo' },
      { key: 'local:feature/existing', name: 'feature/existing', current: false },
      { key: 'local:fix/login', name: 'fix/login', current: false },
      { key: 'remote:origin/remote-only', name: 'remote-only', remote: 'origin', current: false },
    ]);
  });

  it('filters by a case-insensitive substring, including the remote name', () => {
    expect(branchOptions(branches, 'FIX').map((option) => option.name)).toEqual(['fix/login']);
    expect(branchOptions(branches, 'origin/').map((option) => option.key)).toEqual(['remote:origin/remote-only']);
  });
});

describe('baseOptions', () => {
  it('offers the default base first, then remote-tracking names, then local branches, without repeats', () => {
    expect(baseOptions(branches)).toEqual([
      'origin/main',
      'origin/remote-only',
      'main',
      'feature/existing',
      'fix/login',
    ]);
  });
});

describe('formProblem and createRequest', () => {
  it('requires a free branch in existing mode and a name in new mode', () => {
    expect(formProblem(form({}))).toBe('Pick a branch.');
    expect(formProblem(form({ selected: branchOptions(branches, 'main')[0] }))).toBe(
      'That branch is checked out at /repo.',
    );
    expect(formProblem(form({ mode: 'new' }))).toBe('Name the new branch.');
    expect(formProblem(form({ mode: 'plain' }))).toBeUndefined();
  });

  it('builds the worktree request for each mode and nothing for a plain session', () => {
    const [, existing] = branchOptions(branches, '');
    const remote = branchOptions(branches, 'remote-only')[0];
    expect(createRequest(form({ selected: existing, name: '  ' }))).toEqual({
      mode: 'existing-branch',
      branch: 'feature/existing',
    });
    expect(createRequest(form({ selected: remote, name: 'Fix' }))).toEqual({
      mode: 'existing-branch',
      branch: 'remote-only',
      remote: 'origin',
      name: 'Fix',
    });
    expect(createRequest(form({ mode: 'new', newBranch: ' wt/new ', baseRef: 'origin/main' }))).toEqual({
      mode: 'new-branch',
      branch: 'wt/new',
      baseRef: 'origin/main',
    });
    expect(createRequest(form({ mode: 'plain', name: 'notes' }))).toBeUndefined();
  });
});
