import fs from 'node:fs';
import path from 'node:path';

import { GENERATED_DIR } from '../../constants/layout';
import type { ExtensionGraph, ExtensionScope } from '../../types/extensionGraph';
import { toSnake } from '../identity';
import type { BuildTarget } from '../resolveTarget/type';
import type { ManifestSync } from './type';

const SCOPE_ORDER: readonly ExtensionScope[] = ['global', 'workspace', 'session'];

const API_CONTRACTS_SOURCE = 'src/exports/apiContracts.ts';
const API_CONTRACTS_DIST = './dist/api-contracts.mjs';

const PI_EXPORT = './extensions/pi';
const PI_TYPES = './dist/extensions/pi.d.mts';
const PI_IMPORT = './dist/extensions/pi.mjs';
const PI_REQUIRE = './dist/extensions/pi.cjs';
const WEB_EXPORT = './extensions/web';
const WEB_DIST = './dist/extensions/web.mjs';
const MCP_DIST = './dist/extensions/mcp.mjs';
const MCP_ENTRY = `./${GENERATED_DIR}/mcp.ts`;

/**
 * Which scopes a server facet declares.
 *
 * The generated facet cascades: a contribution declared at global registers at
 * global, workspace and session alike, because the server reads exactly one
 * scope declaration and nothing above it. So the declared set runs from the
 * shallowest contribution downward.
 */
function serverScopes(graph: ExtensionGraph): ExtensionScope[] {
  const declared = graph.entries.filter((entry) => entry.side === 'backend');
  if (declared.length === 0) return [];
  const shallowest = Math.min(...declared.map((entry) => SCOPE_ORDER.indexOf(entry.scope)));
  return SCOPE_ORDER.slice(shallowest);
}

/**
 * Which scopes a cockpit plugin declares.
 *
 * The cockpit does not cascade the way the server does. It merges the scopes
 * it is given, so a plugin declares exactly the ones it contributes to.
 */
function webScopes(graph: ExtensionGraph): ExtensionScope[] {
  const declared = new Set(graph.entries.filter((entry) => entry.side === 'frontend').map((entry) => entry.scope));
  return SCOPE_ORDER.filter((scope) => declared.has(scope));
}

/** The frame types the browser half claims, which the cockpit reads before loading it. */
function channels(graph: ExtensionGraph, _manifest: Record<string, unknown>): string[] {
  return [
    ...new Set(
      graph.entries
        .filter((entry) => entry.side === 'frontend' && entry.surface === 'channel')
        .map((entry) => toSnake(entry.name)),
    ),
  ].sort();
}

/**
 * Restores the `types` condition tsdown's exports generation omits.
 *
 * tsdown derives the map from the built chunks, which is what makes it follow
 * the folder tree. But its `genSubExport` only ever emits `import`, `require`
 * or `default`: a declaration chunk contributes nothing to a subpath, so only
 * the root gets a top-level `types`. TypeScript still resolves a sibling
 * `.d.mts` under node16 and bundler resolution, but publint and attw read the
 * condition, so it belongs in the map.
 */
function withTypeConditions(packageDir: string, exportsMap: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [subpath, target] of Object.entries(exportsMap)) {
    if (subpath === './package.json' || target === null || typeof target !== 'object') {
      next[subpath] = target;
      continue;
    }
    const conditions = target as Record<string, string>;
    const esm = conditions.import ?? conditions.default;
    const types = esm?.endsWith('.mjs') === true ? `${esm.slice(0, -'.mjs'.length)}.d.mts` : undefined;
    // Ahead of import and require: a resolver takes the first condition it
    // matches, so a types-aware one must not fall through to the runtime file.
    next[subpath] =
      conditions.types === undefined && types !== undefined && fs.existsSync(path.join(packageDir, types))
        ? { types, ...conditions }
        : conditions;
  }
  return next;
}

/**
 * Everything the manifest can say about a package that its tree already says.
 *
 * The three host blocks are pure restatements of the folder tree: which hosts
 * the package contributes to, at which scopes, and which frame types the
 * browser claims. Leaving them hand-written is what made a package declare the
 * same thing in six places, so the build writes them.
 *
 * Returns the manifest rather than writing it, so a caller can diff it and a
 * test can read it without a filesystem.
 */
export function syncManifest(input: ManifestSync): Record<string, unknown> {
  const { packageDir, graph, targets, pluginId } = input;
  const manifest = { ...input.manifest };

  if (manifest.exports !== undefined && typeof manifest.exports === 'object') {
    const exportsMap = withTypeConditions(packageDir, manifest.exports as Record<string, unknown>);
    // The browser bundle is a real entry point now that it is built rather
    // than shipped as source, so it is exported like the other two. Import
    // only: its own config emits ESM and no declarations, because nothing
    // imports it as a typed module.
    //
    // Added from the target rather than from the file existing, because this
    // runs on the node build's build:done and the browser build follows it.
    if (targets.includes('cli')) {
      exportsMap[PI_EXPORT] = { types: PI_TYPES, import: PI_IMPORT, require: PI_REQUIRE };
    } else delete exportsMap[PI_EXPORT];
    if (targets.includes('web')) exportsMap[WEB_EXPORT] = { import: WEB_DIST };
    else delete exportsMap[WEB_EXPORT];
    manifest.exports = Object.fromEntries(
      Object.entries(exportsMap).sort(([left], [right]) =>
        left === './package.json' ? 1 : right === './package.json' ? -1 : left.localeCompare(right),
      ),
    );
  }

  if (targets.includes('cli')) manifest.pi = { extensions: ['./dist/extensions/pi.mjs'] };
  else delete manifest.pi;

  if (targets.includes('server')) {
    const contracts = fs.existsSync(path.join(packageDir, API_CONTRACTS_SOURCE))
      ? { contracts: { entry: `./${API_CONTRACTS_SOURCE}`, dist: API_CONTRACTS_DIST } }
      : {};
    manifest.doompiServer = {
      entry: `./${GENERATED_DIR}/server.ts`,
      dist: './dist/extensions/server.mjs',
      scopes: serverScopes(graph),
      ...contracts,
    };
  } else delete manifest.doompiServer;

  if (targets.includes('web')) {
    manifest.doompiWeb = {
      pluginId,
      channels: channels(graph, manifest),
      // The built browser bundle, not the source. Its own tsdown config
      // targets a browser and leaves every bare specifier external, so the
      // cockpit resolves one React rather than bundling a copy per plugin.
      client: WEB_DIST,
      scopes: webScopes(graph),
    };
  } else delete manifest.doompiWeb;

  return manifest;
}

/** Updates only the MCP-owned manifest block, leaving normal build metadata untouched. */
export function syncMcpManifest(manifest: Record<string, unknown>, enabled: boolean): Record<string, unknown> {
  const next = { ...manifest };
  if (enabled) next.doompiMcp = { entry: MCP_ENTRY, dist: MCP_DIST, scopes: ['session'] };
  else delete next.doompiMcp;
  return next;
}

/** Writes the synced manifest when it differs, so a second build is a no-op. */
export function writeManifest(input: ManifestSync & { readonly targets: readonly BuildTarget[] }): boolean {
  const manifestPath = path.join(input.packageDir, 'package.json');
  const next = `${JSON.stringify(syncManifest(input), null, 2)}\n`;
  if (fs.readFileSync(manifestPath, 'utf8') === next) return false;
  fs.writeFileSync(manifestPath, next);
  return true;
}

/** Writes only MCP metadata after an isolated build. */
export function writeMcpManifest(packageDir: string, enabled: boolean): boolean {
  const manifestPath = path.join(packageDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const next = `${JSON.stringify(syncMcpManifest(manifest, enabled), null, 2)}\n`;
  if (fs.readFileSync(manifestPath, 'utf8') === next) return false;
  fs.writeFileSync(manifestPath, next);
  return true;
}
