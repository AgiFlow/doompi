import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOOM_PACKAGE_NAME, manifestName } from './doomPackage.ts';
import {
  piExtensionDispatcherIsCurrent,
  piExtensionDispatcherPath,
  writePiExtensionDispatcher,
} from './piExtensionDispatcher.ts';

function nearestPackageRoot(start: string): string {
  let directory = path.resolve(start);
  while (true) {
    if (manifestName(directory) === DOOM_PACKAGE_NAME) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not locate installed ${DOOM_PACKAGE_NAME} package from ${start}`);
    }
    directory = parent;
  }
}

/** Installed package root for the source or compiled module executing sync. */
export function doomPiPackageRoot(moduleUrl = import.meta.url): string {
  return nearestPackageRoot(path.dirname(fileURLToPath(moduleUrl)));
}

/** Compatibility name for the stable package path now occupied by the dispatcher. */
export function piExtensionAliasPath(piDirectory: string): string {
  return piExtensionDispatcherPath(piDirectory);
}

/** Compatibility name for init-owned dispatcher readiness. */
export function piExtensionAliasIsCurrent(piDirectory: string, _packageRoot = doomPiPackageRoot()): boolean {
  return piExtensionDispatcherIsCurrent(piDirectory);
}

/** Compatibility name retained while callers migrate from the legacy symlink. */
export function writePiExtensionAlias(piDirectory: string, packageRoot = doomPiPackageRoot()): string {
  if (manifestName(packageRoot) !== DOOM_PACKAGE_NAME) {
    throw new Error(`Cannot initialize ${DOOM_PACKAGE_NAME} from a different package: ${packageRoot}`);
  }
  return writePiExtensionDispatcher(piDirectory);
}
