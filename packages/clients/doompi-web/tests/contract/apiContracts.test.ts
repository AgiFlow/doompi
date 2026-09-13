import { builtinApiContract, canonicalContractJson, createApiDocuments } from '@agimon-ai/doompi-core/api-contracts';
import { createHeadlessHub } from '@agimon-ai/doompi-core/headless-hub';
import { serveHeadlessServer } from '@agimon-ai/doompi-core/headless-server';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSession, searchDirectories } from '../../src/web/lib/hubApi';

const gateway = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock('../../src/web/lib/stepUp', () => ({ fetchWithStepUp: gateway.fetch }));
vi.mock('../../src/web/lib/sealedSession', () => ({ sealedHttpSession: { fetch: gateway.fetch } }));

const selections = (['global', 'workspace', 'session'] as const).map((scope) => ({
  scope,
  majorMode: 'copilot',
  activeLayers: [],
  compiled: {
    version: 1 as const,
    generation: 'test',
    fingerprint: 'a'.repeat(64),
    packages: [
      {
        packageName: '@agimon-ai/doompi',
        packageVersion: 'test',
        scopes: [scope],
        owners: [{ majorMode: 'copilot', layer: 'default' }],
        contract: builtinApiContract,
      },
    ],
  },
}));
const exported = JSON.parse(canonicalContractJson(createApiDocuments(selections).openapi));
const validator = new Ajv2020({ strict: false });
function accepts(schema: object, value: unknown): boolean {
  return validator.compile({ ...schema, components: exported.components })(value) === true;
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  gateway.fetch.mockReset();
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function server() {
  const hub = createHeadlessHub({
    manager: {
      create: async () => {
        throw new Error('Agent creation is outside this transport fixture');
      },
      get: () => undefined,
      sessions: () => [],
      closeSession: async () => undefined,
      close: async () => undefined,
    },
    createSession: async (request) => ({ sessionId: 'created-session', cwd: request.cwd }),
  });
  cleanups.push(() => hub.close());
  const listening = await serveHeadlessServer({ headlessHub: hub, port: 0, token: 'contract-test' });
  cleanups.push(() => listening.close());
  return listening;
}

describe('web client against exported API schemas', () => {
  it('validates the real session-create request and server response', async () => {
    const listening = await server();
    const operation = exported.paths['/api/sessions'].post;
    gateway.fetch.mockImplementation(async (target, init) => {
      expect(target).toBe('/api/sessions');
      expect(init?.method).toBe('POST');
      if (typeof target !== 'string' || typeof init?.body !== 'string')
        throw new Error('Expected a JSON client request');
      expect(accepts(operation.requestBody.content['application/json'].schema, JSON.parse(init.body))).toBe(true);
      const headers = new Headers(init.headers);
      headers.set('x-doompi-token', 'contract-test');
      const response = await fetch(new URL(target, listening.url), {
        ...init,
        headers,
      });
      expect(response.status).toBe(201);
      expect(
        accepts(operation.responses[response.status].content['application/json'].schema, await response.clone().json()),
      ).toBe(true);
      return response;
    });
    expect(await createSession({ cwd: process.cwd(), name: 'Contract test' })).toEqual({
      sessionId: 'created-session',
    });
    expect(gateway.fetch).toHaveBeenCalledOnce();
  });

  it('checks a second real client request and a server error against exported responses', async () => {
    const listening = await server();
    gateway.fetch.mockImplementation(async (target, init) => {
      const operation = exported.paths['/api/directories'].get;
      if (typeof target !== 'string') throw new Error('Expected a root-relative client URL');
      const response = await fetch(new URL(target, listening.url), {
        ...init,
        headers: { 'x-doompi-token': 'contract-test' },
      });
      expect(
        accepts(operation.responses[response.status].content['application/json'].schema, await response.clone().json()),
      ).toBe(true);
      return response;
    });
    expect(Array.isArray(await searchDirectories('/does-not-exist/'))).toBe(true);
    const refused = await fetch(new URL('/api/sessions', listening.url));
    expect(refused.status).toBe(401);
    expect(
      accepts(
        exported.paths['/api/sessions'].get.responses['401'].content['application/json'].schema,
        await refused.json(),
      ),
    ).toBe(true);
  });

  it('detects incompatible client payloads and server response changes', () => {
    const operation = exported.paths['/api/sessions'].post;
    expect(accepts(operation.requestBody.content['application/json'].schema, { cwd: 42 })).toBe(false);
    expect(accepts(operation.responses['201'].content['application/json'].schema, { id: 'renamed-field' })).toBe(false);
    expect(accepts(operation.responses['201'].content['application/json'].schema, { sessionId: 42 })).toBe(false);
  });
});
