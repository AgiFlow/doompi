import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { DOOM_SERVER_HOST_SERVICE, requireDoomServerHost } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { loadHubApis, mountHubApis } from '../../src/adapters/httpServer.ts';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
});

describe('descriptor-backed hub API admission', () => {
  it('routes the same path through two effective selections without importing disabled candidates or legacy routes', async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-hub-descriptor-')));
    cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const entries = ['review', 'build', 'disabled'].map((mode) => {
      fs.writeFileSync(
        path.join(directory, `${mode}.mjs`),
        mode === 'disabled'
          ? 'throw new Error("disabled package imported");'
          : `export default { inject: ['doom/server-host'], apply(context) {
            const host = context.get('doom/server-host');
            const registration = host.registerApi({ basePath: 'same', start(apiContext) {
              return { fetch: () => Response.json({ mode: '${mode}', scope: apiContext.scope, sessionId: apiContext.sessionId }), close() {} };
            }}); return () => registration.dispose();
          }};`,
      );
      return {
        packageName: mode,
        entry: './facet.ts',
        module: `./${mode}.mjs`,
        scopes: ['hub'],
        owners: [{ majorMode: mode, layer: 'core' }],
        required: true,
      };
    });
    const fingerprint = 'b'.repeat(64);
    fs.writeFileSync(
      path.join(directory, 'server.bundle.json'),
      JSON.stringify({ version: 1, generation: 'pinned', fingerprint, entries }),
    );
    fs.writeFileSync(path.join(directory, 'hub.routes.mjs'), 'throw new Error("legacy route imported");');
    const notices: string[] = [];
    const selection = {
      root: directory,
      apiDirectory: directory,
      generation: 'pinned',
      fingerprint,
      majorMode: 'review',
      activeLayers: ['core'],
    };
    const review = await loadHubApis(undefined, undefined, (message) => notices.push(message), selection);
    const build = await loadHubApis(undefined, undefined, (message) => notices.push(message), {
      ...selection,
      majorMode: 'build',
    });
    expect(review.apis).toEqual([]);
    expect(review.key).not.toBe(build.key);
    expect(notices).toEqual([]);
    const app = new Hono();
    const mounted = mountHubApis(
      app,
      [],
      review.facets,
      (message) => notices.push(message),
      () => undefined,
      () => undefined,
      async (sessionId) => (sessionId === 'review' ? review.key : sessionId === 'build' ? build.key : undefined),
      review.key,
    );
    cleanup.push(mounted.close);
    await mounted.ready;
    await mounted.add([], build.facets, build.key);
    expect(await (await app.request('/api/plugin/same/?hubSession=review')).json()).toEqual({
      mode: 'review',
      scope: 'hub',
    });
    expect(await (await app.request('/api/plugin/same/?hubSession=build')).json()).toEqual({
      mode: 'build',
      scope: 'hub',
    });
    expect((await app.request('/api/plugin/same/?hubSession=unknown')).status).toBe(404);
    expect(notices).toEqual([]);
  });

  it('installs one facet once under simultaneous admission and disposes once', async () => {
    const mounted = mountHubApis(
      new Hono(),
      [],
      [],
      () => {},
      () => undefined,
      () => undefined,
    );
    cleanup.push(mounted.close);
    await mounted.ready;
    let installed = 0;
    let disposed = 0;
    const facet = {
      inject: [DOOM_SERVER_HOST_SERVICE],
      apply() {
        installed++;
        return () => {
          disposed++;
        };
      },
    };
    await Promise.all([mounted.add([], [facet], 'same'), mounted.add([], [facet], 'same')]);
    expect(installed).toBe(1);
    await mounted.remove('same');
    expect(disposed).toBe(1);
  });

  it('rejects required readiness and unwinds APIs installed by the failed facet', async () => {
    let closed = 0;
    const mounted = mountHubApis(
      new Hono(),
      [],
      [
        {
          declaration: {
            packageName: 'required',
            entry: './facet.ts',
            module: './facet.mjs',
            scopes: ['hub'],
            owners: [{ majorMode: 'code', layer: 'core' }],
            required: true,
          },
          facet: {
            inject: [DOOM_SERVER_HOST_SERVICE],
            apply(context) {
              requireDoomServerHost(context).registerApi({
                basePath: 'partial',
                start: () => ({
                  fetch: () => new Response('bad'),
                  close: () => {
                    closed++;
                  },
                }),
              });
              throw new Error('required readiness failure');
            },
          },
        },
      ],
      () => {},
      () => undefined,
      () => undefined,
    );
    cleanup.push(mounted.close);
    await expect(mounted.ready).rejects.toThrow(/required/);
    expect(closed).toBe(1);
  });
});
