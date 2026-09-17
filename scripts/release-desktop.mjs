import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'AgiFlow/doompi';
const NIGHTLY_TAG = 'desktop-nightly';
const DESKTOP_PACKAGE = '@agimon-ai/doompi-desktop';
const MIN_NODE_VERSION = [22, 22, 1];
const ZERO_SHA = '0'.repeat(40);
const SECRET_ENV_NAMES = [
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_CERTIFICATE_P12_BASE64',
  'APPLE_ID',
  'APPLE_TEAM_ID',
  'CSC_KEY_PASSWORD',
  'CSC_LINK',
];
const MACH_O_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);
const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_ROOT, '..');

export class CommandError extends Error {
  constructor(file, args, result, env = process.env) {
    const output = redactSecrets(`${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim(), env);
    const detail = output === '' ? '' : `\n${output}`;
    super(`${file} ${args.join(' ')} failed with status ${String(result.status)}.${detail}`);
    this.name = 'CommandError';
    this.status = result.status;
  }
}

export function redactSecrets(value, env = process.env) {
  let redacted = String(value);
  for (const name of SECRET_ENV_NAMES) {
    const secret = env[name];
    if (typeof secret === 'string' && secret.length > 0) redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}

export function runCommand(file, args, options = {}) {
  const cwd = options.cwd ?? REPOSITORY_ROOT;
  const env = options.env ?? process.env;
  const inherit = options.inherit === true;
  const result = spawnSync(file, args, {
    cwd,
    env,
    encoding: 'utf8',
    input: options.input,
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || ((result.status ?? 1) !== 0 && options.allowFailure !== true)) {
    throw new CommandError(file, args, result, env);
  }
  return {
    status: result.status ?? -1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

function parseJson(value, description) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${description} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isNotFound(result) {
  return /\b404\b/u.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
}

function ghApi(endpoint, options = {}) {
  const args = ['api', endpoint];
  if (options.method !== undefined && options.method !== 'GET') args.push('--method', options.method);
  if (options.input !== undefined) args.push('--input', '-');
  if (options.jq !== undefined) args.push('--jq', options.jq);
  const result = runCommand('gh', args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input === undefined ? undefined : JSON.stringify(options.input),
  });
  if (options.parseJson === false) return null;
  return options.jq === undefined ? parseJson(result.stdout, `gh api ${endpoint}`) : result.stdout.trim();
}

function ghOptionalApi(endpoint, options = {}) {
  const args = ['api', endpoint];
  if (options.jq !== undefined) args.push('--jq', options.jq);
  const result = runCommand('gh', args, {
    cwd: options.cwd,
    env: options.env,
    allowFailure: true,
  });
  if (result.status === 0)
    return options.jq === undefined ? parseJson(result.stdout, `gh api ${endpoint}`) : result.stdout.trim();
  if (isNotFound(result)) return null;
  throw new CommandError('gh', args, result, options.env ?? process.env);
}

function assertExecutable(name) {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, name);
    if (!fs.existsSync(candidate)) continue;
    const mode = fs.statSync(candidate).mode;
    if ((mode & 0o111) !== 0) return;
  }
  throw new Error(`Required executable is not available on PATH: ${name}`);
}

function parseNumericVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value.trim());
  if (match === null) throw new Error(`Could not parse a semantic version from ${value}.`);
  return match.slice(1).map(Number);
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

function assertNodeAndPnpm() {
  if (!versionAtLeast(parseNumericVersion(process.versions.node), MIN_NODE_VERSION)) {
    throw new Error(`Node.js ${MIN_NODE_VERSION.join('.')} or newer is required; found ${process.versions.node}.`);
  }
  const pnpmVersion = runCommand('pnpm', ['--version']).stdout.trim();
  const [major] = parseNumericVersion(`${pnpmVersion}.0`);
  if (major < 11) throw new Error(`pnpm 11 or newer is required; found ${pnpmVersion}.`);
}

function assertMacHost() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(`The local desktop release must run on macOS arm64; found ${process.platform}-${process.arch}.`);
  }
  const macOSVersion = runCommand('sw_vers', ['-productVersion']).stdout.trim();
  const [major] = parseNumericVersion(`${macOSVersion}.0`);
  if (major < 15) throw new Error(`macOS 15 or newer is required by the native helper; found ${macOSVersion}.`);
}

function assertToolchain() {
  for (const command of [
    'codesign',
    'ditto',
    'file',
    'gh',
    'git',
    'hdiutil',
    'plutil',
    'pnpm',
    'security',
    'spctl',
    'swift',
    'sw_vers',
    'xcrun',
  ]) {
    assertExecutable(command);
  }
  runCommand('swift', ['--version']);
  runCommand('xcrun', ['--find', 'notarytool']);
}

function readJsonFile(filePath) {
  return parseJson(fs.readFileSync(filePath, 'utf8'), filePath);
}

function assertCleanCheckout() {
  const status = runCommand('git', ['status', '--porcelain', '--untracked-files=all']).stdout.trim();
  if (status !== '')
    throw new Error('The checkout must be clean before a desktop release. Commit or remove local changes first.');
  const remote = runCommand('git', ['remote', 'get-url', 'origin']).stdout.trim();
  const normalized = remote
    .replace(/^git@github\.com:/u, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//u, 'https://github.com/')
    .replace(/\.git$/u, '')
    .replace(/\/$/u, '')
    .toLowerCase();
  if (normalized !== `https://github.com/${REPOSITORY.toLowerCase()}`) {
    throw new Error(`origin must point to https://github.com/${REPOSITORY}.`);
  }
}

function currentCommit() {
  const sha = runCommand('git', ['rev-parse', 'HEAD']).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`Unexpected HEAD commit: ${sha}.`);
  return sha;
}

function assertGitHubAccess(commit) {
  runCommand('gh', ['auth', 'status', '--hostname', 'github.com']);
  const access = ghApi(`repos/${REPOSITORY}`, { jq: '[.full_name, (.permissions.push // false)] | @tsv' });
  const [fullName, canPush] = access.split('\t');
  if (fullName !== REPOSITORY || canPush !== 'true') {
    throw new Error(`The authenticated GitHub account needs push access to ${REPOSITORY}.`);
  }
  const remoteCommit = ghApi(`repos/${REPOSITORY}/commits/${commit}`, { jq: '.sha' });
  if (remoteCommit !== commit) throw new Error(`HEAD ${commit} is not available on ${REPOSITORY}.`);
}

export function parseDeveloperIdIdentity(identity, identityOutput, teamId) {
  const match = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/u.exec(identity);
  if (match === null) throw new Error('CSC_NAME must name a Developer ID Application certificate.');
  if (match[1] !== teamId) throw new Error(`CSC_NAME team ${match[1]} does not match APPLE_TEAM_ID ${teamId}.`);
  const identities = [...identityOutput.matchAll(/"([^"\n]+)"/gu)].map((entry) => entry[1]);
  if (!identities.includes(identity)) {
    throw new Error(`CSC_NAME is not an installed signing identity with a private key: ${identity}.`);
  }
  return identity;
}

function assertAppleCredentials() {
  const required = [
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
    'CSC_NAME',
    'NOTARYTOOL_KEYCHAIN_PROFILE',
  ];
  const missing = required.filter((name) => (process.env[name] ?? '').trim() === '');
  if (missing.length > 0) throw new Error(`Missing Apple release environment: ${missing.join(', ')}.`);
  const teamId = process.env.APPLE_TEAM_ID.trim();
  if (!/^[A-Z0-9]{10}$/u.test(teamId)) throw new Error('APPLE_TEAM_ID must be the ten-character Apple Team ID.');
  const identity = parseDeveloperIdIdentity(
    process.env.CSC_NAME.trim(),
    runCommand('security', ['find-identity', '-v', '-p', 'codesigning']).stdout,
    teamId,
  );
  const profile = process.env.NOTARYTOOL_KEYCHAIN_PROFILE.trim();
  if (!/^[A-Za-z0-9._-]+$/u.test(profile))
    throw new Error('NOTARYTOOL_KEYCHAIN_PROFILE contains unsupported characters.');
  runCommand('xcrun', ['notarytool', 'history', '--keychain-profile', profile, '--output-format', 'json']);
  return { identity, profile, teamId };
}

function createBuildEnvironment(identity, outputDirectory, profile) {
  const env = { ...process.env };
  delete env.CSC_LINK;
  delete env.CSC_KEY_PASSWORD;
  delete env.APPLE_CERTIFICATE_P12_BASE64;
  delete env.APPLE_CERTIFICATE_PASSWORD;
  env.CSC_NAME = identity;
  env.APPLE_SIGNING_IDENTITY = identity;
  env.NOTARYTOOL_KEYCHAIN_PROFILE = profile;
  env.DOOMPI_DESKTOP_OUTPUT_DIR = outputDirectory;
  env.DOOMPI_DESKTOP_REQUIRE_SIGNING = '1';
  return env;
}

function buildDesktop(outputDirectory, identity, profile) {
  const env = createBuildEnvironment(identity, outputDirectory, profile);
  runCommand(
    'pnpm',
    ['nx', 'run-many', '-t', 'build', '-p', '@agimon-ai/doompi-web', DESKTOP_PACKAGE, '--skip-nx-cache'],
    { env, inherit: true },
  );
  runCommand('pnpm', ['nx', 'run', `${DESKTOP_PACKAGE}:package`, '--skip-nx-cache'], { env, inherit: true });
}

function findArtifacts(outputDirectory) {
  const files = fs.readdirSync(outputDirectory, { withFileTypes: true }).filter((entry) => entry.isFile());
  const dmgs = files.filter((entry) => entry.name.toLowerCase().endsWith('.dmg'));
  const zips = files.filter((entry) => entry.name.toLowerCase().endsWith('.zip'));
  if (dmgs.length !== 1 || zips.length !== 1) {
    throw new Error(
      `Expected one DMG and one ZIP in ${outputDirectory}; found ${dmgs.length} DMG and ${zips.length} ZIP.`,
    );
  }
  return { dmg: path.join(outputDirectory, dmgs[0].name), zip: path.join(outputDirectory, zips[0].name) };
}

function safeVersion(version) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Desktop package version is not a valid release version: ${version}.`);
  }
  return version.replace(/[^0-9A-Za-z.+-]/gu, '_');
}

export function artifactNames(version, commit, builtAt = new Date()) {
  const stamp = builtAt
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
  const prefix = `DoomPi-${safeVersion(version)}-arm64-${commit.slice(0, 12)}-${stamp}`;
  return { dmg: `${prefix}.dmg`, zip: `${prefix}.zip`, checksum: `${prefix}.sha256` };
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function finalizeArtifacts(outputDirectory, version, commit, builtAt) {
  const built = findArtifacts(outputDirectory);
  const names = artifactNames(version, commit, builtAt);
  const dmg = path.join(outputDirectory, names.dmg);
  const zip = path.join(outputDirectory, names.zip);
  fs.renameSync(built.dmg, dmg);
  fs.renameSync(built.zip, zip);
  const checksum = path.join(outputDirectory, names.checksum);
  const lines = [`${sha256(dmg)}  ${names.dmg}`, `${sha256(zip)}  ${names.zip}`];
  fs.writeFileSync(checksum, `${lines.join('\n')}\n`, 'utf8');
  return { dmg, zip, checksum, names };
}

function isMachO(filePath) {
  const header = fs.readFileSync(filePath).subarray(0, 4);
  if (header.length < 4) return false;
  return MACH_O_MAGIC.has(header.readUInt32BE(0)) || MACH_O_MAGIC.has(header.readUInt32LE(0));
}

function collectMachO(directory, files = []) {
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectMachO(entryPath, files);
    else if (entry.isFile() && isMachO(entryPath)) files.push(entryPath);
  }
  return files;
}

function findApplications(directory, applications = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name.endsWith('.app')) applications.push(entryPath);
    else findApplications(entryPath, applications);
  }
  return applications;
}

function plistValue(appPath, key) {
  return runCommand('plutil', [
    '-extract',
    key,
    'raw',
    '-o',
    '-',
    path.join(appPath, 'Contents', 'Info.plist'),
  ]).stdout.trim();
}

function verifyApp(appPath, expectedVersion, teamId) {
  if (plistValue(appPath, 'CFBundleShortVersionString') !== expectedVersion) {
    throw new Error(`Packaged app version does not match ${expectedVersion}: ${appPath}.`);
  }
  const executable = plistValue(appPath, 'CFBundleExecutable');
  const executablePath = path.join(appPath, 'Contents', 'MacOS', executable);
  const fileDescription = runCommand('file', [executablePath]).stdout;
  if (!/\barm64\b/u.test(fileDescription) || /\bx86_64\b/u.test(fileDescription)) {
    throw new Error(`Packaged app is not Apple Silicon only: ${fileDescription.trim()}.`);
  }
  const details = runCommand('codesign', ['--display', '--verbose=4', appPath]);
  const signingDetails = `${details.stdout}\n${details.stderr}`;
  if (
    !signingDetails.includes(`TeamIdentifier=${teamId}`) ||
    !/Authority=Developer ID Application:/u.test(signingDetails)
  ) {
    throw new Error(`Packaged app is not signed by the expected Developer ID team: ${appPath}.`);
  }
  runCommand('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  runCommand('spctl', ['--assess', '--type', 'install', '--verbose=4', appPath]);
  runCommand('xcrun', ['stapler', 'validate', appPath]);

  const signableRoots = [
    path.join(appPath, 'Contents', 'Resources', 'runtime'),
    path.join(appPath, 'Contents', 'Resources', 'native'),
  ];
  const binaries = signableRoots.flatMap((directory) => collectMachO(directory));
  if (binaries.length < 2) throw new Error(`Packaged app has too few signed native payloads: ${appPath}.`);
  for (const binary of binaries) runCommand('codesign', ['--verify', '--strict', '--verbose=2', binary]);
}

function verifyZip(zipPath, expectedVersion, teamId) {
  const extractionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-desktop-zip-'));
  try {
    runCommand('ditto', ['-x', '-k', zipPath, extractionDirectory]);
    const applications = findApplications(extractionDirectory);
    if (applications.length !== 1)
      throw new Error(`Expected one app in ${path.basename(zipPath)}; found ${applications.length}.`);
    verifyApp(applications[0], expectedVersion, teamId);
  } finally {
    fs.rmSync(extractionDirectory, { recursive: true, force: true });
  }
}

function verifyDmg(dmgPath, expectedVersion, teamId) {
  runCommand('xcrun', ['stapler', 'validate', dmgPath]);
  const mountDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-desktop-dmg-'));
  let mounted = false;
  let failure;
  try {
    runCommand('hdiutil', ['attach', dmgPath, '-readonly', '-nobrowse', '-mountpoint', mountDirectory]);
    mounted = true;
    const applications = findApplications(mountDirectory);
    if (applications.length !== 1)
      throw new Error(`Expected one app in ${path.basename(dmgPath)}; found ${applications.length}.`);
    verifyApp(applications[0], expectedVersion, teamId);
  } catch (error) {
    failure = error;
  } finally {
    if (mounted) {
      const detach = runCommand('hdiutil', ['detach', mountDirectory, '-force'], { allowFailure: true });
      if (detach.status !== 0 && failure === undefined)
        failure = new CommandError('hdiutil', ['detach', mountDirectory, '-force'], detach);
    }
    fs.rmSync(mountDirectory, { recursive: true, force: true });
  }
  if (failure !== undefined) throw failure;
}

function notarizeAndVerify(artifacts, version, teamId, profile) {
  const result = runCommand('xcrun', [
    'notarytool',
    'submit',
    artifacts.dmg,
    '--keychain-profile',
    profile,
    '--wait',
    '--output-format',
    'json',
  ]);
  const report = parseJson(result.stdout, 'xcrun notarytool submit');
  if (report.status !== 'Accepted') throw new Error(`Apple notarization was not accepted: ${String(report.status)}.`);
  runCommand('xcrun', ['stapler', 'staple', artifacts.dmg]);
  verifyDmg(artifacts.dmg, version, teamId);
  verifyZip(artifacts.zip, version, teamId);
}

function releaseState(client) {
  return {
    release: ghOptionalApi(`repos/${REPOSITORY}/releases/tags/${NIGHTLY_TAG}`, client),
    ref: ghOptionalApi(`repos/${REPOSITORY}/git/ref/tags/${NIGHTLY_TAG}`, client),
  };
}

function refFingerprint(ref) {
  return ref === null ? null : `${ref.object?.type ?? ''}:${ref.object?.sha ?? ''}`;
}

function assertNightlyRelease(release, label) {
  if (release === null) return;
  if (release.immutable === true || release.is_immutable === true) {
    throw new Error(`The ${label} nightly release is immutable and cannot be replaced.`);
  }
  if (release.tag_name !== NIGHTLY_TAG) throw new Error(`The ${label} release has an unexpected tag.`);
}

function transitionToDraft(release, client) {
  if (release === null || release.draft === true) return release;
  ghApi(`repos/${REPOSITORY}/releases/${release.id}`, {
    ...client,
    method: 'PATCH',
    input: { draft: true },
  });
  const updated = ghOptionalApi(`repos/${REPOSITORY}/releases/${NIGHTLY_TAG}`, client);
  if (updated === null || updated.id !== release.id || updated.draft !== true) {
    throw new Error('GitHub did not confirm the nightly release draft transition.');
  }
  return updated;
}

function moveNightlyTag(commit, observedRef) {
  const expected = observedRef?.object?.sha ?? ZERO_SHA;
  runCommand(
    'git',
    ['push', `--force-with-lease=refs/tags/${NIGHTLY_TAG}:${expected}`, 'origin', `${commit}:refs/tags/${NIGHTLY_TAG}`],
    { cwd: REPOSITORY_ROOT },
  );
}

function releaseBody(version, commit, builtAt) {
  return [
    'DoomPi Desktop nightly build.',
    '',
    `Version: ${version}`,
    `Commit: ${commit}`,
    `Built: ${builtAt.toISOString()}`,
    'Architecture: macOS arm64',
    '',
    'This release is kept as a draft prerelease. Review and publish it manually after installation testing.',
  ].join('\n');
}

function releasePayload(version, commit, builtAt) {
  return {
    name: 'DoomPi Desktop nightly',
    body: releaseBody(version, commit, builtAt),
    tag_name: NIGHTLY_TAG,
    target_commitish: commit,
    draft: true,
    prerelease: true,
    make_latest: 'false',
  };
}

function assertReleaseReady(release, id) {
  if (release === null || release.id !== id)
    throw new Error('The nightly release changed while it was being replaced.');
  if (release.draft !== true || release.prerelease !== true) {
    throw new Error('The nightly release must remain a draft prerelease during replacement.');
  }
}

function uploadAssets(release, artifacts, client) {
  runCommand(
    'gh',
    ['release', 'upload', NIGHTLY_TAG, artifacts.dmg, artifacts.zip, artifacts.checksum, '--repo', REPOSITORY],
    client,
  );
  const assets = ghApi(`repos/${REPOSITORY}/releases/${release.id}/assets?per_page=100`, client);
  const expected = new Set(Object.values(artifacts.names));
  const uploaded = new Set(assets.map((asset) => asset.name));
  for (const name of expected) if (!uploaded.has(name)) throw new Error(`GitHub upload did not produce ${name}.`);
  return assets;
}

function removeStaleAssets(assets, artifacts, client) {
  const expected = new Set(Object.values(artifacts.names));
  for (const asset of assets) {
    if (expected.has(asset.name)) continue;
    ghApi(`repos/${REPOSITORY}/releases/assets/${asset.id}`, { ...client, method: 'DELETE', parseJson: false });
  }
}

function confirmRemoteState(releaseId, commit, artifacts, client) {
  const finalRelease = ghOptionalApi(`repos/${REPOSITORY}/releases/tags/${NIGHTLY_TAG}`, client);
  assertReleaseReady(finalRelease, releaseId);
  const finalRef = ghOptionalApi(`repos/${REPOSITORY}/git/ref/tags/${NIGHTLY_TAG}`, client);
  if (finalRef === null || finalRef.object?.type !== 'commit' || finalRef.object.sha !== commit) {
    throw new Error(`refs/tags/${NIGHTLY_TAG} does not point to ${commit}.`);
  }
  const assets = ghApi(`repos/${REPOSITORY}/releases/${releaseId}/assets?per_page=100`, client);
  const compareNames = (left, right) => left.localeCompare(right);
  const names = assets.map((asset) => asset.name).sort(compareNames);
  const expected = Object.values(artifacts.names).sort(compareNames);
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Nightly assets are not the expected current generation: ${names.join(', ')}.`);
  }
  return finalRelease.html_url;
}

function replaceNightlyRelease(version, commit, builtAt, artifacts) {
  const client = { cwd: REPOSITORY_ROOT, env: process.env };
  const initial = releaseState(client);
  assertNightlyRelease(initial.release, 'existing');
  let release = transitionToDraft(initial.release, client);
  const beforeTagMutation = releaseState(client);
  if (refFingerprint(beforeTagMutation.ref) !== refFingerprint(initial.ref)) {
    throw new Error('The nightly tag changed while the release was being prepared. Retry after other writers stop.');
  }
  if (
    release !== null &&
    (beforeTagMutation.release === null ||
      beforeTagMutation.release.id !== release.id ||
      beforeTagMutation.release.draft !== true)
  ) {
    throw new Error('The nightly release changed while it was being prepared.');
  }
  moveNightlyTag(commit, beforeTagMutation.ref);
  const afterTag = releaseState(client);
  if (afterTag.ref === null || afterTag.ref.object?.type !== 'commit' || afterTag.ref.object.sha !== commit) {
    throw new Error(`refs/tags/${NIGHTLY_TAG} was not moved to ${commit}.`);
  }
  if (release !== null) {
    assertReleaseReady(afterTag.release, release.id);
    release = ghApi(`repos/${REPOSITORY}/releases/${release.id}`, {
      ...client,
      method: 'PATCH',
      input: releasePayload(version, commit, builtAt),
    });
  } else {
    release = ghApi(`repos/${REPOSITORY}/releases`, {
      ...client,
      method: 'POST',
      input: releasePayload(version, commit, builtAt),
    });
  }
  assertReleaseReady(release, release.id);
  const assets = uploadAssets(release, artifacts, client);
  const current = ghOptionalApi(`repos/${REPOSITORY}/releases/tags/${NIGHTLY_TAG}`, client);
  assertReleaseReady(current, release.id);
  removeStaleAssets(assets, artifacts, client);
  return confirmRemoteState(release.id, commit, artifacts, client);
}

function acquireLock() {
  const lockPath = path.join(os.tmpdir(), 'doompi-desktop-release.lock');
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`Another desktop release appears to be running: ${lockPath}.`);
    throw error;
  }
  return () => {
    fs.closeSync(descriptor);
    fs.rmSync(lockPath, { force: true });
  };
}

export function runRelease() {
  const releaseLock = acquireLock();
  let outputDirectory;
  try {
    assertMacHost();
    assertToolchain();
    assertNodeAndPnpm();
    assertCleanCheckout();
    const commit = currentCommit();
    assertGitHubAccess(commit);
    const { identity, profile, teamId } = assertAppleCredentials();
    const desktopManifest = readJsonFile(
      path.join(REPOSITORY_ROOT, 'packages', 'clients', 'doompi-desktop', 'package.json'),
    );
    const version = desktopManifest.version;
    if (typeof version !== 'string') throw new Error('The desktop package has no version.');
    outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-desktop-nightly-'));
    console.log(`Building DoomPi Desktop nightly from ${commit}.`);
    console.log(`Build artifacts will be preserved at ${outputDirectory}.`);
    buildDesktop(outputDirectory, identity, profile);
    if (currentCommit() !== commit)
      throw new Error('HEAD changed while building; refusing to release a moving source.');
    assertCleanCheckout();
    const builtAt = new Date();
    const artifacts = finalizeArtifacts(outputDirectory, version, commit, builtAt);
    notarizeAndVerify(artifacts, version, teamId, profile);
    const url = replaceNightlyRelease(version, commit, builtAt, artifacts);
    console.log(`Draft nightly release ready: ${url}`);
    return { url, outputDirectory, artifacts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const preserved = outputDirectory === undefined ? '' : ` Artifacts were preserved at ${outputDirectory}.`;
    throw new Error(`${redactSecrets(message)}${preserved}`);
  } finally {
    releaseLock();
  }
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    runRelease();
  } catch (error) {
    console.error(
      `Desktop nightly release failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    process.exitCode = 1;
  }
}
