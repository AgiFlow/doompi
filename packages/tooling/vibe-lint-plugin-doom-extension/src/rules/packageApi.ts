import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import ts from 'typescript';
import { isPublished, normalizeEntry, readManifest, readSource, stripDot } from './webPlugin.js';

/**
 * The HTTP API a package offers its host, declared in package.json under
 * `doompiApi`.
 *
 * The block is what `doompi sync` discovers and what a session server or the
 * cockpit hub imports at startup, from the built entry the package publishes.
 * Nothing checks it at install time, so a wrong path or a missing export first
 * shows up as a notice on a user's machine after publishing. These rules move
 * that to the editor.
 */

const PACKAGE_MANIFEST_NAME = 'package.json';
const API_MANIFEST_FIELD = 'doompiApi';
const API_SCOPES = ['session', 'hub'] as const;
const API_EXPORT = 'api';
const BASE_PATH_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

type ApiScope = (typeof API_SCOPES)[number];

interface ApiBlock {
  basePath?: unknown;
  session?: unknown;
  hub?: unknown;
}

interface ApiManifest {
  files?: unknown;
  doompiApi?: unknown;
}

/** The declared blocks, normalized to a list; a package may declare one or several. */
function apiBlocks(manifest: ApiManifest): ApiBlock[] {
  if (manifest.doompiApi === undefined) return [];
  const blocks = Array.isArray(manifest.doompiApi) ? manifest.doompiApi : [manifest.doompiApi];
  return blocks.filter((block): block is ApiBlock => typeof block === 'object' && block !== null);
}

function distOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const dist = (value as { dist?: unknown }).dist;
  return typeof dist === 'string' ? dist : null;
}

export const packageApiManifest: RuleDefinition = {
  preflight: true,
  rule: 'A doompiApi block names a kebab-case base path and, per scope it offers, an existing entry and a published built entry',
  rationale:
    'doompi sync generates the route modules from this block and a host imports the built entry it names, from the installed package. A path that does not exist, or a dist the files allowlist does not publish, produces a package that looks fine in the repository and mounts nothing on a user machine. Checking the block against the files it names catches that before the package leaves the repository.',
  check(filePath, configRoot) {
    if (path.basename(filePath) !== PACKAGE_MANIFEST_NAME) return null;
    const manifest = readManifest(configRoot) as ApiManifest | null;
    if (!manifest || manifest.doompiApi === undefined) return null;
    const files = Array.isArray(manifest.files) ? manifest.files.filter((entry) => typeof entry === 'string') : [];
    const problems: string[] = [];

    for (const block of apiBlocks(manifest)) {
      const basePath = typeof block.basePath === 'string' ? block.basePath : String(block.basePath);
      if (typeof block.basePath !== 'string' || !BASE_PATH_PATTERN.test(block.basePath)) {
        problems.push(`basePath '${basePath}' must be kebab-case`);
      }
      const declared = API_SCOPES.filter((scope) => block[scope] !== undefined);
      if (declared.length === 0) {
        problems.push(`'${basePath}' names neither a session nor a hub entry, so no host could mount it`);
      }
      for (const scope of declared) {
        const entry = normalizeEntry(block[scope]);
        if (entry === null || !entry.startsWith('./') || entry.includes('..')) {
          problems.push(`'${basePath}' ${scope}.entry must be a package-relative ./path`);
        } else if (!fs.existsSync(path.join(configRoot, entry))) {
          problems.push(`'${basePath}' ${scope}.entry '${entry}' does not exist`);
        }
        const dist = distOf(block[scope]);
        if (dist === null || !dist.startsWith('./') || dist.includes('..')) {
          problems.push(`'${basePath}' ${scope}.dist must be the package-relative ./path of the built entry`);
          continue;
        }
        if (!isPublished(files, stripDot(dist))) {
          problems.push(`'${basePath}' ${scope}.dist '${dist}' is not in the files allowlist`);
        }
      }
    }
    return problems.length > 0 ? `${API_MANIFEST_FIELD} manifest: ${problems.join('; ')}.` : null;
  },
};

/** Whether the file exports a const named `api`. */
function exportsApi(sourceFile: ts.SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      if (statement.exportClause.elements.some((element) => element.name.text === API_EXPORT)) return true;
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (exported !== true) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === API_EXPORT) return true;
    }
  }
  return false;
}

/** The scope a declared entry belongs to, or null when this file is not one. */
function declaredScopeOf(manifest: ApiManifest, relativePath: string): ApiScope | null {
  for (const block of apiBlocks(manifest)) {
    for (const scope of API_SCOPES) {
      const entry = normalizeEntry(block[scope]);
      if (entry !== null && stripDot(entry) === relativePath) return scope;
    }
  }
  return null;
}

export const packageApiEntry: RuleDefinition = {
  preflight: true,
  rule: 'A doompiApi entry exports `api`, the name every host imports it by',
  rationale:
    'The generated route module imports { api } from each declared entry by name, and a host narrows what it finds before mounting it. An entry that exports something else is dropped with a notice at startup rather than failing where it was written, and the package silently serves nothing.',
  check(filePath, configRoot) {
    const relativePath = path.relative(configRoot, filePath).split(path.sep).join('/');
    if (relativePath.startsWith('..')) return null;
    const manifest = readManifest(configRoot) as ApiManifest | null;
    if (!manifest || manifest.doompiApi === undefined) return null;
    const scope = declaredScopeOf(manifest, relativePath);
    if (scope === null) return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile || exportsApi(sourceFile)) return null;
    return `The doompiApi ${scope} entry must export ${API_EXPORT}; the generated route module imports { ${API_EXPORT} } from it.`;
  },
};
