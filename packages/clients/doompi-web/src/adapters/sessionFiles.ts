import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { rankFileMatches } from '../services/fileMatch.ts';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 2000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
/** The walk fallback stops collecting past this many entries. */
const WALK_LIMIT = 4000;
const WALK_DEPTH = 6;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'coverage', '.next', '.pnpm']);

async function gitFiles(cwd: string): Promise<string[] | undefined> {
  try {
    // Tracked plus untracked-but-not-ignored: what a person means by "the files".
    const { stdout } = await execFileAsync('git', ['ls-files', '-co', '--exclude-standard'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    const files = stdout.split('\n').filter((line) => line !== '');
    return files.length > 0 ? files : undefined;
  } catch {
    return undefined; // Not a repository, or git is unavailable; the walk covers it.
  }
}

function walkFiles(cwd: string): string[] {
  const files: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (files.length >= WALK_LIMIT || depth > WALK_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= WALK_LIMIT) return;
      if (entry.name.startsWith('.') && entry.name !== '.doom') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(full, depth + 1);
      } else if (entry.isFile()) {
        files.push(path.relative(cwd, full));
      }
    }
  };
  visit(cwd, 0);
  return files;
}

/**
 * The directories a file list implies, each with a trailing separator.
 *
 * Derived from the paths rather than read off disk: `git ls-files` has no
 * directory entries at all, and the walk already paid for this information on
 * its way to the files. It also inherits the ignore rules for free, so a
 * folder only appears when something inside it was worth listing. The cost is
 * that an empty directory is never suggested, which is not what an @ mention
 * is reaching for.
 */
function directoriesOf(files: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    for (let cut = file.indexOf('/'); cut !== -1; cut = file.indexOf('/', cut + 1)) {
      directories.add(file.slice(0, cut + 1));
    }
  }
  return [...directories];
}

/**
 * Repository-relative files and folders under a session's working directory
 * matching a query, for the composer's @ completion. Git's index is the source
 * when available (it already understands ignores); a bounded walk covers plain
 * directories. Folders carry a trailing slash, which is what tells a reader,
 * and the agent, that the mention is a directory.
 */
export async function listSessionFiles(cwd: string, query: string, limit: number): Promise<string[]> {
  const files = (await gitFiles(cwd)) ?? walkFiles(cwd);
  return rankFileMatches([...files, ...directoriesOf(files)], query, limit);
}

export type SessionFileResult =
  | { status: 'ok'; body: Buffer; sha256: string }
  | { status: 'not-found' }
  | { status: 'forbidden' }
  | { status: 'too-large' };

export type SessionFileWriteResult =
  | { status: 'ok'; sha256: string }
  | { status: 'not-found' }
  | { status: 'forbidden' }
  | { status: 'too-large' }
  | { status: 'conflict' }
  | { status: 'locked' };

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * One file under a session's working directory, for the timeline's mention
 * previews. Containment is checked on the real path as well as the lexical
 * one, so a symlink inside the tree cannot hand out something beyond it.
 */
export async function readSessionFile(cwd: string, relativePath: string, maxBytes: number): Promise<SessionFileResult> {
  if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) return { status: 'forbidden' };
  const root = path.resolve(cwd);
  const candidate = path.resolve(root, relativePath);
  if (!isInside(root, candidate)) return { status: 'forbidden' };
  let real: string;
  let stats: fs.Stats;
  try {
    real = await fs.promises.realpath(candidate);
    stats = await fs.promises.stat(real);
  } catch {
    return { status: 'not-found' };
  }
  if (!isInside(await fs.promises.realpath(root), real)) return { status: 'forbidden' };
  if (!stats.isFile()) return { status: 'not-found' };
  if (stats.size > maxBytes) return { status: 'too-large' };
  const body = await fs.promises.readFile(real);
  if (body.byteLength > maxBytes) return { status: 'too-large' };
  return { status: 'ok', body, sha256: createHash('sha256').update(body).digest('hex') };
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function currentFile(
  candidate: string,
  maxBytes: number,
): Promise<{ stats: fs.Stats; sha256: string } | SessionFileWriteResult> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { status: code === 'ELOOP' ? 'forbidden' : 'not-found' };
  }
  try {
    const [stats, pathStats] = await Promise.all([handle.stat(), fs.promises.lstat(candidate)]);
    if (!stats.isFile() || pathStats.isSymbolicLink() || !sameIdentity(stats, pathStats))
      return { status: 'forbidden' };
    if (stats.size > maxBytes) return { status: 'too-large' };
    const body = await handle.readFile();
    if (body.byteLength > maxBytes) return { status: 'too-large' };
    return { stats, sha256: createHash('sha256').update(body).digest('hex') };
  } catch {
    return { status: 'conflict' };
  } finally {
    await handle.close();
  }
}

/**
 * Replaces an existing cwd-contained regular file without following its final
 * path component. The expected digest and inode are checked again immediately
 * before the same-directory rename, so a stale editor cannot silently replace
 * a newer file.
 */
export async function writeSessionFile(
  cwd: string,
  relativePath: string,
  body: Buffer,
  expectedSha256: string,
  maxBytes: number,
  authorizeRename: () => boolean,
): Promise<SessionFileWriteResult> {
  if (body.byteLength > maxBytes) return { status: 'too-large' };
  if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) return { status: 'forbidden' };
  const root = path.resolve(cwd);
  const lexical = path.resolve(root, relativePath);
  if (!isInside(root, lexical)) return { status: 'forbidden' };

  let realRoot: string;
  let realParent: string;
  try {
    [realRoot, realParent] = await Promise.all([
      fs.promises.realpath(root),
      fs.promises.realpath(path.dirname(lexical)),
    ]);
  } catch {
    return { status: 'not-found' };
  }
  if (!isInside(realRoot, realParent)) return { status: 'forbidden' };
  const candidate = path.join(realParent, path.basename(lexical));
  const initial = await currentFile(candidate, maxBytes);
  if ('status' in initial) return initial;
  if (initial.sha256 !== expectedSha256) return { status: 'conflict' };

  const nextSha256 = createHash('sha256').update(body).digest('hex');
  const temporary = path.join(realParent, `.${path.basename(candidate)}.doompi-${randomUUID()}.tmp`);
  let temporaryHandle: fs.promises.FileHandle | undefined;
  try {
    temporaryHandle = await fs.promises.open(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      initial.stats.mode & 0o777,
    );
    await temporaryHandle.writeFile(body);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    const current = await currentFile(candidate, maxBytes);
    if ('status' in current) return current.status === 'not-found' ? { status: 'conflict' } : current;
    if (!sameIdentity(initial.stats, current.stats) || current.sha256 !== expectedSha256) return { status: 'conflict' };
    if (!authorizeRename()) return { status: 'locked' };
    await fs.promises.rename(temporary, candidate);
    return { status: 'ok', sha256: nextSha256 };
  } catch {
    return { status: 'conflict' };
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
}
