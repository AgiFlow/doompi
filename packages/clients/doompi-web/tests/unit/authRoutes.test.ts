import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { registerAuthRoutes } from '../../src/adapters/authRoutes.ts';
import { createProviderAuth } from '../../src/adapters/providerAuth.ts';
import type { AuthRuntime } from '../../src/types/auth.ts';
import { createFakeAuthRuntime, tick } from '../support/fakeAuthRuntime.ts';

const PROVIDERS = '/api/auth/providers';
const LOGINS = '/api/auth/logins';

function app(runtime: () => Promise<AuthRuntime> = async () => createFakeAuthRuntime()): Hono {
  const hono = new Hono();
  registerAuthRoutes(hono, createProviderAuth({ runtime }));
  return hono;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function startedFlowId(hono: Hono): Promise<string> {
  const response = await hono.request(LOGINS, json({ providerId: 'anthropic', type: 'api_key' }));
  expect(response.status).toBe(201);
  const body = (await response.json()) as { flow: { id: string } };
  await tick();
  return body.flow.id;
}

describe('auth routes', () => {
  it('lists providers', async () => {
    const response = await app().request(PROVIDERS);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: { id: string }[] };
    expect(body.providers.map((provider) => provider.id)).toEqual(['bedrock', 'anthropic', 'zeta']);
  });

  it('answers 502 with the cause when the runtime cannot load', async () => {
    const broken = app(async () => {
      throw new Error('pi is missing');
    });
    const listed = await broken.request(PROVIDERS);
    expect(listed.status).toBe(502);
    await expect(listed.json()).resolves.toEqual({ error: 'Provider auth is unavailable: pi is missing' });
    const started = await broken.request(LOGINS, json({ providerId: 'anthropic', type: 'api_key' }));
    expect(started.status).toBe(502);
    const loggedOut = await broken.request(`${PROVIDERS}/anthropic`, { method: 'DELETE' });
    expect(loggedOut.status).toBe(502);
  });

  it('validates the login request', async () => {
    const hono = app();
    expect((await hono.request(LOGINS, { method: 'POST', body: 'nope' })).status).toBe(400);
    expect((await hono.request(LOGINS, json({ type: 'api_key' }))).status).toBe(400);
    expect((await hono.request(LOGINS, json({ providerId: 'anthropic', type: 'magic' }))).status).toBe(400);
    expect((await hono.request(LOGINS, json({ providerId: 'nope', type: 'api_key' }))).status).toBe(404);
    expect((await hono.request(LOGINS, json({ providerId: 'bedrock', type: 'api_key' }))).status).toBe(400);
  });

  it('runs a login from start through answer to success', async () => {
    const hono = app();
    const flowId = await startedFlowId(hono);
    expect((await hono.request(LOGINS, json({ providerId: 'anthropic', type: 'oauth' }))).status).toBe(409);

    const polled = await hono.request(`${LOGINS}/${flowId}`);
    expect(polled.status).toBe(200);
    await expect(polled.json()).resolves.toMatchObject({
      flow: { status: 'running', prompt: { id: '1', type: 'secret' } },
    });

    expect((await hono.request(`${LOGINS}/${flowId}/answer`, { method: 'POST', body: '{' })).status).toBe(400);
    expect((await hono.request(`${LOGINS}/${flowId}/answer`, json({ promptId: '1' }))).status).toBe(400);
    expect((await hono.request(`${LOGINS}/missing/answer`, json({ promptId: '1', value: 'x' }))).status).toBe(404);
    expect((await hono.request(`${LOGINS}/${flowId}/answer`, json({ promptId: '9', value: 'x' }))).status).toBe(409);

    const answered = await hono.request(`${LOGINS}/${flowId}/answer`, json({ promptId: '1', value: 'sk-test' }));
    expect(answered.status).toBe(200);
    await tick();
    await expect((await hono.request(`${LOGINS}/${flowId}`)).json()).resolves.toMatchObject({
      flow: { status: 'succeeded' },
    });
    const listed = (await (await hono.request(PROVIDERS)).json()) as {
      providers: { id: string; authenticated?: unknown }[];
    };
    expect(listed.providers.find((provider) => provider.id === 'anthropic')?.authenticated).toEqual({
      type: 'api_key',
      source: 'stored',
    });
  });

  it('cancels a login and 404s unknown flows', async () => {
    const hono = app();
    expect((await hono.request(`${LOGINS}/missing`)).status).toBe(404);
    expect((await hono.request(`${LOGINS}/missing`, { method: 'DELETE' })).status).toBe(404);
    const flowId = await startedFlowId(hono);
    const cancelled = await hono.request(`${LOGINS}/${flowId}`, { method: 'DELETE' });
    expect(cancelled.status).toBe(202);
    await expect(cancelled.json()).resolves.toMatchObject({ flow: { status: 'cancelled' } });
  });

  it('logs out a provider', async () => {
    const runtime = createFakeAuthRuntime();
    runtime.stored.add('anthropic');
    const hono = app(async () => runtime);
    expect((await hono.request(`${PROVIDERS}/nope`, { method: 'DELETE' })).status).toBe(404);
    const response = await hono.request(`${PROVIDERS}/anthropic`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ providerId: 'anthropic' });
    expect(runtime.stored.has('anthropic')).toBe(false);
    runtime.logoutError = new Error('locked');
    expect((await hono.request(`${PROVIDERS}/anthropic`, { method: 'DELETE' })).status).toBe(502);
  });
});
