import { expect, it } from 'vitest';
import serverPlugin, { teamServerFacet } from '../src/extensions/server';

it('exposes the server plugin through the loader default export', () => {
  expect(serverPlugin).toBe(teamServerFacet);
  expect(serverPlugin.apply).toBeTypeOf('function');
});
