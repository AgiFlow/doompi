#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT_QUERY = ['nx', 'show', 'projects', '--with-target=test', '--json'];

export function normalizeProjects(projects) {
  if (!Array.isArray(projects) || projects.some((project) => typeof project !== 'string' || project.length === 0)) {
    throw new Error('Nx returned an invalid test-project inventory');
  }

  const sorted = [...projects].sort();
  if (new Set(sorted).size !== sorted.length) throw new Error('Nx returned duplicate test projects');
  return sorted;
}

export function shardProjects(projects, shard, shardCount) {
  const normalized = normalizeProjects(projects);
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error('shardCount must be a positive integer');
  if (!Number.isInteger(shard) || shard < 1 || shard > shardCount) {
    throw new Error(`shard must be between 1 and ${shardCount}`);
  }

  return normalized.filter((_, index) => index % shardCount === shard - 1);
}

export function validateShards(projects, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error('shardCount must be a positive integer');
  const normalized = normalizeProjects(projects);
  const shards = Array.from({ length: shardCount }, (_, index) => shardProjects(normalized, index + 1, shardCount));
  if (shards.some((shard) => shard.length === 0)) throw new Error('A release test shard is empty');

  const flattened = shards.flat();
  if (flattened.length !== normalized.length || new Set(flattened).size !== normalized.length) {
    throw new Error('Release test shards do not form a disjoint complete project inventory');
  }
  return shards;
}

function testProjects() {
  const output = execFileSync('pnpm', PROJECT_QUERY, { encoding: 'utf8' });
  return normalizeProjects(JSON.parse(output));
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function main() {
  const [command, shardValue, countValue] = process.argv.slice(2);
  const shardCountValue = command === 'check' ? shardValue : countValue;
  const shardCount = parsePositiveInteger(shardCountValue, 'shard count');
  const projects = testProjects();
  const shards = validateShards(projects, shardCount);

  if (command === 'check') {
    for (const [index, shard] of shards.entries()) {
      console.log(`Release test shard ${index + 1}/${shardCount}: ${shard.join(', ')}`);
    }
    return;
  }

  if (command !== 'run') throw new Error('Usage: run-release-test-shard.mjs <check|run> <shard> <shard-count>');
  const shard = parsePositiveInteger(shardValue, 'shard');
  const selected = shards[shard - 1];
  if (!selected) throw new Error(`shard must be between 1 and ${shardCount}`);
  console.log(`Running release test shard ${shard}/${shardCount}: ${selected.join(', ')}`);

  const result = spawnSync(
    'pnpm',
    ['nx', 'run-many', '-t', 'test', `--projects=${selected.join(',')}`, '--parallel=1'],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) main();
