/**
 * How to invoke the Pi CLI for a child process.
 *
 * DESIGN PATTERNS:
 * - Three resolution tiers, most explicit first: an operator override env var,
 *   then a verified script path run through this process's own Node binary, then
 *   bare `pi` on PATH. Running the resolved script under `process.execPath` means
 *   a child gets the same Node version as its parent, which a shebang would not
 *   guarantee
 * - Every resolution step is best-effort. Failing to identify the installed CLI
 *   is not an error, it just falls through to the next tier
 * - Filesystem and resolver calls are injectable, because ESM module namespaces
 *   are frozen and `node:fs` cannot otherwise be substituted in a test
 *
 * AVOID:
 * - Trusting `process.argv[1]` without confirming it really is the Pi CLI. The
 *   host embedding this package has its own entry point there, and spawning that
 *   would run the host again rather than the agent
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PI_SUBAGENT_PI_BINARY_ENV } from '../../../types/environment';

export const PI_CODING_AGENT_PACKAGE = '@earendil-works/pi-coding-agent';

const PACKAGE_MANIFEST_NAME = 'package.json';
const PI_BIN_FIELD_NAME = 'pi';
const PI_PATH_COMMAND = 'pi';
const NODE_SCRIPT_EXTENSIONS = /\.(?:mjs|cjs|js)$/i;
const NODE_MODULES_DIR_NAME = 'node_modules';

/** The candidate directory itself, when its manifest names the Pi package. */
function piPackageAt(candidate: string): string | undefined {
  const packageJsonPath = path.join(candidate, PACKAGE_MANIFEST_NAME);
  if (!fs.existsSync(packageJsonPath)) return undefined;
  const manifest: unknown = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  return readManifestName(manifest) === PI_CODING_AGENT_PACKAGE ? candidate : undefined;
}

/** Where a Pi installation would sit beside this ancestor. */
function piInstallNeighbor(dir: string): string {
  const modulesDir = path.basename(dir) === NODE_MODULES_DIR_NAME ? dir : path.join(dir, NODE_MODULES_DIR_NAME);
  return path.join(modulesDir, PI_CODING_AGENT_PACKAGE);
}

/**
 * Walk up from an entry point to the package root that declares the Pi CLI.
 *
 * Strict on purpose: only an entry INSIDE the Pi package proves anything, and
 * `resolvePiCliScript` leans on that proof before trusting `process.argv[1]`.
 * Finding a Pi installation NEAR an entry is a different question; that is
 * `findPiInstallNearEntry`.
 */
export function findPiPackageRootFromEntry(entryPoint: string): string | undefined {
  let dir = path.dirname(entryPoint);
  while (dir !== path.dirname(dir)) {
    const found = piPackageAt(dir);
    if (found) return found;
    dir = path.dirname(dir);
  }
  return undefined;
}

/**
 * Walk up from an entry point to any Pi installation: the entry's own package,
 * or one installed beside an ancestor. The sibling probe matters when the
 * running host is not Pi itself but embeds it as a dependency (the DoomPi CLI
 * does), because a detached child needs that root to resolve the Pi SDK at
 * all. Never use this as proof that the entry IS the Pi CLI.
 */
export function findPiInstallNearEntry(entryPoint: string): string | undefined {
  let dir = path.dirname(entryPoint);
  while (dir !== path.dirname(dir)) {
    const found = piPackageAt(dir) ?? piPackageAt(piInstallNeighbor(dir));
    if (found) return found;
    dir = path.dirname(dir);
  }
  return undefined;
}

/** The Pi installation adjacent to this process's own entry point, when there is one. */
export function resolvePiPackageRootNearHost(): string | undefined {
  try {
    const entry = process.argv[1];
    return entry ? findPiInstallNearEntry(fs.realpathSync(entry)) : undefined;
  } catch {
    // argv[1] probing is best-effort; callers fall through to other tiers.
    return undefined;
  }
}

function readManifestName(manifest: unknown): string | undefined {
  if (typeof manifest !== 'object' || manifest === null) return undefined;
  const name: unknown = (manifest as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

/**
 * The `bin` entry to spawn, from a package manifest of unknown shape.
 *
 * npm allows `bin` to be either a bare string or a map. The named `pi` entry
 * wins; any single other entry is accepted because a renamed fork still exposes
 * exactly one executable.
 */
function readManifestBinPath(manifest: unknown): string | undefined {
  if (typeof manifest !== 'object' || manifest === null) return undefined;
  const bin: unknown = (manifest as { bin?: unknown }).bin;
  if (typeof bin === 'string') return bin;
  if (typeof bin !== 'object' || bin === null) return undefined;
  const entries: Record<string, unknown> = bin as Record<string, unknown>;
  const named: unknown = entries[PI_BIN_FIELD_NAME];
  if (typeof named === 'string') return named;
  const first = Object.values(entries).find((value): value is string => typeof value === 'string');
  return first;
}

export function resolveInstalledPiPackageRoot(): string | undefined {
  return findPiPackageRootFromEntry(fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE)));
}

export function resolvePiPackageRoot(): string | undefined {
  try {
    const entry = process.argv[1];
    return entry ? findPiPackageRootFromEntry(fs.realpathSync(entry)) : undefined;
  } catch {
    // process.argv[1] probing is best-effort; callers fall back to PATH or package resolution.
    return undefined;
  }
}

export interface PiSpawnDeps {
  platform?: NodeJS.Platform;
  execPath?: string;
  argv1?: string;
  existsSync?: (filePath: string) => boolean;
  realpathSync?: (filePath: string) => string;
  readFileSync?: (filePath: string, encoding: 'utf-8') => string;
  resolvePackageJson?: () => string;
  resolvePackageEntry?: () => string;
  piPackageRoot?: string;
  env?: NodeJS.ProcessEnv;
}

interface PiSpawnCommand {
  command: string;
  args: string[];
}

function isRunnableNodeScript(filePath: string, existsSync: (filePath: string) => boolean): boolean {
  if (!existsSync(filePath)) return false;
  return NODE_SCRIPT_EXTENSIONS.test(filePath);
}

function normalizePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

/** A concrete Pi CLI script this process can hand to Node, or undefined. */
export function resolvePiCliScript(deps: PiSpawnDeps = {}): string | undefined {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const realpathSync = deps.realpathSync ?? fs.realpathSync;
  const readFileSync =
    deps.readFileSync ?? ((filePath: string, encoding: 'utf-8') => fs.readFileSync(filePath, encoding));
  const argv1 = deps.argv1 ?? process.argv[1];

  // Reuse our own entry point only when it provably belongs to the Pi package.
  if (argv1) {
    const argvPath = normalizePath(argv1);
    if (isRunnableNodeScript(argvPath, existsSync)) {
      try {
        const canonicalArgvPath = realpathSync(argvPath);
        if (isRunnableNodeScript(canonicalArgvPath, existsSync) && findPiPackageRootFromEntry(canonicalArgvPath)) {
          return canonicalArgvPath;
        }
      } catch {
        // Host package metadata is untrusted here; keep resolving the installed Pi CLI.
      }
    }
  }

  try {
    const resolvePackageJson =
      deps.resolvePackageJson ??
      (() => {
        const root = deps.piPackageRoot ?? resolvePiPackageRoot();
        if (root) return path.join(root, PACKAGE_MANIFEST_NAME);
        const packageRoot = deps.resolvePackageEntry
          ? findPiPackageRootFromEntry(deps.resolvePackageEntry())
          : resolveInstalledPiPackageRoot();
        if (!packageRoot) throw new Error(`Could not resolve ${PI_CODING_AGENT_PACKAGE} package root`);
        return path.join(packageRoot, PACKAGE_MANIFEST_NAME);
      });
    const packageJsonPath = resolvePackageJson();
    const manifest: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const binPath = readManifestBinPath(manifest);
    if (!binPath) return undefined;
    const candidate = path.resolve(path.dirname(packageJsonPath), binPath);
    if (isRunnableNodeScript(candidate, existsSync)) {
      return candidate;
    }
  } catch {
    // Verified CLI resolution is optional; falling back to `pi` lets PATH handle execution.
    return undefined;
  }

  return undefined;
}

export function getPiSpawnCommand(args: string[], deps: PiSpawnDeps = {}): PiSpawnCommand {
  const env = deps.env ?? process.env;
  const piBinary = env[PI_SUBAGENT_PI_BINARY_ENV]?.trim();
  if (piBinary) {
    return { command: piBinary, args };
  }

  const piCliPath = resolvePiCliScript(deps);
  if (piCliPath) {
    return {
      command: deps.execPath ?? process.execPath,
      args: [piCliPath, ...args],
    };
  }

  return { command: PI_PATH_COMMAND, args };
}
