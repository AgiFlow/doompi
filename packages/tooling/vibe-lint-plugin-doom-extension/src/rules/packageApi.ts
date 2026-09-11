import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import { readManifest } from './webPlugin.js';

const PACKAGE_MANIFEST_NAME = 'package.json';
const SERVER_ENTRY_PATTERN = /^\.\/src\/exports\/extensions\/(server|headless)\.ts$/u;
const SERVER_DIST_PATTERN = /^\.\/dist\/extensions\/(server|headless)\.mjs$/u;
const SERVER_SCOPES = new Set(['session', 'hub']);

interface LegacyApiManifest {
  doompiApi?: unknown;
}

interface ServerCompositionManifest {
  doompiServer?: unknown;
  exports?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasFile(configRoot: string, relativePath: string): boolean {
  return fs.existsSync(path.join(configRoot, relativePath));
}

function hasServerImplementation(configRoot: string): boolean {
  return [
    'src/adapters/server',
    'src/adapters/headless',
    'src/exports/extensions/server.ts',
    'src/exports/extensions/headless.ts',
    'src/extensions/server.ts',
    'src/extensions/headless.ts',
    'src/exports/sessionApi.ts',
  ].some((relativePath) => hasFile(configRoot, relativePath));
}

function serverEntryKind(entry: unknown): 'server' | 'headless' | null {
  const match = typeof entry === 'string' ? SERVER_ENTRY_PATTERN.exec(entry) : null;
  return match?.[1] === 'server' || match?.[1] === 'headless' ? match[1] : null;
}

function serverCompositionViolations(manifest: ServerCompositionManifest, configRoot: string): string[] {
  const violations: string[] = [];
  const block = manifest.doompiServer;
  if (block === undefined) {
    if (hasServerImplementation(configRoot)) {
      violations.push(
        'server composition implementation requires package.json doompiServer and a canonical src/exports/extensions entry',
      );
    }
    return violations;
  }
  if (!isRecord(block)) return ['doompiServer must be an object with entry, dist, and scopes'];

  const entry = typeof block.entry === 'string' ? block.entry : undefined;
  const kind = serverEntryKind(entry);
  if (kind === null) {
    violations.push(
      'doompiServer.entry must be ./src/exports/extensions/server.ts or ./src/exports/extensions/headless.ts',
    );
  } else if (entry !== undefined && !hasFile(configRoot, entry.slice(2))) {
    violations.push(`doompiServer.entry has no source file: ${entry}`);
  }

  const dist = block.dist;
  if (
    typeof dist !== 'string' ||
    !SERVER_DIST_PATTERN.test(dist) ||
    (kind !== null && !dist.includes(`/${kind}.mjs`))
  ) {
    violations.push('doompiServer.dist must match its canonical server or headless entry under ./dist/extensions');
  }

  if (!Array.isArray(block.scopes) || block.scopes.length === 0) {
    violations.push('doompiServer.scopes must be a non-empty array containing session and/or hub');
  } else {
    const scopes = block.scopes;
    const invalid = scopes.filter((scope) => typeof scope !== 'string' || !SERVER_SCOPES.has(scope));
    if (invalid.length > 0) violations.push(`doompiServer.scopes contains invalid values: ${invalid.join(', ')}`);
    if (new Set(scopes).size !== scopes.length) violations.push('doompiServer.scopes must not contain duplicates');
  }

  if (kind === null) return violations;
  const exportKey = `./extensions/${kind}`;
  const exportsMap = isRecord(manifest.exports) ? manifest.exports : undefined;
  const exported = exportsMap?.[exportKey];
  if (!isRecord(exported)) {
    violations.push(`package.json exports must publish ${exportKey} for doompiServer.entry`);
    return violations;
  }
  const expected = {
    types: `./dist/extensions/${kind}.d.mts`,
    import: `./dist/extensions/${kind}.mjs`,
    require: `./dist/extensions/${kind}.cjs`,
  };
  for (const [condition, target] of Object.entries(expected)) {
    if (exported[condition] !== target) {
      violations.push(`package.json exports ${exportKey}.${condition} must be ${target}`);
    }
  }

  return violations;
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
    const manifest = readManifest(configRoot) as (LegacyApiManifest & ServerCompositionManifest) | null;
    if (!manifest) return null;
    const violations = [
      ...(manifest.doompiApi === undefined
        ? []
        : [
            'Remove the legacy doompiApi manifest declaration and register the API through a DoomServerFacet under doompiServer.',
          ]),
      ...serverCompositionViolations(manifest, configRoot),
    ];
    return violations.length > 0 ? violations.join(' ') : null;
  },
};
