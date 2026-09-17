#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitestArgs = [
  '--silent',
  '--filter',
  '@agimon-ai/doompi',
  'exec',
  'vitest',
  'list',
  '--config',
  'vitest.system.config.ts',
  '--json',
];
const shardValues = ['1', '2', '3'];

function fail(message) {
  throw new Error(message);
}

function parseTestList(output, label) {
  const starts = [...output.matchAll(/^\s*\[/gm)];
  const end = output.lastIndexOf(']');
  for (const match of starts) {
    const start = match.index;
    if (start === undefined || end < start) continue;
    try {
      const value = JSON.parse(output.slice(start, end + 1));
      if (Array.isArray(value)) return value;
    } catch {
      // Keep looking in case pnpm or a plugin wrote a bracketed warning first.
    }
  }
  fail(`${label} did not produce a JSON test list`);
}

function runVitestList(shard, benchmark) {
  const env = { ...process.env };
  delete env.DOOMPI_SYSTEM_SHARD;
  delete env.DOOMPI_STARTUP_BENCHMARK;
  if (shard !== undefined) env.DOOMPI_SYSTEM_SHARD = shard;
  if (benchmark) env.DOOMPI_STARTUP_BENCHMARK = '1';

  const result = spawnSync('pnpm', vitestArgs, {
    cwd: root,
    encoding: 'utf8',
    env,
  });
  const label = `${benchmark ? 'benchmark' : 'default'}${shard ? ` shard ${shard}` : ' baseline'}`;
  if (result.error) fail(`${label} collection could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${label} collection failed${output ? `:\n${output}` : ''}`);
  }

  const tests = parseTestList(String(result.stdout ?? ''), label);
  return tests.map((test, index) => {
    if (!test || typeof test !== 'object' || typeof test.file !== 'string' || typeof test.name !== 'string') {
      fail(`${label} returned an invalid test entry at index ${index}`);
    }
    return { file: test.file, name: test.name };
  });
}

function testKey(test) {
  return JSON.stringify([test.file, test.name]);
}

function testCounts(tests) {
  const counts = new Map();
  for (const test of tests) {
    const key = testKey(test);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function assertSameInventory(expected, actual, label) {
  const expectedCounts = testCounts(expected);
  const actualCounts = testCounts(actual);
  const keys = new Set([...expectedCounts.keys(), ...actualCounts.keys()]);
  const differences = [...keys].filter((key) => expectedCounts.get(key) !== actualCounts.get(key));
  if (differences.length > 0 || expected.length !== actual.length) {
    fail(
      `${label} differs from the baseline (${expected.length} expected, ${actual.length} actual): ${differences
        .slice(0, 3)
        .join(', ')}`,
    );
  }
}

function assertDisjoint(shards, label) {
  const owners = new Map();
  for (const [index, tests] of shards.entries()) {
    for (const test of tests) {
      const key = testKey(test);
      const previous = owners.get(key);
      if (previous !== undefined && previous !== index) {
        fail(`${label} overlaps between shards ${previous + 1} and ${index + 1}: ${key}`);
      }
      owners.set(key, index);
    }
  }
}

function assertShardCoverage(benchmark) {
  const label = benchmark ? 'benchmark shard coverage' : 'default shard coverage';
  const baseline = runVitestList(undefined, benchmark);
  const shards = shardValues.map((shard) => runVitestList(shard, benchmark));

  if (baseline.length === 0) fail(`${label} baseline is empty`);
  for (const [index, shard] of shards.entries()) {
    if (shard.length === 0) fail(`${label} shard ${index + 1} is empty`);
  }

  assertDisjoint(shards, label);
  assertSameInventory(baseline, shards.flat(), label);
}

function assertInvalidShardFails() {
  const env = { ...process.env, DOOMPI_SYSTEM_SHARD: '4' };
  const result = spawnSync('pnpm', vitestArgs, { cwd: root, encoding: 'utf8', env });
  if (result.error) fail(`invalid shard check could not start: ${result.error.message}`);
  if (result.status === 0) fail('invalid DOOMPI_SYSTEM_SHARD value unexpectedly succeeded');
}

assertShardCoverage(false);
assertShardCoverage(true);
assertInvalidShardFails();
process.stdout.write('System-test shard coverage passed for default and benchmark inventories.\n');
