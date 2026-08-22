import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOOM_PACKAGE_NAME, manifestName } from './doomPackage.ts';

/**
 * Local package alias used by Pi's path-based user extension resolver.
 *
 * Pi resolves values in `settings.extensions` from its user configuration
 * directory instead of using Node's package resolver. Sync therefore creates
 * `$PI_CODING_AGENT_DIR/@agimon-ai/doompi` as a directory link to this installed
 * package while keeping the public settings value stable.
 */
const PACKAGE_NAME = DOOM_PACKAGE_NAME;

function nearestPackageRoot(start: string): string {
  let directory = path.resolve(start);
  while (true) {
    if (manifestName(directory) === PACKAGE_NAME) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Could not locate installed ${PACKAGE_NAME} package from ${start}`);
    directory = parent;
  }
}

/** Installed package root for the source or compiled module executing sync. */
export function doomPiPackageRoot(moduleUrl = import.meta.url): string {
  return nearestPackageRoot(path.dirname(fileURLToPath(moduleUrl)));
}

/** Path Pi derives from the stable settings extension value. */
export function piExtensionAliasPath(piDirectory: string): string {
  return path.join(piDirectory, ...PACKAGE_NAME.split('/'));
}

function linkedDirectory(linkPath: string): string | undefined {
  const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  if (!stat?.isSymbolicLink()) return undefined;
  try {
    return fs.realpathSync(linkPath);
  } catch {
    return undefined;
  }
}

/** True when the internal alias points at this installed package. */
export function piExtensionAliasIsCurrent(piDirectory: string, packageRoot = doomPiPackageRoot()): boolean {
  const aliasPath = piExtensionAliasPath(piDirectory);
  const linked = linkedDirectory(aliasPath);
  if (!linked) return false;
  try {
    return fs.realpathSync(linked) === fs.realpathSync(packageRoot) && manifestName(linked) === PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * Creates or repairs the DoomPi-owned local package alias.
 *
 * The link target is relative where the platform supports it so the user
 * configuration and its package installation can move together. Existing
 * non-links are never removed because sync cannot prove that it owns them.
 */
export function writePiExtensionAlias(piDirectory: string, packageRoot = doomPiPackageRoot()): string {
  if (manifestName(packageRoot) !== PACKAGE_NAME) {
    throw new Error(`Cannot alias ${PACKAGE_NAME} to a different package: ${packageRoot}`);
  }

  const aliasPath = piExtensionAliasPath(piDirectory);
  const current = fs.lstatSync(aliasPath, { throwIfNoEntry: false });
  if (current && !current.isSymbolicLink()) {
    throw new Error(`Refusing to replace unmanaged Pi extension path: ${aliasPath}`);
  }
  if (piExtensionAliasIsCurrent(piDirectory, packageRoot)) return aliasPath;

  const parent = path.dirname(aliasPath);
  const parentStat = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (parentStat && !parentStat.isDirectory()) {
    throw new Error(`Refusing to use unmanaged Pi extension scope: ${parent}`);
  }
  fs.mkdirSync(parent, { recursive: true });

  const windows = process.platform === 'win32';
  // A Windows junction does not require symlink privileges, but its target must
  // be absolute. Other platforms use a relative directory link so moving the
  // repository and its local install together keeps the alias valid. Canonical
  // paths avoid macOS's `/tmp` -> `/private/tmp` spelling crossing the link.
  const canonicalParent = fs.realpathSync(parent);
  const canonicalPackageRoot = fs.realpathSync(packageRoot);
  const target = windows ? canonicalPackageRoot : path.relative(canonicalParent, canonicalPackageRoot);
  const temporaryPath = `${aliasPath}.${process.pid}.tmp`;
  fs.rmSync(temporaryPath, { force: true });
  fs.symlinkSync(target, temporaryPath, windows ? 'junction' : 'dir');
  try {
    // Rename is atomic on Unix. Windows cannot replace an existing junction in
    // one rename, so remove only the previously verified link immediately
    // before installing the complete replacement.
    if (current) fs.rmSync(aliasPath, { force: true });
    fs.renameSync(temporaryPath, aliasPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
  return aliasPath;
}
