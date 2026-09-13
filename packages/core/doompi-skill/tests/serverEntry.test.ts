import { expect, it } from 'vitest';

import serverPlugin, { skillServerFacet } from '../src/extensions/server';

it('exposes the server plugin through the loader default export', () => {
  expect(serverPlugin).toBe(skillServerFacet);
  expect(serverPlugin.apply).toBeTypeOf('function');
});
