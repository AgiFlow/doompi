import type { DoomApiScope } from '@agimon-ai/doompi-extension-contracts/package-api';

/** Compatibility filenames for reading explicitly selected pre-descriptor generations only. */
export function apiRoutesFile(scope: DoomApiScope): string {
  return `${scope}.routes.mjs`;
}

export function serverFacetsFile(scope: DoomApiScope): string {
  return `${scope}.facets.mjs`;
}
