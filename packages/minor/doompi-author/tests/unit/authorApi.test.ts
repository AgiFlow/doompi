import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDeclaredApi, mountPackageApi } from '@agimon-ai/doompi-extension-contracts/testing';
import { describe, expect, it } from 'vitest';
import { createAuthorApi, api } from '../../src/adapters/authorApi.ts';
import { AUTHOR_DOCUMENT_OPEN_PATH } from '../../src/adapters/authorDocumentApi.ts';
import { API_BASE_PATH, AUTHOR_STATE_PATH, authorStateUrl } from '../../src/types/authorApi.ts';

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

describe('the author API', () => {
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
    expect(authorStateUrl('s/1')).toBe(`/api/plugin/${API_BASE_PATH}${AUTHOR_STATE_PATH}?session=s%2F1`);
  });

  it('serves the route through its declared package mount', async () => {
    const mounted = mountPackageApi(api, { scope: 'session', sessionId: 's1', cwd: '/repo' });
    expect((await mounted.fetch(`/api/plugin/${API_BASE_PATH}${AUTHOR_STATE_PATH}`)).status).toBe(200);
    expect(assertDeclaredApi({ packageRoot: PACKAGE_ROOT, api, scope: 'session' }).basePath).toBe(API_BASE_PATH);
    mounted.close();
  });
});
