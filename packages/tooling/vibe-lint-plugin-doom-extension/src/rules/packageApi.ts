import * as path from 'node:path';
import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import { readManifest } from './webPlugin.js';

const PACKAGE_MANIFEST_NAME = 'package.json';

interface LegacyApiManifest {
  doompiApi?: unknown;
}

/**
 * HTTP APIs are mounted through a DoomServerFacet. Keep the old manifest field
 * rejected so repository-owned packages cannot author a second, unmanaged path.
 */
export const packageApiManifest: RuleDefinition = {
  preflight: true,
  rule: 'HTTP APIs use a DoomServerFacet instead of the legacy doompiApi manifest field',
  rationale:
    'A DoomServerFacet registers the package DoomApi through the host lifecycle and is declared once under doompiServer. The legacy doompiApi field names separate entries without a facet or disposer, so accepting it would keep teaching an unmanaged API path.',
  check(filePath, configRoot) {
    if (path.basename(filePath) !== PACKAGE_MANIFEST_NAME) return null;
    const manifest = readManifest(configRoot) as LegacyApiManifest | null;
    return manifest?.doompiApi === undefined
      ? null
      : 'Remove the legacy doompiApi manifest declaration and register the API through a DoomServerFacet under doompiServer.';
  },
};
