import { execFile } from 'node:child_process';
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
  | { status: 'ok'; body: Buffer }
  | { status: 'not-found' }
  | { status: 'forbidden' }
  | { status: 'too-large' };

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
  return { status: 'ok', body: await fs.promises.readFile(real) };
}
