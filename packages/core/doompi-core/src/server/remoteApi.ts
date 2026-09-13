import type { DoomApi } from '../exports/packageApi';

/** Global package mount for the machine's Remote Control service. */
export const remoteApi: DoomApi = {
  basePath: 'remote',
  start(context) {
    if (context.scope !== 'global' || !context.remoteControl)
      throw new Error('Remote Control requires the global headless host.');
    const control = context.remoteControl;
    let closed = false;
    return {
      fetch(request) {
        if (closed) return Response.json({ error: 'Remote Control is closed.' }, { status: 503 });
        const origin = request.headers.get('origin');
        if (origin !== null) {
          let allowed = false;
          try {
            const parsed = new URL(origin);
            allowed = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
          } catch {
            allowed = false;
          }
          if (!allowed) return Response.json({ error: 'That origin may not control this cockpit.' }, { status: 403 });
        }
        const from = new URL(request.url);
        const suffix = from.pathname === '/' ? '' : from.pathname;
        const target = new URL(`/api/remote${suffix}${from.search}`, 'http://doompi.local');
        return control.fetch(new Request(target, request));
      },
      close() {
        closed = true;
      },
    };
  },
};
