import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireBootstrapClaim } from '../../src/adapters/bootstrapClaim.ts';

describe('bootstrap claim', () => {
  it('gives the load cycle to the first caller for a repository', () => {
    const root = path.join('/tmp', 'doompi-claim-first');
    const release = acquireBootstrapClaim(root);

    expect(release).toBeTypeOf('function');
    expect(acquireBootstrapClaim(root)).toBeUndefined();

    release?.();
  });

  it('matches repositories by resolved path rather than by spelling', () => {
    const root = path.join('/tmp', 'doompi-claim-spelling');
    const release = acquireBootstrapClaim(root);

    expect(acquireBootstrapClaim(path.join(root, 'nested', '..'))).toBeUndefined();

    release?.();
  });

  it('claims unrelated repositories independently', () => {
    const first = acquireBootstrapClaim(path.join('/tmp', 'doompi-claim-a'));
    const second = acquireBootstrapClaim(path.join('/tmp', 'doompi-claim-b'));

    expect(first).toBeTypeOf('function');
    expect(second).toBeTypeOf('function');

    first?.();
    second?.();
  });

  it('frees the cycle again on release, and ignores a stale release', () => {
    const root = path.join('/tmp', 'doompi-claim-release');
    const first = acquireBootstrapClaim(root);
    first?.();

    const second = acquireBootstrapClaim(root);
    expect(second).toBeTypeOf('function');

    // The first holder released long ago; replaying it must not evict the second.
    first?.();
    expect(acquireBootstrapClaim(root)).toBeUndefined();

    second?.();
  });
});
