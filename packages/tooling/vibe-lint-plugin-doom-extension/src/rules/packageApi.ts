import * as fs from 'node:fs';
import * as path from 'node:path';

import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import ts from 'typescript';

import { normalizeEntry, pluginBlocks, readManifest } from './webPlugin.js';

const PACKAGE_MANIFEST_NAME = 'package.json';
const SERVER_ENTRY = './src/extensions/server.ts';
const SERVER_DIST = './dist/extensions/server.mjs';
const SERVER_SCOPES = new Set(['global', 'workspace', 'session']);
const LEGACY_EXPORT_KEYS = new Set([
  './extensions/headless',
  './package-api-loader',
  './server-facet-loader',
  './session-api',
  './sessionApi',
  './hub-api',
  './api/git',
]);
const LEGACY_EXPORT_TARGET_PATTERN = /(?:packageApiLoader|serverFacetLoader|legacyApiFiles|\.routes\.|\.facets\.)/iu;

interface LegacyApiManifest {
  doompiApi?: unknown;
}

interface ServerCompositionManifest {
  doompiServer?: unknown;
  doompiWeb?: unknown;
  pi?: { extensions?: unknown };
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
    'src/extensions/server.ts',
    'src/extensions/headless.ts',
  ].some((relativePath) => hasFile(configRoot, relativePath));
}

function isPureExportFacade(configRoot: string, entry: string): boolean {
  const sourcePath = path.join(configRoot, entry.replace(/^\.\//u, ''));
  if (!fs.existsSync(sourcePath)) return true;
  const source = ts.createSourceFile(sourcePath, fs.readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true);
  return source.statements.length > 0 && source.statements.every((statement) => ts.isExportDeclaration(statement));
}

function canonicalSurfaceViolations(manifest: ServerCompositionManifest, configRoot: string): string[] {
  const violations: string[] = [];
  const exportsMap = isRecord(manifest.exports) ? manifest.exports : {};
  for (const [key, target] of Object.entries(exportsMap)) {
    if (LEGACY_EXPORT_KEYS.has(key) || LEGACY_EXPORT_TARGET_PATTERN.test(JSON.stringify(target))) {
      violations.push(`Remove legacy package export ${key}; only canonical extension surfaces may be host-loaded.`);
    }
  }
  for (const block of pluginBlocks(manifest)) {
    if (block.hub !== undefined) violations.push('Remove doompiWeb.hub; server facets own hub runtime behavior.');
  }

  const entries = new Set<string>();
  if ('./extensions/pi' in exportsMap) {
    entries.add('./src/extensions/pi.ts');
  }
  const server = isRecord(manifest.doompiServer) ? manifest.doompiServer.entry : undefined;
  if (typeof server === 'string') entries.add(server);
  for (const block of pluginBlocks(manifest)) {
    const client = normalizeEntry(block.client);
    if (client) entries.add(client);
  }
  for (const entry of entries) {
    if (entry.startsWith('./src/exports/') && !isPureExportFacade(configRoot, entry)) {
      violations.push(
        `Canonical surface entry ${entry} must contain forwarding exports only; move executable composition into src/extensions.`,
      );
    }
  }
  return violations;
}

function hasDefaultServerExport(configRoot: string, entry: string): boolean {
  const filename = path.join(configRoot, entry);
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  return source.statements.some(
    (statement) =>
      (ts.isExportAssignment(statement) && !statement.isExportEquals) ||
      (ts.isExportDeclaration(statement) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some((element) => element.name.text === 'default')) ||
      (ts.canHaveModifiers(statement) &&
        ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)),
  );
}

function serverCompositionViolations(manifest: ServerCompositionManifest, configRoot: string): string[] {
  const violations: string[] = [];
  const block = manifest.doompiServer;
  if (block === undefined) {
    if (hasServerImplementation(configRoot)) {
      violations.push(
        'server composition implementation requires package.json doompiServer and a canonical src/extensions/server.ts entry',
      );
    }
    return violations;
  }
  if (!isRecord(block)) return ['doompiServer must be an object with entry, dist, and scopes'];

  const entry = typeof block.entry === 'string' ? block.entry : undefined;
  if (entry !== SERVER_ENTRY) {
    violations.push(`doompiServer.entry must be ${SERVER_ENTRY}`);
  } else if (!hasFile(configRoot, entry.slice(2))) {
    violations.push(`doompiServer.entry has no source file: ${entry}`);
  } else if (!hasDefaultServerExport(configRoot, entry)) {
    violations.push('doompiServer.entry must export its defineServerPlugin value as default for the server loader');
  }

  const dist = block.dist;
  if (dist !== SERVER_DIST) {
    violations.push(`doompiServer.dist must be ${SERVER_DIST}`);
  }

  if (!Array.isArray(block.scopes) || block.scopes.length === 0) {
    violations.push('doompiServer.scopes must be a non-empty array containing session and/or hub');
  } else {
    const scopes = block.scopes;
    const invalid = scopes.filter((scope) => typeof scope !== 'string' || !SERVER_SCOPES.has(scope));
    if (invalid.length > 0) violations.push(`doompiServer.scopes contains invalid values: ${invalid.join(', ')}`);
    if (new Set(scopes).size !== scopes.length) violations.push('doompiServer.scopes must not contain duplicates');
  }

  if (entry !== SERVER_ENTRY) return violations;
  const exportKey = './extensions/server';
  const exportsMap = isRecord(manifest.exports) ? manifest.exports : undefined;
  const exported = exportsMap?.[exportKey];
  if (!isRecord(exported)) {
    violations.push(`package.json exports must publish ${exportKey} for doompiServer.entry`);
    return violations;
  }
  const expected = {
    types: './dist/extensions/server.d.mts',
    import: './dist/extensions/server.mjs',
    require: './dist/extensions/server.cjs',
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
  rule: 'Packages expose only canonical Pi, browser-client, and server extension surfaces',
  rationale:
    'Canonical host ownership uses Pi entries, doompiWeb.client, and one DoomServerFacet. Legacy manifests, web-owned hub runtimes, loader exports, headless aliases, and executable entry wrappers preserve competing lifecycle paths.',
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
      ...canonicalSurfaceViolations(manifest, configRoot),
    ];
    return violations.length > 0 ? violations.join(' ') : null;
  },
};
