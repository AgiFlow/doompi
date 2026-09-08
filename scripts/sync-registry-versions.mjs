import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';

// The release cut bumps from whatever `package.json` holds on disk. That is only
// safe while every previous cut was published and tagged, and this pipeline has
// already proved it can lose a publish: a merge commit without the release title
// skips `Release publish` entirely, so main carries a version the registry never
// received, and the run after it bumps past a number that is still free.
//
// This raises each selected package to the highest alpha already published on its
// own base version, so the bump that follows always lands above the registry and
// can never collide with a version npm has served. A package on disk that is
// already ahead of the registry is left alone: it is a legitimately unpublished
// version, not drift.

const REGISTRY = 'https://registry.npmjs.org';
const ALPHA_VERSION = /^(\d+)\.(\d+)\.(\d+)-alpha\.(\d+)$/u;

const [selection] = process.argv.slice(2);
const selected = selection ? new Set(selection.split(',').filter(Boolean)) : undefined;

const manifestPaths = execFileSync('node', ['scripts/list-packages.mjs', '--paths'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

const raised = await Promise.all(manifestPaths.map(raiseToRegistryFloor));
const changed = raised.filter(Boolean);

if (changed.length === 0) {
  console.log('Every selected package is at or above its registry version.');
} else {
  for (const line of changed) {
    console.log(line);
  }
  console.log(`Raised ${changed.length} package version(s) to the registry floor.`);
}

async function raiseToRegistryFloor(manifestPath) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  if (selected && !selected.has(manifest.name)) {
    return undefined;
  }

  const onDisk = parseAlphaVersion(manifest.version, `${manifest.name} in ${manifestPath}`);
  const published = await publishedVersions(manifest.name);
  const base = `${onDisk.base.join('.')}`;

  const ahead = published.find((version) => compareBase(version.base, onDisk.base) > 0);
  if (ahead) {
    throw new Error(
      `${manifest.name} is at ${manifest.version} on disk but ${ahead.raw} is already published. ` +
        'The base version moved outside this pipeline, so the release cut cannot pick the next alpha safely.',
    );
  }

  const highest = published
    .filter((version) => compareBase(version.base, onDisk.base) === 0)
    .reduce((max, version) => (version.counter > max ? version.counter : max), -1);
  if (highest <= onDisk.counter) {
    return undefined;
  }

  const next = `${base}-alpha.${highest}`;
  fs.writeFileSync(manifestPath, replaceVersion(raw, manifest.version, next, manifestPath));
  return `${manifest.name}: ${manifest.version} -> ${next} (highest published)`;
}

async function publishedVersions(name) {
  // The abbreviated packument is the smaller read and still carries every version
  // key, which is what the floor is derived from.
  const response = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  });
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error(`Reading ${name} from the registry failed with HTTP ${response.status}.`);
  }

  const packument = await response.json();
  return Object.keys(packument.versions ?? {})
    .map((version) => {
      const match = ALPHA_VERSION.exec(version);
      return match
        ? { raw: version, base: [Number(match[1]), Number(match[2]), Number(match[3])], counter: Number(match[4]) }
        : undefined;
    })
    .filter(Boolean);
}

function parseAlphaVersion(version, subject) {
  const match = ALPHA_VERSION.exec(version ?? '');
  if (!match) {
    throw new Error(
      `${subject} is at ${version}, which is not an <major>.<minor>.<patch>-alpha.<counter> release version.`,
    );
  }
  return { base: [Number(match[1]), Number(match[2]), Number(match[3])], counter: Number(match[4]) };
}

function compareBase(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

function replaceVersion(raw, current, next, manifestPath) {
  // A surgical replacement of the top-level key keeps the file byte-identical
  // everywhere else, so `pnpm fmt:check` stays happy.
  const pattern = new RegExp(`(\\n  "version": ")${escapeForRegExp(current)}(")`, 'u');
  if (!pattern.test(raw)) {
    throw new Error(`${manifestPath} has no top-level "version": "${current}" to rewrite.`);
  }
  return raw.replace(pattern, `$1${next}$2`);
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
