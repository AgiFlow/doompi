import { describe, expect, it } from 'vitest';

import { validateParams } from '../../../../src/tools/runWorktree';

describe('validateParams', () => {
  it.each([
    ['a string', 'spawn'],
    ['null', null],
    ['an array, which is an object but not a shape', []],
  ])('refuses %s', (_label, input) => {
    expect(() => validateParams(input)).toThrow(/must be an object/u);
  });

  it.each([
    ['a missing action', {}],
    ['an unknown action', { action: 'destroy' }],
    ['a non-string action', { action: 7 }],
  ])('refuses %s', (_label, input) => {
    expect(() => validateParams(input)).toThrow(/Unknown action/u);
  });

  it('names the actions it does accept', () => {
    expect(() => validateParams({ action: 'nope' })).toThrow(/spawn_worktree/u);
  });

  it('accepts each documented shape', () => {
    expect(validateParams({ action: 'list' })).toEqual({ action: 'list' });
    expect(validateParams({ action: 'spawn_worktree', branch: 'wt/x' })).toEqual({
      action: 'spawn_worktree',
      branch: 'wt/x',
    });
    expect(validateParams({ action: 'prune', dryRun: true })).toEqual({ action: 'prune', dryRun: true });
    expect(validateParams({ action: 'merge', id: 'a1', message: 'm' })).toEqual({
      action: 'merge',
      id: 'a1',
      message: 'm',
    });
  });

  // The point of the allowlist: a field that belongs to another action is a
  // different operation than the one the call reads like.
  it('refuses a field that belongs to a different action', () => {
    expect(() => validateParams({ action: 'close_worktree', id: 'a1', branch: 'wt/x' })).toThrow(
      /does not accept: branch/u,
    );
    expect(() => validateParams({ action: 'list', id: 'a1' })).toThrow(/does not accept: id/u);
  });

  it('tells the caller which fields the action does take', () => {
    expect(() => validateParams({ action: 'status', force: true })).toThrow(/Fields for 'status': action, id/u);
  });

  it.each([
    ['spawn_worktree without a branch', { action: 'spawn_worktree' }, /requires 'branch'/u],
    ['close_worktree without an id', { action: 'close_worktree' }, /requires 'id'/u],
    ['status without an id', { action: 'status' }, /requires 'id'/u],
    ['merge without an id', { action: 'merge' }, /requires 'id'/u],
  ])('refuses %s', (_label, input, expected) => {
    expect(() => validateParams(input)).toThrow(expected);
  });

  it.each([
    ['an empty branch', { action: 'spawn_worktree', branch: '' }],
    ['a whitespace branch', { action: 'spawn_worktree', branch: '   ' }],
    ['an empty id', { action: 'status', id: '' }],
    ['a non-string id', { action: 'status', id: 5 }],
  ])('refuses %s', (_label, input) => {
    expect(() => validateParams(input)).toThrow(/nonblank|requires/u);
  });
});
