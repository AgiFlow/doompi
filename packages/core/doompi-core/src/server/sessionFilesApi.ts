import fs from 'node:fs';
import path from 'node:path';

import ignore from 'ignore';

import type { DoomApi } from '../exports/packageApi';

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);
const IGNORE_FILES = ['.gitignore', '.doomignore'];
const FILE_QUERY_TIMEOUT_MS = 2000;
const MAX_FILE_RESULTS = 50;

/** Read ignore rules for one directory, relative to that directory. */
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
  const pending = [{ directory: '', rules: [] as Array<{ base: string; ignores: (file: string) => boolean }> }];
  const deadline = Date.now() + FILE_QUERY_TIMEOUT_MS;
  const matches: string[] = [];

  while (pending.length > 0) {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('File completion was aborted.');
    }
    if (Date.now() > deadline) throw new Error('File completion timed out.');
    const next = pending.pop();
    if (!next) break;
    const { directory, rules } = next;
    const nested = readIgnoreRules(path.join(cwd, directory));
    const activeRules = nested ? [...rules, { base: directory, ignores: nested }] : rules;
    const entries = await fs.promises.readdir(path.join(cwd, directory), { withFileTypes: true });
    for (const entry of entries) {
      // Ignore rules are written in posix form, and so is every result.
      const file = directory === '' ? entry.name : `${directory}/${entry.name}`;
      const ignored = (candidate: string): boolean =>
        activeRules.some(({ base, ignores }) => ignores(base ? candidate.slice(base.length + 1) : candidate));
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name) || ignored(`${file}/`)) continue;
        pending.push({ directory: file, rules: activeRules });
        if (`${file}/`.toLowerCase().includes(query)) matches.push(`${file}/`);
      } else if (entry.isFile() && !ignored(file) && file.toLowerCase().includes(query)) {
        matches.push(file);
      }
    }
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
