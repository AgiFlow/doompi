import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { registerOAuthRedirectRoutes } from '../../src/adapters/oauthRedirectRoutes.ts';
import { createOAuthRedirectRegistry } from '../../src/services/oauthRedirectRegistry.ts';
import { MCP_OAUTH_CALLBACK_ROUTE } from '../../src/types/mcpOAuth.ts';

const ORIGIN = 'https://tunnel.example.test';

function harness() {
  const registry = createOAuthRedirectRegistry(MCP_OAUTH_CALLBACK_ROUTE);
  const app = new Hono();
  registerOAuthRedirectRoutes(app, registry);
  return { registry, app, surface: registry.surface(ORIGIN) };
}

const callback = (query: string): string => `${MCP_OAUTH_CALLBACK_ROUTE}?${query}`;

describe('the hub OAuth redirect surface', () => {
  it('advertises a redirect on the origin it was lent', () => {
    const { surface } = harness();
    expect(surface.redirectUri).toBe(`${ORIGIN}${MCP_OAUTH_CALLBACK_ROUTE}`);
  });

  it('follows the origin when a tunnel reconnects on a new hostname', () => {
    const { registry } = harness();
    expect(registry.surface('https://second.example.test').redirectUri).toBe(
      `https://second.example.test${MCP_OAUTH_CALLBACK_ROUTE}`,
    );
  });

  it('hands a redirect to the flow that reserved its state', async () => {
    const { app, surface } = harness();
    await surface.reserve('state-1');
    const waiting = surface.wait('state-1');

    const response = await app.request(callback('code=granted&state=state-1'));

    expect(response.status).toBe(200);
    await expect(waiting).resolves.toEqual({ code: 'granted', state: 'state-1' });
  });

  it('accepts a redirect that arrives before anyone waits', async () => {
    const { app, surface } = harness();
    await surface.reserve('state-early');

    // The URL reaches the user the moment it is surfaced, so the redirect can
    // beat the caller to `wait`.
    expect((await app.request(callback('code=fast&state=state-early'))).status).toBe(200);

    await expect(surface.wait('state-early')).resolves.toEqual({ code: 'fast', state: 'state-early' });
  });

  it('refuses a state nobody reserved without disturbing anything', async () => {
    const { app } = harness();
    const response = await app.request(callback('code=granted&state=never-seen'));
    expect(response.status).toBe(404);
  });

  it('refuses to deliver the same state twice', async () => {
    const { app, surface } = harness();
    await surface.reserve('state-2');
    const waiting = surface.wait('state-2');
    await app.request(callback('code=first&state=state-2'));

    expect((await app.request(callback('code=second&state=state-2'))).status).toBe(404);
    await expect(waiting).resolves.toMatchObject({ code: 'first' });
  });

  it('refuses a second reservation rather than orphaning the first flow', async () => {
    const { surface } = harness();
    await surface.reserve('state-3');
    await expect(surface.reserve('state-3')).rejects.toThrow('already reserved');
  });

  it('reports the provider error instead of pretending to succeed', async () => {
    const { app } = harness();
    const response = await app.request(callback('error=access_denied&error_description=Denied+by+user'));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Denied by user');
  });

  it('rejects a request that carries no code', async () => {
    const { app } = harness();
    expect((await app.request(callback('state=state-4'))).status).toBe(400);
  });

  it('fails a waiting flow when it is cancelled', async () => {
    const { surface } = harness();
    await surface.reserve('state-5');
    const waiting = surface.wait('state-5');
    surface.cancel('state-5');
    await expect(waiting).rejects.toThrow('cancelled');
  });

  it('fails every waiting flow when the hub shuts down', async () => {
    const { registry, surface } = harness();
    await surface.reserve('state-6');
    const waiting = surface.wait('state-6');
    registry.close();
    await expect(waiting).rejects.toThrow('shutting down');
  });

  it('refuses to wait on a state that was never reserved', async () => {
    const { surface } = harness();
    await expect(surface.wait('ghost')).rejects.toThrow('No redirect is reserved');
  });

  it('expires a reservation that is never redirected', async () => {
    const { app, surface } = harness();
    await surface.reserve('state-7', 1);
    const waiting = surface.wait('state-7');

    await expect(waiting).rejects.toThrow('Timed out');
    expect((await app.request(callback('code=late&state=state-7'))).status).toBe(404);
  });
});
