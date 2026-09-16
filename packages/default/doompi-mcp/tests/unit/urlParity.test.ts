import { describe, expect, it } from 'vitest';

import { api } from '../../generated/client';

/**
 * Pins every URL this package sends, as a literal string.
 *
 * These are the shapes the deleted `apiRoot` builder produced: the panel is the
 * first caller of the workspace scope, so nothing else had ever compared the
 * client's idea of that mount with the one the cockpit has been addressing.
 * Keeping them literal is the point: a mistyped mount is not reported by the
 * route it misses, because the service worker answers any unrecognised path out
 * of the signed bundle cache, and the panel reads the SPA shell it gets back as
 * a failed catalog rather than a wrong URL.
 */

const REPOSITORY_ID = `repo-${'a'.repeat(24)}`;
const FLOW_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MOUNT = `/api/workspaces/${REPOSITORY_ID}/plugins/mcp`;
const scoped = api.workspace(REPOSITORY_ID);

describe('the URLs this package sends', () => {
  it('reads the repository catalog', () => {
    expect(scoped.catalog.url({ query: { repositoryId: REPOSITORY_ID } })).toBe(
      `${MOUNT}/repository?repositoryId=${REPOSITORY_ID}`,
    );
  });

  it('posts discovery and authorization to the collection, with no query', () => {
    expect(scoped.discover.url()).toBe(`${MOUNT}/repository/discover`);
    expect(scoped.authorize.url()).toBe(`${MOUNT}/repository/authorize`);
    expect(scoped.discover.spec.method).toBe('POST');
    expect(scoped.authorize.spec.method).toBe('POST');
  });

  it('addresses one flow by id, which the two flow routes share', () => {
    const url = `${MOUNT}/repository/authorize/${FLOW_ID}?repositoryId=${REPOSITORY_ID}`;
    const init = { params: { flowId: FLOW_ID }, query: { repositoryId: REPOSITORY_ID } };
    expect(scoped.readAuthorization.url(init)).toBe(url);
    expect(scoped.cancelAuthorization.url(init)).toBe(url);
    expect(scoped.readAuthorization.spec.method).toBe('GET');
    expect(scoped.cancelAuthorization.spec.method).toBe('DELETE');
  });

  it('encodes a flow id into one segment rather than letting it invent another', () => {
    expect(scoped.readAuthorization.url({ params: { flowId: 'a/b' } })).toBe(`${MOUNT}/repository/authorize/a%2Fb`);
  });

  it('stays root-relative, which is the only form the sealed relay forwards', () => {
    for (const url of [scoped.catalog.url(), scoped.discover.url()]) {
      expect(url.startsWith('/api/')).toBe(true);
      expect(url.startsWith('//')).toBe(false);
    }
  });
});
