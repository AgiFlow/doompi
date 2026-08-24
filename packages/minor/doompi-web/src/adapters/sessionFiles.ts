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
 * Repository-relative files under a session's working directory matching a
 * query, for the composer's @ completion. Git's index is the source when
 * available (it already understands ignores); a bounded walk covers plain
 * directories.
 */
export async function listSessionFiles(cwd: string, query: string, limit: number): Promise<string[]> {
  const files = (await gitFiles(cwd)) ?? walkFiles(cwd);
  return rankFileMatches(files, query, limit);
}
