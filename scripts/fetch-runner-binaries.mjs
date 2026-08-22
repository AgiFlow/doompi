#!/usr/bin/env node
// Materializes the Runner's native payloads from their upstream GitHub releases.
//
// These binaries used to live in the repository through Git LFS. That put ~156 MB
// behind every clone and metered it against a bandwidth quota that a few hundred
// clones exhaust, at which point cloning fails for everyone. Upstream already
// publishes the exact artifacts, so the repository records their checksums and
// fetches on demand instead of storing them.
//
//   node scripts/fetch-runner-binaries.mjs            materialize what is missing
//   node scripts/fetch-runner-binaries.mjs --check    verify only, exit 1 on drift
//   node scripts/fetch-runner-binaries.mjs --force    re-download and replace
//
// Every file is verified against a pinned SHA-256 before it is installed. A
// mismatch aborts rather than writing, so a tampered or truncated download can
// never land in a package that is about to be published.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const cacheRoot = path.join(root, '.nx-cache', 'runner-binaries');
const EXECUTABLE_MODE = 0o755;

const RMUX_TAG = 'v0.9.1';
const RMUX_REPO = 'Helvesec/rmux';
const RTK_TAG = 'v0.45.0';
const RTK_REPO = 'rtk-ai/rtk';

/**
 * One entry per platform package.
 *
 * `archiveRoot` is the directory the tarball unpacks into, '' when the archive
 * has no wrapping directory. `files` maps the path inside that root to the path
 * inside the package's vendor directory, with the SHA-256 the extracted file
 * must have.
 */
const TARGETS = [
  {
    package: 'packages/default/doompi-runner-rmux-darwin-arm64',
    repo: RMUX_REPO,
    tag: RMUX_TAG,
    asset: 'rmux-0.9.1-macos-aarch64.tar.gz',
    archiveRoot: 'rmux-0.9.1-macos-aarch64',
    files: {
      'bin/rmux': 'eb834188684b097fd7fb3e4c0f08b1906c90a8d314a98f2c48feb87b47da6a76',
      'bin/rmux-daemon': 'a93aaad951c2035aec3cd6d881de221e68ace5e148c8be77a58df653769237d7',
      'libexec/rmux/rmux': '95933d7ac0411cd97e050d9f2dfefd544f36bc7a57f539bafe397ad4133a0bde',
    },
  },
  {
    package: 'packages/default/doompi-runner-rmux-darwin-x64',
    repo: RMUX_REPO,
    tag: RMUX_TAG,
    asset: 'rmux-0.9.1-macos-x86_64.tar.gz',
    archiveRoot: 'rmux-0.9.1-macos-x86_64',
    files: {
      'bin/rmux': 'c66fc6e72b4236dbab0537d473182cbd0b20eee0f6d6061f5bcf3b8f286c0d94',
      'bin/rmux-daemon': 'cdb72bc24fe74947eb11f63d4f11302dec16433de8d6315d4478f4805f67f358',
      'libexec/rmux/rmux': 'a627ff7510843b1a9afad15770ecda10a666aa19db4ad99020b1a855ff15bbc5',
    },
  },
  {
    package: 'packages/default/doompi-runner-rmux-linux-arm64',
    repo: RMUX_REPO,
    tag: RMUX_TAG,
    asset: 'rmux-0.9.1-linux-aarch64.tar.gz',
    archiveRoot: 'rmux-0.9.1-linux-aarch64',
    files: {
      'bin/rmux': 'ee835a7b0a3dd1033c73d1fe5b5e97a20eea476530c57be36d0471a202bbc82f',
      'bin/rmux-daemon': '61303a29c03735c5a5861757d8e6e1c58c18df8d8fa8fcc1c27ae78d561b902b',
      'libexec/rmux/rmux': 'd55724549a10c6042ce083b447ae1b14dded6466cfef10e424e4eb9fd2e1f504',
    },
  },
  {
    package: 'packages/default/doompi-runner-rmux-linux-x64',
    repo: RMUX_REPO,
    tag: RMUX_TAG,
    asset: 'rmux-0.9.1-linux-x86_64.tar.gz',
    archiveRoot: 'rmux-0.9.1-linux-x86_64',
    files: {
      'bin/rmux': '8dbb6544729df71dab3d77e0cf1a33b66dc9239494f6dbca1d7a7c82a09412be',
      'bin/rmux-daemon': 'ade3e646a14f61530da920af9fb7c3a700576b2d470b25c1903fc6697200ab8b',
      'libexec/rmux/rmux': 'f35257d1b67db1ce7118f2ff82a87017c103ba18ff5e6380a299d886b6bdb734',
    },
  },
  {
    package: 'packages/default/doompi-runner-rtk-darwin-arm64',
    repo: RTK_REPO,
    tag: RTK_TAG,
    asset: 'rtk-aarch64-apple-darwin.tar.gz',
    archiveRoot: '',
    files: { 'bin/rtk': '17d00d61a533a442c61f1be49d8a9321225557f64021d5b70fd8eb75ed8fb0be' },
    sources: { 'bin/rtk': 'rtk' },
  },
  {
    package: 'packages/default/doompi-runner-rtk-darwin-x64',
    repo: RTK_REPO,
    tag: RTK_TAG,
    asset: 'rtk-x86_64-apple-darwin.tar.gz',
    archiveRoot: '',
    files: { 'bin/rtk': '0bd454d361563e66f16661f008896b85a8f0033fb07eabcc74c480085cda5afd' },
    sources: { 'bin/rtk': 'rtk' },
  },
  {
    package: 'packages/default/doompi-runner-rtk-linux-arm64',
    repo: RTK_REPO,
    tag: RTK_TAG,
    asset: 'rtk-aarch64-unknown-linux-gnu.tar.gz',
    archiveRoot: '',
    files: { 'bin/rtk': '9b844beeb5bc6e6ecd87199fcee11d304b51642b06b3435a09f0b660452cc553' },
    sources: { 'bin/rtk': 'rtk' },
  },
  {
    package: 'packages/default/doompi-runner-rtk-linux-x64',
    repo: RTK_REPO,
    tag: RTK_TAG,
    asset: 'rtk-x86_64-unknown-linux-musl.tar.gz',
    archiveRoot: '',
    files: { 'bin/rtk': '99e0cff729d52297a23eb832f809d9773ba7c32de818dfe76b2cdd900a951535' },
    sources: { 'bin/rtk': 'rtk' },
  },
];

export { TARGETS };

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function isMaterialized(target) {
  return Object.entries(target.files).every(([relative, expected]) => {
    const filePath = path.join(root, target.package, 'vendor', relative);
    return fs.existsSync(filePath) && sha256(filePath) === expected;
  });
}

async function downloadAsset(target) {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const cached = path.join(cacheRoot, `${target.tag}-${target.asset}`);
  if (fs.existsSync(cached)) return cached;

  const url = `https://github.com/${target.repo}/releases/download/${target.tag}/${target.asset}`;
  process.stdout.write(`  fetching ${target.repo}@${target.tag} ${target.asset}\n`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);

  const partial = `${cached}.partial`;
  await pipeline(response.body, fs.createWriteStream(partial));
  fs.renameSync(partial, cached);
  return cached;
}

/**
 * Returns the temp directory and the root to read from inside it.
 *
 * These are two different paths and must stay separate: an archive with no
 * wrapping directory makes them equal, and deriving one from the other with
 * dirname then walks above the temp directory.
 */
function extract(archivePath, target) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-runner-'));
  execFileSync('tar', ['xzf', archivePath, '-C', directory], { stdio: 'pipe' });
  return { directory, extractedRoot: path.join(directory, target.archiveRoot) };
}

function install(extractedRoot, target) {
  for (const [relative, expected] of Object.entries(target.files)) {
    const source = path.join(extractedRoot, target.sources?.[relative] ?? relative);
    if (!fs.existsSync(source)) throw new Error(`${target.asset} is missing ${source}`);

    // Verify before installing. A payload that fails here must not reach a
    // vendor directory, because the next step after this script is packing.
    const actual = sha256(source);
    if (actual !== expected) {
      throw new Error(`${target.package}/${relative}\n  expected ${expected}\n  received ${actual}`);
    }

    const destination = path.join(root, target.package, 'vendor', relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, EXECUTABLE_MODE);
  }
}

async function main() {
  const check = process.argv.includes('--check');
  const force = process.argv.includes('--force');

  const missing = TARGETS.filter((target) => force || !isMaterialized(target));

  if (check) {
    if (missing.length === 0) {
      process.stdout.write(`Runner payloads verified: ${TARGETS.length} packages match their pinned checksums.\n`);
      return;
    }
    for (const target of missing) process.stderr.write(`missing or modified: ${target.package}\n`);
    process.stderr.write('Run: node scripts/fetch-runner-binaries.mjs\n');
    process.exitCode = 1;
    return;
  }

  if (missing.length === 0) {
    process.stdout.write(`Runner payloads already materialized: ${TARGETS.length} packages.\n`);
    return;
  }

  for (const target of missing) {
    const archivePath = await downloadAsset(target);
    const { directory, extractedRoot } = extract(archivePath, target);
    try {
      install(extractedRoot, target);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    process.stdout.write(`  ok ${target.package}\n`);
  }
  process.stdout.write(`Materialized ${missing.length} Runner payload package(s).\n`);
}

// Importable: audit-workspace.mjs reads TARGETS so the checksums have one home.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) await main();
