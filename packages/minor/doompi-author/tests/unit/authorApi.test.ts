import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDeclaredApi, mountPackageApi } from '@agimon-ai/doompi-extension-contracts/testing';
import { describe, expect, it } from 'vitest';
import { api, createAuthorApi } from '../../src/adapters/authorApi.ts';
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
