import { describe, expect, it } from 'vitest';
import { isInsideDirectory } from '../../src/services/pathScope.ts';

describe('isInsideDirectory', () => {
  it('accepts the directory itself', () => {
    expect(isInsideDirectory('/home/me/repo', '/home/me/repo')).toBe(true);
  });

  it('accepts something under it', () => {
    expect(isInsideDirectory('/home/me/repo/packages/api', '/home/me/repo')).toBe(true);
  });

  it('refuses a sibling that merely starts with the same letters', () => {
    // Without the separator this passes, which would let /work claim
    // /workspace-secrets and turn a boundary into a string comparison.
    expect(isInsideDirectory('/home/me/repo-secrets', '/home/me/repo')).toBe(false);
  });

  it('refuses a parent of the directory', () => {
    expect(isInsideDirectory('/home/me', '/home/me/repo')).toBe(false);
  });

  it('resolves both sides before comparing', () => {
    expect(isInsideDirectory('/home/me/repo/../repo/src', '/home/me/./repo')).toBe(true);
  });

  it('does not let a traversal climb out', () => {
    expect(isInsideDirectory('/home/me/repo/../elsewhere', '/home/me/repo')).toBe(false);
  });

  it('tolerates a trailing separator on the root', () => {
    expect(isInsideDirectory('/home/me/repo/src', '/home/me/repo/')).toBe(true);
  });
});
