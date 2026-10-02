import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'AgiFlow/doompi';
const BUILD_MANIFEST = 'desktop-build.json';
const DESKTOP_MANIFEST_PATH = 'packages/clients/doompi-desktop/package.json';
const DESKTOP_PACKAGE = '@agimon-ai/doompi-desktop';
const MIN_NODE_VERSION = [22, 22, 1];
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
  let result;
  const output = options.stdoutFile === undefined ? undefined : fs.openSync(options.stdoutFile, 'wx', 0o600);
  try {
    result = spawnSync(file, args, {
      cwd,
      env,
      encoding: 'utf8',
      input: options.input,
      stdio: output === undefined ? (inherit ? 'inherit' : ['pipe', 'pipe', 'pipe']) : ['pipe', output, 'pipe'],
    });
  } finally {
    if (output !== undefined) fs.closeSync(output);
  }
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

function assertToolchain(build = true) {
  for (const command of ['codesign', 'ditto', 'file', 'git', 'hdiutil', 'plutil', 'spctl', 'sw_vers', 'xcrun']) {
    assertExecutable(command);
  }
  if (build) {
    for (const command of ['pnpm', 'security', 'swift']) assertExecutable(command);
    runCommand('swift', ['--version']);
    runCommand('xcrun', ['--find', 'notarytool']);
  }
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

export function assertAppleCredentials(env = process.env, run = runCommand) {
  const required = ['APPLE_TEAM_ID', 'CSC_NAME', 'NOTARYTOOL_KEYCHAIN_PROFILE'];
  const missing = required.filter((name) => (env[name] ?? '').trim() === '');
  if (missing.length > 0) throw new Error(`Missing Apple release environment: ${missing.join(', ')}.`);
  const teamId = env.APPLE_TEAM_ID.trim();
  if (!/^[A-Z0-9]{10}$/u.test(teamId)) throw new Error('APPLE_TEAM_ID must be the ten-character Apple Team ID.');
  const identity = parseDeveloperIdIdentity(
    env.CSC_NAME.trim(),
    run('security', ['find-identity', '-v', '-p', 'codesigning']).stdout,
    teamId,
  );
  const profile = env.NOTARYTOOL_KEYCHAIN_PROFILE.trim();
  if (!/^[A-Za-z0-9._-]+$/u.test(profile))
    throw new Error('NOTARYTOOL_KEYCHAIN_PROFILE contains unsupported characters.');
  run('xcrun', ['notarytool', 'history', '--keychain-profile', profile, '--output-format', 'json']);
  return { identity, profile, teamId };
}

export function createBuildEnvironment(identity, outputDirectory, profile, environment = process.env) {
  const env = { ...environment };
  // Use the same default-keychain profile validated above, not competing inherited credentials.
  for (const name of [
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_API_KEY',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
    'APPLE_KEYCHAIN',
  ])
    delete env[name];
  env.APPLE_KEYCHAIN_PROFILE = profile;
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
  if (
    typeof version !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
      version,
    )
  ) {
    throw new Error(`Desktop package version is not a valid release version: ${version}.`);
  }
  const prerelease = version.split('+')[0].split('-').slice(1).join('-');
  if (prerelease.split('.').some((identifier) => /^0\d+$/u.test(identifier))) {
    throw new Error(`Desktop package version has a noncanonical numeric prerelease: ${version}.`);
  }
  return version;
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
  return { dmg, zip, checksum: path.join(outputDirectory, names.checksum), names };
}

export function checksumContents(artifacts) {
  const lines = [
    `${sha256(artifacts.dmg)}  ${artifacts.names.dmg}`,
    `${sha256(artifacts.zip)}  ${artifacts.names.zip}`,
  ];
  return `${lines.join('\n')}\n`;
}

function writeChecksums(artifacts) {
  fs.writeFileSync(artifacts.checksum, checksumContents(artifacts), 'utf8');
}

function verifyChecksums(artifacts) {
  if (fs.readFileSync(artifacts.checksum, 'utf8') !== checksumContents(artifacts)) {
    throw new Error('The local artifact checksums do not match the final notarized files.');
  }
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

function verifyApp(appPath, expectedVersion, teamId, expectedCommit) {
  const shortVersion = plistValue(appPath, 'CFBundleShortVersionString');
  if (
    plistValue(appPath, 'DoomPiVersion') !== expectedVersion ||
    plistValue(appPath, 'DoomPiCommit') !== expectedCommit ||
    plistValue(appPath, 'CFBundleIdentifier') !== 'ai.agimon.doompi' ||
    ![expectedVersion, expectedVersion.split(/[+-]/u)[0]].includes(shortVersion)
  ) {
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
  runCommand('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  runCommand('xcrun', ['stapler', 'validate', appPath]);

  const signableRoots = [
    path.join(appPath, 'Contents', 'Resources', 'runtime'),
    path.join(appPath, 'Contents', 'Resources', 'native'),
  ];
  const binaries = signableRoots.flatMap((directory) => collectMachO(directory));
  if (binaries.length < 2) throw new Error(`Packaged app has too few signed native payloads: ${appPath}.`);
  for (const binary of binaries) runCommand('codesign', ['--verify', '--strict', '--verbose=2', binary]);
}

function zipApplication(zipPath) {
  const extractionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-desktop-zip-'));
  try {
    runCommand('ditto', ['-x', '-k', zipPath, extractionDirectory]);
    const applications = findApplications(extractionDirectory);
    if (applications.length !== 1)
      throw new Error(`Expected one app in ${path.basename(zipPath)}; found ${applications.length}.`);
    return { extractionDirectory, application: applications[0] };
  } catch (error) {
    fs.rmSync(extractionDirectory, { recursive: true, force: true });
    throw error;
  }
}

function ensureZipTicket(zipPath) {
  const extracted = zipApplication(zipPath);
  let repackaged = false;
  try {
    const validation = runCommand('xcrun', ['stapler', 'validate', extracted.application], { allowFailure: true });
    if (validation.status !== 0) {
      runCommand('xcrun', ['stapler', 'staple', extracted.application]);
      runCommand('xcrun', ['stapler', 'validate', extracted.application]);
      repackaged = true;
    }
    if (repackaged) {
      const replacement = `${zipPath}.repackaged`;
      fs.rmSync(replacement, { force: true });
      try {
        runCommand('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', extracted.application, replacement]);
        fs.renameSync(replacement, zipPath);
      } finally {
        fs.rmSync(replacement, { force: true });
      }
    }
  } finally {
    fs.rmSync(extracted.extractionDirectory, { recursive: true, force: true });
  }
}

function verifyZip(zipPath, expectedVersion, teamId, expectedCommit) {
  const extracted = zipApplication(zipPath);
  try {
    verifyApp(extracted.application, expectedVersion, teamId, expectedCommit);
  } finally {
    fs.rmSync(extracted.extractionDirectory, { recursive: true, force: true });
  }
}

function verifyDmg(dmgPath, expectedVersion, teamId, expectedCommit) {
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
    verifyApp(applications[0], expectedVersion, teamId, expectedCommit);
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

function notarizeAndVerify(artifacts, version, teamId, profile, commit) {
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
  verifyDmg(artifacts.dmg, version, teamId, commit);
  ensureZipTicket(artifacts.zip);
  verifyZip(artifacts.zip, version, teamId, commit);
}

export function releaseTag(version) {
  return `desktop-v${safeVersion(version)}`;
}

export function createBuildManifest(artifacts, version, commit, teamId, builtAt) {
  return {
    schemaVersion: 1,
    repository: REPOSITORY,
    version: safeVersion(version),
    commit,
    target: 'darwin-arm64',
    teamId,
    builtAt: builtAt.toISOString(),
    files: Object.fromEntries(
      ['dmg', 'zip', 'checksum'].map((kind) => [
        kind,
        {
          name: artifacts.names[kind],
          size: fs.statSync(artifacts[kind]).size,
          sha256: sha256(artifacts[kind]),
        },
      ]),
    ),
  };
}

function confinedFile(directory, name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/u.test(name) || path.basename(name) !== name) {
    throw new Error('Artifact names must be confined basenames.');
  }
  const filePath = path.join(directory, name);
  if (!fs.lstatSync(filePath).isFile()) throw new Error(`Artifact is not a regular file: ${name}.`);
  return filePath;
}

export function readBuildManifest(directory) {
  const root = fs.realpathSync(directory);
  const manifestPath = confinedFile(root, BUILD_MANIFEST);
  const manifest = readJsonFile(manifestPath);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.repository !== REPOSITORY ||
    manifest.target !== 'darwin-arm64' ||
    !/^[0-9a-f]{40}$/u.test(manifest.commit ?? '') ||
    !/^[A-Z0-9]{10}$/u.test(manifest.teamId ?? '') ||
    typeof manifest.builtAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.builtAt))
  ) {
    throw new Error('The desktop build manifest has invalid identity fields.');
  }
  safeVersion(manifest.version);
  const artifacts = { names: {}, manifest: manifestPath };
  const expectedNames = artifactNames(manifest.version, manifest.commit, new Date(manifest.builtAt));
  if (!manifest.files || Object.keys(manifest.files).sort().join(',') !== 'checksum,dmg,zip') {
    throw new Error('The manifest must describe exactly DMG, ZIP and checksums.');
  }
  for (const kind of ['dmg', 'zip', 'checksum']) {
    const entry = manifest.files[kind];
    if (
      !entry ||
      entry.name !== expectedNames[kind] ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0 ||
      typeof entry.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256)
    ) {
      throw new Error(`Invalid manifest artifact: ${kind}.`);
    }
    const filePath = confinedFile(root, entry.name);
    if (fs.statSync(filePath).size !== entry.size || sha256(filePath) !== entry.sha256) {
      throw new Error(`Artifact checksum mismatch: ${entry.name}.`);
    }
    artifacts[kind] = filePath;
    artifacts.names[kind] = entry.name;
  }
  artifacts.names.manifest = BUILD_MANIFEST;
  verifyChecksums(artifacts);
  return { manifest, artifacts };
}

function releasePayload(manifest, artifacts) {
  return {
    name: `DoomPi Desktop ${manifest.version}`,
    body: [
      'DoomPi Desktop for macOS 15+ arm64.',
      `Version: ${manifest.version}`,
      `Commit: ${manifest.commit}`,
      `Built: ${manifest.builtAt}`,
      `Manifest SHA-256: ${sha256(artifacts.manifest)}`,
      '',
      'Review and publish manually only after installing and testing both downloads.',
    ].join('\n'),
    tag_name: releaseTag(manifest.version),
    target_commitish: manifest.commit,
    draft: true,
    prerelease: manifest.version.split('+')[0].includes('-'),
    make_latest: 'false',
  };
}

export function verifyRemoteAssets(assets, artifacts, download) {
  const expected = Object.entries(artifacts.names);
  if (assets.length !== expected.length || new Set(assets.map((asset) => asset.name)).size !== assets.length) {
    throw new Error('GitHub contains unexpected or duplicate assets.');
  }
  for (const [kind, name] of expected) {
    const asset = assets.find((candidate) => candidate.name === name);
    const filePath = artifacts[kind];
    if (asset === undefined || asset.size !== fs.statSync(filePath).size) {
      throw new Error(`GitHub asset ${name} does not match the local artifact size.`);
    }
    const digest = typeof asset.digest === 'string' ? asset.digest : download?.(asset);
    if (digest !== `sha256:${sha256(filePath)}`) {
      throw new Error(`GitHub asset ${name} has an unexpected or unverifiable digest.`);
    }
  }
}

function downloadAssetDigest(asset, command) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-desktop-asset-'));
  try {
    const destination = path.join(directory, 'asset');
    // gh handles authentication. Binary bytes go directly to disk, not a UTF-8 stdout buffer.
    command(
      'gh',
      ['api', `repos/${REPOSITORY}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'],
      { stdoutFile: destination },
    );
    return `sha256:${sha256(destination)}`;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Missing-asset retries are allowed only on the exact same draft generation. */
export function uploadDraft(manifest, artifacts, client = {}) {
  const api = client.api ?? ghApi;
  const optionalApi = client.optionalApi ?? ghOptionalApi;
  const command = client.command ?? runCommand;
  const download = client.download ?? ((asset) => downloadAssetDigest(asset, command));
  const tag = releaseTag(manifest.version);
  const payload = releasePayload(manifest, artifacts);
  const refEndpoint = `repos/${REPOSITORY}/git/ref/tags/${tag}`;
  const releaseEndpoint = `repos/${REPOSITORY}/releases/tags/${tag}`;
  const checkRef = (ref) => {
    if (ref !== null && (ref.object?.type !== 'commit' || ref.object.sha !== manifest.commit)) {
      throw new Error(`Existing ${tag} points to a different source. Tags are never moved.`);
    }
  };
  const checkRelease = (release) => {
    if (
      release &&
      (release.draft !== true ||
        release.tag_name !== tag ||
        release.body !== payload.body ||
        release.prerelease !== payload.prerelease ||
        release.immutable === true ||
        release.is_immutable === true)
    ) {
      throw new Error('Existing release is published or differs from this build. Refusing replacement.');
    }
  };
  let ref = optionalApi(refEndpoint);
  let release = optionalApi(releaseEndpoint);
  checkRef(ref);
  checkRelease(release);
  const existingAssets = release ? api(`repos/${REPOSITORY}/releases/${release.id}/assets?per_page=100`) : [];
  const existingNames = new Set(existingAssets.map((asset) => asset.name));
  const expectedNames = new Set(Object.values(artifacts.names));
  if (existingNames.size !== existingAssets.length || existingAssets.some((asset) => !expectedNames.has(asset.name))) {
    throw new Error('Existing draft contains unexpected assets.');
  }
  for (const asset of existingAssets) {
    const kind = Object.keys(artifacts.names).find((key) => artifacts.names[key] === asset.name);
    verifyRemoteAssets([asset], { names: { [kind]: asset.name }, [kind]: artifacts[kind] }, download);
  }
  if (ref === null) {
    api(`repos/${REPOSITORY}/git/refs`, { method: 'POST', input: { ref: `refs/tags/${tag}`, sha: manifest.commit } });
  }
  ref = optionalApi(refEndpoint);
  checkRef(ref);
  if (ref === null) throw new Error('GitHub did not confirm the version tag.');
  if (release === null) release = api(`repos/${REPOSITORY}/releases`, { method: 'POST', input: payload });
  checkRelease(release);
  if (!release?.id) throw new Error('GitHub did not return a release ID.');
  const missing = Object.entries(artifacts.names)
    .filter(([, name]) => !existingNames.has(name))
    .map(([kind]) => artifacts[kind]);
  if (missing.length) command('gh', ['release', 'upload', tag, ...missing, '--repo', REPOSITORY]);
  const finalRelease = optionalApi(releaseEndpoint);
  checkRelease(finalRelease);
  const finalRef = optionalApi(refEndpoint);
  checkRef(finalRef);
  if (finalRef === null) throw new Error('The version tag disappeared during upload.');
  if (finalRelease?.id !== release.id) throw new Error('The release changed during upload.');
  verifyRemoteAssets(api(`repos/${REPOSITORY}/releases/${release.id}/assets?per_page=100`), artifacts, download);
  return finalRelease.html_url;
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

export function runBuild(outputDirectory) {
  const unlock = acquireLock();
  try {
    assertMacHost();
    assertToolchain();
    assertNodeAndPnpm();
    assertCleanCheckout();
    const commit = currentCommit();
    const version = safeVersion(readJsonFile(path.join(REPOSITORY_ROOT, DESKTOP_MANIFEST_PATH)).version);
    const { identity, profile, teamId } = assertAppleCredentials();
    const output = path.resolve(outputDirectory);
    if (output === REPOSITORY_ROOT || output.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) {
      throw new Error('Build output must be outside the checkout.');
    }
    // Exclusive creation prevents accidental replacement of a previously tested build.
    fs.mkdirSync(output);
    console.log(`Building DoomPi Desktop ${version} from ${commit}. Artifacts preserved at ${output}.`);
    buildDesktop(output, identity, profile);
    if (currentCommit() !== commit) throw new Error('HEAD changed while building.');
    assertCleanCheckout();
    const builtAt = new Date();
    const artifacts = finalizeArtifacts(output, version, commit, builtAt);
    notarizeAndVerify(artifacts, version, teamId, profile, commit);
    writeChecksums(artifacts);
    const manifest = createBuildManifest(artifacts, version, commit, teamId, builtAt);
    fs.writeFileSync(path.join(output, BUILD_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    readBuildManifest(output);
    console.log(`Build ready. Install both artifacts before running pnpm release:desktop --from ${output}.`);
    return { outputDirectory: output, artifacts, manifest };
  } finally {
    unlock();
  }
}

export function runRelease(directory) {
  const unlock = acquireLock();
  try {
    const { manifest, artifacts } = readBuildManifest(directory);
    assertMacHost();
    assertToolchain(false);
    assertExecutable('gh');
    verifyDmg(artifacts.dmg, manifest.version, manifest.teamId, manifest.commit);
    verifyZip(artifacts.zip, manifest.version, manifest.teamId, manifest.commit);
    assertGitHubAccess(manifest.commit);
    const source = ghApi(`repos/${REPOSITORY}/contents/${DESKTOP_MANIFEST_PATH}?ref=${manifest.commit}`);
    const sourceManifest = parseJson(
      Buffer.from(source.content ?? '', 'base64').toString('utf8'),
      'source package manifest',
    );
    if (sourceManifest.name !== DESKTOP_PACKAGE || sourceManifest.version !== manifest.version) {
      throw new Error('Recorded build version does not match the package at its GitHub commit.');
    }
    // Recheck after extraction and remote preflight. Upload never changes artifact bytes.
    readBuildManifest(directory);
    const url = uploadDraft(manifest, artifacts);
    console.log(`Versioned draft ready: ${url}`);
    return { url, artifacts, manifest };
  } finally {
    unlock();
  }
}

export function parseArguments(args) {
  const [mode, flag, directory, ...extra] = args;
  if (
    !['build', 'upload'].includes(mode) ||
    flag !== (mode === 'build' ? '--out' : '--from') ||
    !directory ||
    !path.isAbsolute(directory) ||
    extra.length
  ) {
    throw new Error('Usage: release-desktop.mjs build --out /new/artifacts | upload --from /existing/artifacts');
  }
  return { mode, directory };
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const { mode, directory } = parseArguments(process.argv.slice(2));
    if (mode === 'build') runBuild(directory);
    else runRelease(directory);
  } catch (error) {
    console.error(`Desktop delivery failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  }
}
