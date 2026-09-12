import type { DoomApi } from '@agimon-ai/doompi-extension-contracts/package-api';
import { createProviderAuth } from './providerAuth.ts';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Machine-owned provider credentials and model catalog, available without a session. */
export const machineApi: DoomApi = {
  basePath: 'doompi',
  start(context) {
    if (context.scope !== 'global') throw new Error('Provider authentication requires the global mount.');
    const auth = createProviderAuth(context);
    let closed = false;
    return {
      async fetch(request) {
        if (closed) return Response.json({ error: 'Provider mount is closed.' }, { status: 503 });
        const url = new URL(request.url);
        try {
          if (url.pathname === '/providers' && request.method === 'GET')
            return Response.json({ providers: await auth.listProviders() });
          if (url.pathname === '/models' && request.method === 'GET')
            return Response.json({ models: await auth.listModels() });
          const provider = /^\/providers\/([^/]+)$/u.exec(url.pathname);
          if (provider && request.method === 'DELETE') {
            const result = await auth.logout(decodeURIComponent(provider[1]));
            return result.ok
              ? Response.json({ ok: true })
              : Response.json({ error: result.error }, { status: result.code === 'unknown_provider' ? 404 : 502 });
          }
          if (url.pathname === '/logins' && request.method === 'POST') {
            const body: unknown = await request.json();
            if (
              !record(body) ||
              typeof body.providerId !== 'string' ||
              (body.type !== 'oauth' && body.type !== 'api_key')
            )
              return Response.json({ error: 'A provider and supported login method are required.' }, { status: 400 });
            const result = await auth.startLogin(body.providerId, body.type);
            return result.ok
              ? Response.json({ flow: result.flow }, { status: 201 })
              : Response.json(
                  { error: result.error },
                  { status: result.code === 'unknown_provider' ? 404 : result.code === 'busy' ? 409 : 400 },
                );
          }
          const flow = /^\/logins\/([^/]+)(\/answer)?$/u.exec(url.pathname);
          if (flow) {
            const id = decodeURIComponent(flow[1]);
            if (!auth.getLogin(id)) return Response.json({ error: 'Login flow not found.' }, { status: 404 });
            if (flow[2] && request.method === 'POST') {
              const body: unknown = await request.json();
              if (!record(body) || typeof body.promptId !== 'string' || typeof body.value !== 'string')
                return Response.json({ error: 'A prompt ID and answer are required.' }, { status: 400 });
              const answer = auth.answerLogin(id, body.promptId, body.value);
              return answer === 'answered'
                ? Response.json({ flow: auth.getLogin(id) })
                : Response.json({ error: 'Login is no longer waiting for this answer.' }, { status: 409 });
            }
            if (!flow[2] && request.method === 'GET') return Response.json({ flow: auth.getLogin(id) });
            if (!flow[2] && request.method === 'DELETE') return Response.json({ flow: auth.cancelLogin(id) });
          }
          return Response.json({ error: 'Provider route not found.' }, { status: 404 });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: error instanceof SyntaxError ? 400 : 502 },
          );
        }
      },
      close() {
        closed = true;
        auth.close();
      },
    };
  },
};
