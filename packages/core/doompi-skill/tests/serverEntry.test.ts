import { expect, it } from 'vitest';

import serverPlugin, { facet as skillServerFacet } from '../generated/server';

it('exposes the server plugin through the loader default export', () => {
  expect(serverPlugin).toBe(skillServerFacet);
  expect(serverPlugin.apply).toBeTypeOf('function');
});
