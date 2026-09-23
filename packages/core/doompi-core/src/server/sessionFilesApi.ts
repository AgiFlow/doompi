import fs from 'node:fs';
import path from 'node:path';

import ignore from 'ignore';

import type { DoomApi } from '../exports/packageApi';

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);
const IGNORE_FILES = ['.gitignore', '.doomignore'];
const FILE_QUERY_TIMEOUT_MS = 2000;
const MAX_FILE_RESULTS = 50;

/**
 * The project's ignore test, or nothing when it declares no rules.
 *
 * Only the session root's files are read. A nested .gitignore would need one
 * matcher per directory, and the cost of skipping it is a suggestion that
 * should not have been offered rather than a file that cannot be opened. An
 * unreadable or malformed file leaves completion listing everything, because
 * hiding the tree is the worse failure.
 */
function readIgnoreRules(cwd: string): ((relativePath: string) => boolean) | undefined {
  const rules = IGNORE_FILES.map((name) => {
    try {
      return fs.readFileSync(path.join(cwd, name), 'utf8');
    } catch {
      return '';
    }
  }).join('\n');
  if (rules.trim().length === 0) return undefined;
  try {
    const matcher = ignore().add(rules);
    return (relativePath: string): boolean => matcher.ignores(relativePath);
  } catch {
    return undefined;
  }
}

async function listSessionFiles(cwd: string, query: string, signal: AbortSignal): Promise<string[]> {
  const isIgnored = readIgnoreRules(cwd);
  const deadline = Date.now() + FILE_QUERY_TIMEOUT_MS;
  const pending = [''];
  let next = 0;
  const matches: string[] = [];

  while (next < pending.length && matches.length < MAX_FILE_RESULTS) {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('File completion was aborted.');
    }
    // ponytail: Return matches found so far on huge trees; a search index is the upgrade path.
    if (Date.now() > deadline && next > 0) break;
    const relativeDirectory = pending[next++];
    if (relativeDirectory === undefined) break;
    if (relativeDirectory !== '' && `${relativeDirectory}/`.toLowerCase().includes(query)) {
      matches.push(`${relativeDirectory}/`);
    }
    if (matches.length === MAX_FILE_RESULTS) break;
    const entries = await fs.promises.readdir(path.join(cwd, relativeDirectory), { withFileTypes: true });
    const matchingDirectories: string[] = [];
    for (const entry of entries) {
      // Ignore rules are written in posix form, and so is every result.
      const file = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        // An ignored directory is pruned rather than filtered at its leaves:
        // walking a build cache is what exhausts the completion budget. The
        // trailing slash is what makes a directory-only rule such as
        // '.nx-cache/' match.
        if (EXCLUDED_DIRECTORIES.has(entry.name) || isIgnored?.(`${file}/`) === true) continue;
        // Explore a matching folder before its siblings so its files follow it.
        if (query && entry.name.toLowerCase().includes(query)) matchingDirectories.push(file);
        else pending.push(file);
      } else if (entry.isFile() && isIgnored?.(file) !== true && file.toLowerCase().includes(query)) {
        matches.push(file);
      }
      if (matches.length === MAX_FILE_RESULTS) break;
    }
    pending.splice(next, 0, ...matchingDirectories);
  }

  return matches.sort().slice(0, MAX_FILE_RESULTS);
}

/** Bounded, read-only file completion rooted in the owning session. */
export const sessionFilesApi: DoomApi = {
  basePath: 'files',
  start(context) {
    if (context.scope !== 'session' || !context.cwd) throw new Error('File completion requires a session.');
    const cwd = context.cwd;
    let closed = false;
    return {
      async fetch(request) {
        if (closed) return new Response(null, { status: 503 });
        const url = new URL(request.url);
        if (request.method !== 'GET' || url.pathname !== '/') return new Response(null, { status: 404 });
        const query = (url.searchParams.get('q') ?? '').toLowerCase();
        if (query.length > 256) return Response.json({ error: 'File query is too long.' }, { status: 400 });
        try {
          return Response.json({ files: await listSessionFiles(cwd, query, request.signal) });
        } catch {
          return Response.json({ error: 'File completion could not be read.' }, { status: 503 });
        }
      },
      close() {
        closed = true;
      },
    };
  },
};
