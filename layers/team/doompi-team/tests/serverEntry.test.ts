import { expect, it } from 'vitest';

import serverPlugin, { facet as teamServerFacet } from '../generated/server';

it('exposes the server plugin through the loader default export', () => {
  expect(serverPlugin).toBe(teamServerFacet);
  expect(serverPlugin.apply).toBeTypeOf('function');
});
