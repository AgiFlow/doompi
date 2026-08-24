import type { Hono } from 'hono';
import { AUTH_LOGINS_API_ROUTE, AUTH_PROVIDERS_API_ROUTE, type AuthMethodType } from '../types/auth.ts';
import type { ProviderAuth } from './providerAuth.ts';

const METHOD_TYPES: readonly AuthMethodType[] = ['api_key', 'oauth'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMethodType(value: unknown): value is AuthMethodType {
  return typeof value === 'string' && (METHOD_TYPES as readonly string[]).includes(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The provider-auth REST surface. Every handler that reaches the Pi runtime
 * turns a load failure into 502 with the cause, so a machine without a usable
 * Pi install explains itself on the providers page instead of hanging it.
 */
export function registerAuthRoutes(app: Hono, auth: ProviderAuth): void {
  app.get(AUTH_PROVIDERS_API_ROUTE, async (context) => {
    try {
      return context.json({ providers: await auth.listProviders() });
    } catch (error) {
      return context.json({ error: `Provider auth is unavailable: ${describe(error)}` }, 502);
    }
  });

  app.delete(`${AUTH_PROVIDERS_API_ROUTE}/:providerId`, async (context) => {
    const providerId = context.req.param('providerId');
    try {
      const outcome = await auth.logout(providerId);
      if (outcome.ok) return context.json({ providerId });
      return context.json({ error: outcome.error }, outcome.code === 'unknown_provider' ? 404 : 502);
    } catch (error) {
      return context.json({ error: `Provider auth is unavailable: ${describe(error)}` }, 502);
    }
  });

  app.post(AUTH_LOGINS_API_ROUTE, async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'The request body must be JSON.' }, 400);
    }
    if (!isRecord(body) || typeof body.providerId !== 'string' || body.providerId === '') {
      return context.json({ error: 'A providerId string is required.' }, 400);
    }
    if (!isMethodType(body.type)) {
      return context.json({ error: `type must be one of ${METHOD_TYPES.join(', ')}.` }, 400);
    }
    try {
      const outcome = await auth.startLogin(body.providerId, body.type);
      if (outcome.ok) return context.json({ flow: outcome.flow }, 201);
      const status = outcome.code === 'unknown_provider' ? 404 : outcome.code === 'busy' ? 409 : 400;
      return context.json({ error: outcome.error }, status);
    } catch (error) {
      return context.json({ error: `Provider auth is unavailable: ${describe(error)}` }, 502);
    }
  });

  app.get(`${AUTH_LOGINS_API_ROUTE}/:flowId`, (context) => {
    const flow = auth.getLogin(context.req.param('flowId'));
    if (!flow) return context.json({ error: 'No such login flow.' }, 404);
    return context.json({ flow });
  });

  app.post(`${AUTH_LOGINS_API_ROUTE}/:flowId/answer`, async (context) => {
    const flowId = context.req.param('flowId');
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'The request body must be JSON.' }, 400);
    }
    if (!isRecord(body) || typeof body.promptId !== 'string' || typeof body.value !== 'string') {
      return context.json({ error: 'promptId and value strings are required.' }, 400);
    }
    const outcome = auth.answerLogin(flowId, body.promptId, body.value);
    if (outcome === 'unknown_flow') return context.json({ error: 'No such login flow.' }, 404);
    if (outcome === 'not_waiting') return context.json({ error: 'The flow is not waiting on that prompt.' }, 409);
    return context.json({ flow: auth.getLogin(flowId) });
  });

  app.delete(`${AUTH_LOGINS_API_ROUTE}/:flowId`, (context) => {
    const flow = auth.cancelLogin(context.req.param('flowId'));
    if (!flow) return context.json({ error: 'No such login flow.' }, 404);
    return context.json({ flow }, 202);
  });
}
