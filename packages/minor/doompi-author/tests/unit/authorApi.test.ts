import { bindSessionApiWorkspace } from '@agimon-ai/doompi-core/web';
import { beforeEach as beforeEachApiRoutes } from 'vitest';
beforeEachApiRoutes(() => bindSessionApiWorkspace(() => 'test-workspace'));
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mountPackageApi } from '@agimon-ai/doompi-core/testing';
import { describe, expect, it } from 'vitest';

import {
  createAuthorApi,
  createAuthorSessionApi,
  api,
} from '../../src/extensions/workspaces/sessions/(backend)/api/_lib/authorApi';
import { AUTHOR_DOCUMENT_OPEN_PATH } from '../../src/extensions/workspaces/sessions/(backend)/api/_lib/authorDocumentApi';
import { API_BASE_PATH, AUTHOR_STATE_PATH, authorStateUrl } from '../../src/types/authorApi';

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

describe('the author API', () => {
  it('shares browser registration between the REST API and the tool catalog', async () => {
    const session = createAuthorSessionApi(PACKAGE_ROOT, 's1');
    const mounted = mountPackageApi(session.api, { scope: 'session', sessionId: 's1', cwd: PACKAGE_ROOT });
    const post = (route: string, value: unknown) =>
      mounted.fetch(`/api/plugins/author/bridge/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
    try {
      const registered = (await (await post('register', { bindingId: 'browser', generation: 1 })).json()) as {
        ownerToken: string;
      };
      await post('catalog', {
        bindingId: 'browser',
        generation: 1,
        ownerToken: registered.ownerToken,
        tools: [
          { name: 'inspect', label: 'Inspect', description: 'Read the document', inputSchema: { type: 'object' } },
        ],
      });
      const catalog = await session.catalog.describe();
      expect(catalog.tools.map((tool) => tool.name)).toEqual(['inspect']);
      expect(catalog.catalogToken).toEqual(expect.any(String));
      expect(await session.catalog.open('README.md')).toMatchObject({
        path: 'README.md',
        byteLength: expect.any(Number),
      });
      await expect(session.catalog.open('../package.json')).rejects.toThrow('outside');
    } finally {
      mounted.close();
    }
  });
  it('returns a trusted session state view', async () => {
    const response = await createAuthorApi({
      sessionId: 's1',
      readState: () => ({ activation: 'active', capabilityCount: 2 }),
    }).fetch(new Request(`http://host${AUTHOR_STATE_PATH}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionId: 's1', activation: 'active', capabilityCount: 2 });
  });

  it('validates a relative document path through the open API without writing it', async () => {
    const response = await createAuthorApi({ cwd: PACKAGE_ROOT }).fetch(
      new Request(`http://host${AUTHOR_DOCUMENT_OPEN_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'README.md' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ path: 'README.md', byteLength: expect.any(Number) });
  });

  it('rejects paths that escape cwd and leaves the requested document unchanged', async () => {
    const documentPath = path.join(PACKAGE_ROOT, 'README.md');
    const before = await fs.readFile(documentPath);
    const response = await createAuthorApi({ cwd: PACKAGE_ROOT }).fetch(
      new Request(`http://host${AUTHOR_DOCUMENT_OPEN_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '../package.json' }),
      }),
    );

    expect(response.status).toBe(403);
    expect(await fs.readFile(documentPath)).toEqual(before);
  });
  it('builds the hub proxy URL with one session query', () => {
    expect(authorStateUrl('s/1')).toBe(
      `/api/workspaces/test-workspace/sessions/s%2F1/plugins/${API_BASE_PATH}${AUTHOR_STATE_PATH}?session=s%2F1`,
    );
  });

  it('serves the route through its declared package mount', async () => {
    const mounted = mountPackageApi(api, { scope: 'session', sessionId: 's1', cwd: '/repo' });
    expect((await mounted.fetch(`/api/plugins/${API_BASE_PATH}${AUTHOR_STATE_PATH}`)).status).toBe(200);
    mounted.close();
  });
});
