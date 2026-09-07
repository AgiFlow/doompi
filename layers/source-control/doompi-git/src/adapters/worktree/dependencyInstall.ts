/**
 * Installing a fresh worktree's dependencies.
 *
 * DESIGN PATTERNS:
 * - The package manager is chosen by the lockfile the repository already
 *   committed, never guessed and never configured. A worktree shares the
 *   parent's history, so the lockfile is always the right answer.
 * - A repository with no manifest installs nothing and reports that plainly.
 *   Not every checkout is a Node project.
 * - Failure is reported, not thrown. A worktree whose install failed is still
 *   a usable worktree; refusing to create it would be a worse trade than
 *   letting the caller decide.
 *
 * AVOID:
 * - Carrying stdout or stderr into the result. Installers print absolute paths
 *   and registry URLs; the caller gets a code and a byte length.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A cold install pulls the whole store. The repository's own measured install
 * is well under a minute when the store is warm, but a first run on a new
 * machine is not, and killing it half way leaves a broken node_modules.
 */
const INSTALL_TIMEOUT_MS = 900_000;

const LOCKFILES: ReadonlyArray<{ file: string; command: string; args: readonly string[] }> = [
  { file: 'pnpm-lock.yaml', command: 'pnpm', args: ['install', '--prefer-offline'] },
  { file: 'yarn.lock', command: 'yarn', args: ['install'] },
  { file: 'package-lock.json', command: 'npm', args: ['install'] },
  { file: 'bun.lockb', command: 'bun', args: ['install'] },
];

export type InstallOutcome =
  | { kind: 'skipped'; reason: 'no-manifest' | 'no-lockfile' }
  | { kind: 'installed'; command: string; durationMs: number }
  | { kind: 'failed'; command: string; code: number | null; stderrBytes: number };

/** Chooses the installer this repository already uses, by its committed lockfile. */
export function installerFor(root: string): { command: string; args: readonly string[] } | undefined {
  return LOCKFILES.find((entry) => fs.existsSync(path.join(root, entry.file)));
}

/**
 * Installs into a freshly created worktree.
 *
 * The session that opens in the worktree resolves the repository's own
 * composition, and every workspace package path in it points at a directory
 * that only exists once dependencies are linked. Without this the session
 * falls back to the global bundle and silently loses the repository's packages.
 */
export async function installDependencies(root: string, now: () => number = Date.now): Promise<InstallOutcome> {
  if (!fs.existsSync(path.join(root, 'package.json'))) return { kind: 'skipped', reason: 'no-manifest' };
  const installer = installerFor(root);
  if (installer === undefined) return { kind: 'skipped', reason: 'no-lockfile' };

  const startedAt = now();
  return await new Promise<InstallOutcome>((resolve) => {
    execFile(
      installer.command,
      [...installer.args],
      { cwd: root, timeout: INSTALL_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' } },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve({ kind: 'installed', command: installer.command, durationMs: now() - startedAt });
          return;
        }
        resolve({
          kind: 'failed',
          command: installer.command,
          code: typeof error.code === 'number' ? error.code : null,
          stderrBytes: Buffer.byteLength(String(stderr)),
        });
      },
    );
  });
}
