import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { TARGETS } from './fetch-runner-binaries.mjs';

const root = process.cwd();
const packageGroups = [
  path.join(root, 'packages', 'core'),
  path.join(root, 'packages', 'default'),
  path.join(root, 'packages', 'minor'),
  path.join(root, 'packages', 'clients'),
  path.join(root, 'layers'),
];
const dependencySections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const runtimeDependencySections = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const expectedExamplePlugins = ['blog-writing', 'development', 'testing'];
const forbiddenLockfileFragments = ['packages/mcp/', 'packages/foundation/', '/Users/'];
const runnerNativePackages = new Set([
  '@agimon-ai/doompi-runner-rmux-darwin-arm64',
  '@agimon-ai/doompi-runner-rmux-darwin-x64',
  '@agimon-ai/doompi-runner-rmux-linux-arm64',
  '@agimon-ai/doompi-runner-rmux-linux-x64',
  '@agimon-ai/doompi-runner-rtk-darwin-arm64',
  '@agimon-ai/doompi-runner-rtk-darwin-x64',
  '@agimon-ai/doompi-runner-rtk-linux-arm64',
  '@agimon-ai/doompi-runner-rtk-linux-x64',
]);
const toolingPackageDirectory = path.join(root, 'packages', 'tooling', 'vibe-lint-plugin-doom-extension');
const toolingPackageName = '@agimon-ai/vibe-lint-plugin-doom-extension';
// Rule plugins that govern a stack still in development are legal workspace
// targets even when the package audit scans only runtime package groups.
const additionalToolingPackageNames = ['@agimon-ai/vibe-lint-plugin-doom-web'];
// Owned packages that are deliberately kept off the registry. A name here must
// never be a runtime dependency of a released package: the release publishes
// the resolved `workspace:*` version, so a released package that points at an
// unreleased one ships a dependency npm cannot install.
const unreleasedOwnedPackageNames = new Set([]);
const vibeLintVersion = '0.0.1-alpha.29';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fail(message) {
  throw new Error(message);
}

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(entryPath) : [entryPath];
  });
}

const packageDirectories = packageGroups
  .flatMap((group) => {
    if (path.basename(group) !== 'layers') {
      return fs
        .readdirSync(group, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(group, entry.name));
    }
    return fs.readdirSync(group, { withFileTypes: true }).flatMap((layer) => {
      if (!layer.isDirectory()) return [];
      const layerRoot = path.join(group, layer.name);
      return fs
        .readdirSync(layerRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(layerRoot, entry.name));
    });
  })
  .filter((directory) => fs.existsSync(path.join(directory, 'package.json')))
  .sort();
const manifests = packageDirectories.map((directory) => readJson(path.join(directory, 'package.json')));
const ownedNames = new Set(manifests.map(({ name }) => name));
const packageRecords = packageDirectories.map((directory, index) => ({
  directory,
  manifest: manifests[index],
  kind: directory.startsWith(path.join(root, 'packages', 'core') + path.sep)
    ? 'core'
    : directory.startsWith(path.join(root, 'packages', 'clients') + path.sep)
      ? 'client'
      : 'selectable',
}));
const packageByName = new Map(packageRecords.map((record) => [record.manifest.name, record]));
const toolingManifest = readJson(path.join(toolingPackageDirectory, 'package.json'));
const workspacePackageNames = new Set([...ownedNames, toolingPackageName, ...additionalToolingPackageNames]);

if (packageDirectories.length !== 45 || ownedNames.size !== 45) {
  fail(
    `Expected exactly 45 DoomPi packages, found ${packageDirectories.length} directories and ${ownedNames.size} names`,
  );
}
if (toolingManifest.name !== toolingPackageName || toolingManifest.private === true) {
  fail(`Expected one publishable tooling package named ${toolingPackageName}`);
}
if (
  toolingManifest.devDependencies?.['@agimon-ai/vibe-lint'] !== vibeLintVersion ||
  toolingManifest.peerDependencies?.['@agimon-ai/vibe-lint'] !== vibeLintVersion
) {
  fail(`${toolingPackageName} must develop against and peer exactly ${vibeLintVersion}`);
}

for (const [index, manifest] of manifests.entries()) {
  const owner = manifest.name ?? packageDirectories[index];
  if (manifest.private === true) fail(`${owner} must remain publishable`);
  for (const section of dependencySections) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (typeof range !== 'string') fail(`${owner} has a non-string ${section} range for ${name}`);
      if (range.startsWith('workspace:') && !workspacePackageNames.has(name)) {
        fail(`${owner} has an external workspace dependency on ${name}`);
      }
      if (/^(?:file:|link:|portal:|\.\.?\/|\/|[A-Za-z]:[\\/])/u.test(range)) {
        fail(`${owner} has a local-path ${section} dependency on ${name}: ${range}`);
      }
    }
  }
}

/**
 * npm renders `repository` and `bugs` as the "Repository" and "Report issues"
 * links on a package page. Without them a published package is a dead end: a
 * reader who arrives from npm has no route back to the source. `repository`
 * is also a hard prerequisite for `npm publish --provenance`.
 */
const publishedRepositoryUrl = 'git+https://github.com/AgiFlow/doompi.git';
const publishedBugsUrl = 'https://github.com/AgiFlow/doompi/issues';

function auditPublishedMetadata(directory, manifest) {
  const owner = manifest.name ?? directory;
  const relativeDirectory = path.relative(root, directory);

  if (manifest.repository?.url !== publishedRepositoryUrl) {
    fail(`${owner} must declare repository.url ${publishedRepositoryUrl}`);
  }
  if (manifest.repository?.directory !== relativeDirectory) {
    fail(`${owner} must declare repository.directory ${relativeDirectory}`);
  }
  if (manifest.bugs?.url !== publishedBugsUrl) {
    fail(`${owner} must declare bugs.url ${publishedBugsUrl}`);
  }
  if (typeof manifest.author !== 'string' || manifest.author.length === 0) {
    fail(`${owner} must declare an author`);
  }
}

for (const { directory, manifest } of packageRecords) auditPublishedMetadata(directory, manifest);
auditPublishedMetadata(toolingPackageDirectory, toolingManifest);

function selectableDependencyAllowed(owner, target) {
  return owner === '@agimon-ai/doompi-runner' && runnerNativePackages.has(target);
}

function assertDispensableEdge(ownerRecord, targetRecord, source) {
  if (ownerRecord.manifest.name === targetRecord.manifest.name || targetRecord.kind === 'core') return;
  if (ownerRecord.kind === 'client' && targetRecord.kind === 'client') return;
  if (selectableDependencyAllowed(ownerRecord.manifest.name, targetRecord.manifest.name)) return;
  if (ownerRecord.kind === 'core') {
    fail(
      `${ownerRecord.manifest.name} must not depend on ${targetRecord.kind} package ${targetRecord.manifest.name} through ${source}`,
    );
  }
  fail(
    `${ownerRecord.manifest.name} must collaborate with ${targetRecord.kind} package ${targetRecord.manifest.name} through shared contracts, not ${source}`,
  );
}

for (const ownerRecord of packageRecords) {
  for (const section of runtimeDependencySections) {
    for (const name of Object.keys(ownerRecord.manifest[section] ?? {})) {
      const targetRecord = packageByName.get(name);
      if (targetRecord) assertDispensableEdge(ownerRecord, targetRecord, `${section} in package.json`);
    }
  }

  for (const sourceFile of filesUnder(path.join(ownerRecord.directory, 'src'))) {
    if (!/\.[cm]?[jt]sx?$/u.test(sourceFile)) continue;
    const source = fs.readFileSync(sourceFile, 'utf8');
    const importPattern = /(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)['"](@agimon-ai\/doompi-[^'"]+)['"]/gu;
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      const targetRecord = [...packageByName.entries()]
        .sort(([left], [right]) => right.length - left.length)
        .find(([name]) => specifier === name || specifier.startsWith(`${name}/`))?.[1];
      if (targetRecord) {
        assertDispensableEdge(ownerRecord, targetRecord, path.relative(root, sourceFile));
      }
    }
  }
}

const nx = readJson(path.join(root, 'nx.json'));
const releaseProjects = nx.release?.groups?.alpha?.projects ?? [];
const releasedNames = new Set([
  ...[...ownedNames].filter((name) => !unreleasedOwnedPackageNames.has(name)),
  toolingPackageName,
  ...additionalToolingPackageNames,
]);
if (releaseProjects.length !== releasedNames.size || new Set(releaseProjects).size !== releasedNames.size) {
  fail(
    `Expected the alpha release group to contain ${releasedNames.size} unique projects, found ${releaseProjects.length}`,
  );
}
for (const name of releasedNames) if (!releaseProjects.includes(name)) fail(`Release group is missing ${name}`);
for (const name of releaseProjects)
  if (!releasedNames.has(name)) fail(`Release group includes non-owned package ${name}`);
for (const { manifest } of packageRecords) {
  if (!releasedNames.has(manifest.name)) continue;
  for (const section of runtimeDependencySections) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      if (ownedNames.has(name) && !releasedNames.has(name)) {
        fail(`${manifest.name} is released but depends on the unreleased ${name} through ${section}`);
      }
    }
  }
}

const pluginsRoot = path.join(root, 'plugins');
const examplePlugins = fs
  .readdirSync(pluginsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (JSON.stringify(examplePlugins) !== JSON.stringify(expectedExamplePlugins)) {
  fail(`Expected example plugins ${expectedExamplePlugins.join(', ')}, found ${examplePlugins.join(', ')}`);
}
for (const pluginName of expectedExamplePlugins) {
  for (const manifestDirectory of ['.codex-plugin', '.claude-plugin']) {
    const manifestPath = path.join(pluginsRoot, pluginName, manifestDirectory, 'plugin.json');
    if (!fs.existsSync(manifestPath)) fail(`${pluginName} is missing ${manifestDirectory}/plugin.json`);
    if (readJson(manifestPath).name !== pluginName) {
      fail(`${path.relative(root, manifestPath)} must use the plugin name ${pluginName}`);
    }
  }
}
for (const excluded of [
  'packages/default/doompi-file-edit/tmp/claude-stop-hook.json',
  'packages/default/doompi-runner/tmp/claude-stop-hook.json',
]) {
  if (fs.existsSync(path.join(root, excluded))) fail(`Excluded temporary hook capture is present: ${excluded}`);
}

const lockfilePath = path.join(root, 'pnpm-lock.yaml');
if (fs.existsSync(lockfilePath)) {
  const lockfile = fs.readFileSync(lockfilePath, 'utf8');
  for (const fragment of forbiddenLockfileFragments) {
    if (lockfile.includes(fragment)) fail(`Lockfile contains forbidden local closure fragment: ${fragment}`);
  }
  if (/^\s+(?:specifier|version):\s+file:/mu.test(lockfile)) {
    fail('Lockfile contains a file-protocol dependency');
  }
  const ownedDirectoryNames = new Set([
    ...packageDirectories.map((directory) => path.basename(directory)),
    path.basename(toolingPackageDirectory),
    'vibe-lint-plugin-doom-web',
  ]);
  for (const match of lockfile.matchAll(/^\s+version:\s+link:(\S+)$/gmu)) {
    if (!ownedDirectoryNames.has(path.basename(match[1]))) {
      fail(`Lockfile contains an external workspace link: ${match[1]}`);
    }
  }
}

// Runner payloads are fetched from upstream releases rather than stored in the
// repository, so the audit verifies what landed instead of how it was stored.
// TARGETS is the same manifest scripts/fetch-runner-binaries.mjs installs from,
// so a payload version moves in one place.
let rmuxPayloadCount = 0;
let rtkPayloadCount = 0;

for (const target of TARGETS) {
  const isRmux = path.basename(target.package).startsWith('doompi-runner-rmux-');
  for (const [relative, expected] of Object.entries(target.files)) {
    const label = `${target.package}/vendor/${relative}`;
    const file = path.join(root, target.package, 'vendor', relative);
    if (!fs.existsSync(file)) fail(`Runner payload is missing: ${label}\n  Run: pnpm runner:fetch`);

    const content = fs.readFileSync(file);
    if (content.subarray(0, 64).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) {
      fail(`Runner payload is still an LFS pointer: ${label}`);
    }
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== expected) {
      fail(`Runner payload checksum mismatch: ${label}\n  expected ${expected}\n  received ${actual}`);
    }
    if ((fs.statSync(file).mode & 0o111) === 0) fail(`Runner payload is not executable: ${label}`);

    if (isRmux) rmuxPayloadCount += 1;
    else rtkPayloadCount += 1;
  }
}

if (rmuxPayloadCount !== 12) fail(`Expected 12 RMUX vendor files, found ${rmuxPayloadCount}`);
if (rtkPayloadCount !== 4) fail(`Expected 4 RTK vendor files, found ${rtkPayloadCount}`);

console.log(
  'Workspace audit passed: 45 runtime packages, 2 tooling packages, dispensable feature closure, registry-only externals, 12 materialized RMUX payloads, and 4 materialized RTK payloads.',
);
