import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DoomApi } from '@agimon-ai/doompi-extension-contracts/package-api';

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
          const { stdout } = await promisify(execFile)(
            'rg',
            ['--files', '--null', '--hidden', '-g', '!.git', '-g', '!node_modules'],
            { cwd, timeout: 2000, maxBuffer: 4 * 1024 * 1024, signal: request.signal },
          );
          const files = stdout
            .split('\0')
            .filter((file) => file && file.toLowerCase().includes(query))
            .sort()
            .slice(0, 50);
          return Response.json({ files });
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1)
            return Response.json({ files: [] });
          return Response.json({ error: 'File completion could not be read.' }, { status: 503 });
        }
      },
      close() {
        closed = true;
      },
    };
  },
};
