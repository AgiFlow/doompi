import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeProjects, shardProjects, validateShards } from './run-release-test-shard.mjs';

test('release test shards form a deterministic complete partition', () => {
  const projects = ['zeta', 'alpha', 'middle', 'beta', 'omega'];
  const shards = validateShards(projects, 2);

  assert.deepEqual(shards, [
    ['alpha', 'middle', 'zeta'],
    ['beta', 'omega'],
  ]);
  assert.deepEqual(shardProjects(projects, 1, 2), shards[0]);
});

test('release test inventory rejects duplicates and empty shards', () => {
  assert.throws(() => normalizeProjects(['duplicate', 'duplicate']), /duplicate/);
  assert.throws(() => validateShards(['only'], 2), /empty/);
  assert.throws(() => shardProjects(['one'], 3, 2), /between 1 and 2/);
});
