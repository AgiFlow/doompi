import fs from 'node:fs';
import path from 'node:path';
import { DOOM_PACKAGE_NAME, manifestName } from './doomPackage.ts';
import { writeFileAtomic } from './serialization/json.ts';
import { SYNC_REGISTRATION_VERSION } from './syncRegistration.ts';

/** Protocol marker proving that the user package path is managed by DoomPi init. */
export const PI_DISPATCHER_VERSION = 2;

const DISPATCHER_ENTRY = 'dispatcher.mjs';
const PACKAGE_MANIFEST = 'package.json';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function dispatcherManifest(): string {
  return `${JSON.stringify(
    {
      name: DOOM_PACKAGE_NAME,
      private: true,
      type: 'module',
      doompiDispatcher: PI_DISPATCHER_VERSION,
      pi: { extensions: [`./${DISPATCHER_ENTRY}`] },
    },
    null,
    2,
  )}\n`;
}

function dispatcherSource(): string {
  return `import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REGISTRATION_VERSION = ${String(SYNC_REGISTRATION_VERSION)};
const PACKAGE_NAME = ${JSON.stringify(DOOM_PACKAGE_NAME)};
const WARNING = 'warning';

function canonical(target) {
  return fs.realpathSync.native(path.resolve(target));
}

function isFile(target) {
  try { return fs.statSync(target).isFile(); } catch { return false; }
}

function isDirectory(target) {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

function repositoryRoot(start) {
  let directory = path.resolve(start);
  while (true) {
    const git = path.join(directory, '.git');
    if (isDirectory(path.join(directory, '.doom')) || isFile(path.join(directory, '.pi', 'settings.json')) || isDirectory(git) || isFile(git)) return canonical(directory);
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function gitDirectory(root) {
  const target = path.join(root, '.git');
  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) return canonical(target);
    if (!stat.isFile()) return undefined;
    const match = /^gitdir:\\s*(.+)$/imu.exec(fs.readFileSync(target, 'utf8').trim());
    return match?.[1] ? canonical(path.resolve(root, match[1].trim())) : undefined;
  } catch { return undefined; }
}

function commonDirectory(root) {
  const git = gitDirectory(root);
  if (!git) return undefined;
  try {
    const relative = fs.readFileSync(path.join(git, 'commondir'), 'utf8').trim();
    return relative ? canonical(path.resolve(git, relative)) : git;
  } catch { return git; }
}

function identity(root) {
  const common = commonDirectory(root);
  const token = common ? \`git:\${common}\` : \`root:\${root}\`;
  const hash = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
  return { repositoryId: hash(token), worktreeId: hash(\`\${token}\\0worktree:\${root}\`) };
}

function inside(directory, target) {
  const relative = path.relative(canonical(directory), canonical(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function registration(root) {
  const ids = identity(root);
  const recordPath = path.join(os.homedir(), '.pi', '.doom', 'sync', 'registrations', ids.repositoryId, \`\${ids.worktreeId}.json\`);
  const value = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  if (value.version !== REGISTRATION_VERSION || canonical(value.root) !== root) throw new Error('registration identity mismatch');
  if (value.identity?.repositoryId !== ids.repositoryId || value.identity?.worktreeId !== ids.worktreeId) throw new Error('registration worktree mismatch');
  if (!inside(value.generationRoot, value.statePath) || !inside(value.package.root, value.package.entry)) throw new Error('registration path escapes its owner');
  const stateHash = crypto.createHash('sha256').update(fs.readFileSync(value.statePath)).digest('hex');
  if (stateHash !== value.stateSha256) throw new Error('registration state hash mismatch');
  const manifestPath = path.join(canonical(value.package.root), 'package.json');
  if (canonical(value.package.manifestPath) !== canonical(manifestPath)) throw new Error('registration package manifest mismatch');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== PACKAGE_NAME || manifest.version !== value.package.version) throw new Error('registration package mismatch');
  const entries = manifest.pi?.extensions;
  if (!Array.isArray(entries) || !entries.some((entry) => typeof entry === 'string' && canonical(path.resolve(value.package.root, entry)) === canonical(value.package.entry))) throw new Error('registration package entry mismatch');
  return value;
}

function report(pi, target, message) {
  pi.on('session_start', (_event, context) => context.ui.notify(\`doompi could not load \${target}: \${message}. Run doompi init, then doompi sync.\`, WARNING));
}
export default async function doompiDispatcher(pi) {
  const repository = repositoryRoot(process.cwd());
  try {
    const root = repository ?? canonical(path.join(os.homedir(), '.pi', '.doom'));
    const record = registration(root);
    const loaded = await import(pathToFileURL(record.package.entry).href);
    if (typeof loaded.default !== 'function') throw new Error('recorded package entry has no extension factory');
    await loaded.default(pi);
  } catch (error) {
    report(pi, repository ? 'this repository' : 'the global composition', error instanceof Error ? error.message : String(error));
  }
}
`;
}

/** Stable path Pi derives from the user settings package spelling. */
export function piExtensionDispatcherPath(piDirectory: string): string {
  return path.join(piDirectory, ...DOOM_PACKAGE_NAME.split('/'));
}

function managedManifestVersion(directory: string): number | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, PACKAGE_MANIFEST), 'utf8')) as {
      name?: unknown;
      doompiDispatcher?: unknown;
    };
    return parsed.name === DOOM_PACKAGE_NAME && Number.isSafeInteger(parsed.doompiDispatcher)
      ? (parsed.doompiDispatcher as number)
      : undefined;
  } catch {
    return undefined;
  }
}

function managedManifest(directory: string): boolean {
  return managedManifestVersion(directory) === PI_DISPATCHER_VERSION;
}

function upgradeableManagedManifest(directory: string): boolean {
  const version = managedManifestVersion(directory);
  return version !== undefined && version > 0 && version <= PI_DISPATCHER_VERSION;
}

/** Whether init's dispatcher package has a supported protocol and complete entry. */
export function piExtensionDispatcherIsCurrent(piDirectory: string): boolean {
  const directory = piExtensionDispatcherPath(piDirectory);
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink() || !managedManifest(directory)) return false;
  return fs.lstatSync(path.join(directory, DISPATCHER_ENTRY), { throwIfNoEntry: false })?.isFile() === true;
}

function legacyLinkIsManaged(linkPath: string): boolean {
  try {
    return manifestName(fs.realpathSync(linkPath)) === DOOM_PACKAGE_NAME;
  } catch {
    return true;
  }
}

/** Installs or repairs the init-owned dependency-free dispatcher package. */
export function writePiExtensionDispatcher(piDirectory: string): string {
  const directory = piExtensionDispatcherPath(piDirectory);
  const current = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (current?.isSymbolicLink()) {
    if (!legacyLinkIsManaged(directory)) {
      throw new Error(`Refusing to replace unmanaged Pi extension path: ${directory}`);
    }
    fs.rmSync(directory, { force: true });
  } else if (current && (!current.isDirectory() || !upgradeableManagedManifest(directory))) {
    throw new Error(`Refusing to replace unmanaged Pi extension path: ${directory}`);
  }

  const scope = path.dirname(directory);
  const scopeStat = fs.lstatSync(scope, { throwIfNoEntry: false });
  if (scopeStat && !scopeStat.isDirectory()) {
    throw new Error(`Refusing to use unmanaged Pi extension scope: ${scope}`);
  }
  fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
  fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  writeFileAtomic(path.join(directory, PACKAGE_MANIFEST), dispatcherManifest());
  writeFileAtomic(path.join(directory, DISPATCHER_ENTRY), dispatcherSource());
  fs.chmodSync(path.join(directory, PACKAGE_MANIFEST), PRIVATE_FILE_MODE);
  fs.chmodSync(path.join(directory, DISPATCHER_ENTRY), PRIVATE_FILE_MODE);
  return directory;
}
