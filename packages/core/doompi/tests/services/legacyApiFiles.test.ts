import { describe, expect, it } from 'vitest';
import { apiRoutesFile, serverFacetsFile } from '../../src/services/legacyApiFiles';

describe('explicit legacy generation filenames', () => {
  it.each(['session', 'hub'] as const)('retains %s artifact names for old-generation readers', (scope) => {
    expect(apiRoutesFile(scope)).toBe(`${scope}.routes.mjs`);
    expect(serverFacetsFile(scope)).toBe(`${scope}.facets.mjs`);
  });
});
