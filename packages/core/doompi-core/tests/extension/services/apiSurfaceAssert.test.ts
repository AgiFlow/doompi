import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { defineApiContract, type DoomApiContract } from '../../../src/schemas/apiContracts';
import type { DoomApi } from '../../../src/schemas/packageApi';
import { assertContractSurface } from '../../../src/services/apiSurfaceAssert';

const ok = { '200': { description: 'ok' } };

const CONTRACT: DoomApiContract = defineApiContract({
  version: 1,
  dynamic: [],
  sockets: [],
  http: [
    {
      id: 'files.detail',
      scope: 'session',
      basePath: 'file-edits',
      path: '/detail',
      method: 'GET',
      description: 'Read one file.',
      authentication: 'owner',
      responses: ok,
    },
    {
      id: 'files.save',
      scope: 'session',
      basePath: 'file-edits',
      path: '/content',
      method: 'PUT',
      description: 'Save one file.',
      authentication: 'owner',
      responses: ok,
    },
  ],
});

function apiServing(paths: { detail?: boolean; save?: boolean }, basePath = 'file-edits'): DoomApi {
  return {
    basePath,
    start() {
      const app = new Hono();
      if (paths.detail === true) app.get('/detail', (context) => context.json({}));
      if (paths.save === true) app.put('/content', (context) => context.json({}));
      return { fetch: (request) => app.fetch(request), close: () => undefined };
    },
  };
}

const surface = (apis: readonly DoomApi[]) =>
  assertContractSurface({ contract: CONTRACT, scope: 'session', apis, mount: { sessionId: 's-1' } });

describe('assertContractSurface', () => {
  it('passes when every declared route is mounted and answers', async () => {
    await expect(surface([apiServing({ detail: true, save: true })])).resolves.toBeUndefined();
  });

  /**
   * The defect this exists for: a valid contract, a working Hono app, and a
   * facet that registered nothing.
   */
  it('catches a contract whose API is never mounted at all', async () => {
    await expect(surface([])).rejects.toThrow(/declares file-edits at session scope, but nothing is mounted there/u);
  });

  it('catches an API mounted at a scope the contract never declares', async () => {
    await expect(surface([apiServing({ detail: true, save: true }), apiServing({}, 'stowaway')])).rejects.toThrow(
      /stowaway is mounted at session scope but the contract never declares it there/u,
    );
  });

  it('catches a declared route that no handler serves', async () => {
    await expect(surface([apiServing({ detail: true })])).rejects.toThrow(/declared as 'files.save' but answered 404/u);
  });

  it('accepts a route that refuses, because liveness is not correctness', async () => {
    const refusing: DoomApi = {
      basePath: 'file-edits',
      start() {
        const app = new Hono();
        app.get('/detail', (context) => context.json({ error: 'nope' }, 403));
        app.put('/content', (context) => context.json({ error: 'boom' }, 500));
        return { fetch: (request) => app.fetch(request), close: () => undefined };
      },
    };
    await expect(surface([refusing])).resolves.toBeUndefined();
  });

  it('ignores host-owned routes, which the package does not mount', async () => {
    const withHostRoute: DoomApiContract = defineApiContract({
      ...CONTRACT,
      http: [
        ...CONTRACT.http,
        {
          id: 'host.file',
          scope: 'session',
          path: '/file',
          method: 'GET',
          description: 'Host bytes route.',
          authentication: 'owner',
          responses: ok,
        },
      ],
    });
    await expect(
      assertContractSurface({
        contract: withHostRoute,
        scope: 'session',
        apis: [apiServing({ detail: true, save: true })],
        mount: { sessionId: 's-1' },
      }),
    ).resolves.toBeUndefined();
  });
});
