import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;
const NARROW_NO_BREAK_SPACE = '\u202f';

export function computeFileTag(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64url').slice(0, 8);
}

export function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Cannot use hashline tools on ${path}: the file is not valid UTF-8.`, { cause: error });
  }
}

/** Return whether the current process can edit an existing file. */
export async function isWritableFile(path: string): Promise<boolean> {
  return access(path, constants.W_OK).then(
    () => true,
    () => false,
  );
}

export function resolveInputPath(input: string, cwd: string): string {
  let path = input.replace(UNICODE_SPACES, ' ');
  if (path.startsWith('@')) path = path.slice(1);
  if (process.platform === 'win32') path = normalizeWindowsShellPath(path);
  if (path === '~') path = homedir();
  else if (path.startsWith(`~${sep}`)) path = resolve(homedir(), path.slice(2));
  else if (path.startsWith('file://')) path = fileURLToPath(path);
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** Resolve the same existing-file variants as Pi's native read tool. */
export async function resolveReadInputPath(input: string, cwd: string): Promise<string> {
  const resolved = resolveInputPath(input, cwd);
  if (await pathExists(resolved)) return resolved;

  const variants = [
    resolved.replace(/ (AM|PM)\./giu, `${NARROW_NO_BREAK_SPACE}$1.`),
    resolved.normalize('NFD'),
    resolved.replaceAll("'", '\u2019'),
    resolved.normalize('NFD').replaceAll("'", '\u2019'),
  ];
  for (const candidate of variants) {
    if (candidate !== resolved && (await pathExists(candidate))) return candidate;
  }
  return resolved;
}

export function displayPath(absolutePath: string, cwd: string): string {
  const path = relative(cwd, absolutePath);
  const display =
    path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) ? path : absolutePath;
  const portable = display.split(sep).join('/');
  return portable === '~' || portable.startsWith('~/') ? `./${portable}` : portable;
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function normalizeWindowsShellPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return path;
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/iu.exec(path);
  if (!match?.[1]) return path;
  const suffix = match[2]?.replaceAll('/', '\\');
  return `${match[1].toUpperCase()}:\\${suffix ?? ''}`;
}
