import fs from 'node:fs';
import path from 'node:path';

import type { DoomApi } from '../exports/packageApi';

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);
const FILE_QUERY_TIMEOUT_MS = 2000;
const MAX_FILE_RESULTS = 50;

async function listSessionFiles(cwd: string, query: string, signal: AbortSignal): Promise<string[]> {
  const deadline = Date.now() + FILE_QUERY_TIMEOUT_MS;
  const pending = [''];
  const matches: string[] = [];

  while (pending.length > 0) {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('File completion was aborted.');
    }
    if (Date.now() > deadline) throw new Error('File completion timed out.');
    const relativeDirectory = pending.pop();
    if (relativeDirectory === undefined) break;
    const entries = await fs.promises.readdir(path.join(cwd, relativeDirectory), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) {
        pending.push(relativePath);
      } else if (entry.isFile()) {
        const file = relativePath.split(path.sep).join('/');
        if (file.toLowerCase().includes(query)) matches.push(file);
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
