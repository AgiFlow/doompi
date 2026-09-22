import fs from 'node:fs';
import path from 'node:path';

import { GENERATED_DIR } from '../../constants/layout';
import { generateExtension } from '../generate';
import type { GenerateOptions } from '../generate/type';
import { toKebab } from '../identity';
import { writeManifest, writeMcpManifest } from '../syncManifest';

interface EmittedFile {
  readonly type: 'asset' | 'chunk';
  readonly id?: string;
  readonly name: string;
  readonly source?: Buffer;
}

interface QueryAssetPlugin {
  readonly name: string;
  resolveId(source: string, importer: string | undefined): string | undefined;
  load(this: { emitFile(file: EmittedFile): string }, id: string): string | undefined;
}

/** The shape a tsdown config needs from this preset, without importing tsdown's types. */
interface BrowserPresetConfig {
  entry: Record<string, string>;
  clean: boolean;
  dts: false;
  exports: boolean;
  format: 'esm'[];
  platform: 'browser';
  fixedExtension: boolean;
  external: (id: string) => boolean;
  plugins: QueryAssetPlugin[];
  sourcemap: boolean;
  unbundle: boolean;
}

interface BasePresetConfig {
  entry: Record<string, string>;
  clean: boolean;
  dts: false | { incremental: boolean; parallel: boolean; eager: boolean };
  write?: false;
  plugins?: QueryAssetPlugin[];
  exports: boolean;
  format: ('esm' | 'cjs')[];
  platform: 'node';
  sourcemap: boolean;
  unbundle: boolean;
  outExtensions: ({ format }: { format: string }) => {
    js: string;
    dts: string;
  };
}

interface PresetConfig extends BasePresetConfig {
  hooks?: { 'build:done': () => void };
}

const DEFAULT_EXPORTS_DIR = 'src/exports';

/** `src/exports/apiContracts.ts` becomes the `api-contracts` entry; index keeps its name. */
function exportEntries(packageDir: string, exportsDir: string): Record<string, string> {
  const absolute = path.join(packageDir, exportsDir);
  if (!fs.existsSync(absolute)) return {};
  const entries: Record<string, string> = {};
  for (const file of fs.readdirSync(absolute)) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    const stem = file.slice(0, -'.ts'.length);
    entries[stem === 'index' ? 'index' : toKebab(stem)] = `${exportsDir}/${file}`;
  }
  return entries;
}

/**
 * One tsdown config for a folder-routed extension.
 *
 * Entries come from the tree rather than a hand-written list, and the manifest
 * blocks that restate the tree are written after the build rather than kept in
 * step by hand. Browser contributions are emitted through a second bundled
 * config because their routed source is not published.
 */
export interface ExtensionPresetOptions extends GenerateOptions {
  /** Extra tsdown entries beyond the derived ones. */
  readonly entry?: Record<string, string>;
  /** Public export modules, package-relative. Defaults to `src/exports`. */
  readonly exportsDir?: string;
}

/**
 * Implements the Vite query imports extension browser code already uses.
 *
 * `?url` copies an opaque asset and `?worker&url` emits a separately bundled
 * worker chunk. Rolldown then replaces its file reference with an URL relative
 * to the extension bundle, which remains valid when the cockpit composes it.
 */
function queryAssetPlugin(): QueryAssetPlugin {
  return {
    name: 'doompi-query-assets',
    resolveId(source, importer) {
      const queryAt = source.indexOf('?');
      if (queryAt < 0 || importer === undefined || !source.startsWith('.')) return undefined;
      const importerFile = importer.split('?')[0] as string;
      return `${path.resolve(path.dirname(importerFile), source.slice(0, queryAt))}${source.slice(queryAt)}`;
    },
    load(id) {
      const queryAt = id.indexOf('?');
      if (queryAt < 0) return undefined;
      const file = id.slice(0, queryAt);
      const query = new URLSearchParams(id.slice(queryAt + 1));
      if (!query.has('url')) return undefined;
      const worker = query.has('worker');
      const reference = this.emitFile(
        worker
          ? { type: 'chunk', id: file, name: path.basename(file, path.extname(file)) }
          : { type: 'asset', name: path.basename(file), source: fs.readFileSync(file) },
      );
      return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
    },
  };
}

/** The separately bundled browser half of a routed extension. */
function browserConfig(): BrowserPresetConfig {
  return {
    entry: { 'extensions/web': `${GENERATED_DIR}/web.ts` },
    clean: false,
    // No declarations. Nothing imports this as a typed module: it has no
    // export subpath, and the cockpit consumes it as a bundle. The browser
    // half is still typechecked, by tsconfig.web.json in the typecheck script.
    dts: false,
    exports: false,
    format: ['esm'],
    platform: 'browser',
    // platform browser turns tsdown's fixedExtension off, which would emit
    // .js. The manifest names .mjs like the other two entries, so ask for it.
    fixedExtension: true,
    // Every bare specifier stays external and the cockpit resolves it, which
    // is what keeps one React and one store in the page no matter how many
    // plugins are installed. An allowlist would have to be kept in step with
    // the cockpit's; this cannot drift.
    //
    // A predicate rather than a pattern: rolldown tests `external` against the
    // resolved id, so /^[^.]/ also matches the absolute path of this package's
    // own routed file and would leave a dangling import to unbuilt .tsx.
    external: (id: string) => !id.startsWith('.') && !path.isAbsolute(id),
    plugins: [queryAssetPlugin()],
    sourcemap: true,
    // Bundled, unlike the node half. Unbundling would emit an import to the
    // routed source file, which is not published and is .tsx besides. One
    // module with only bare specifiers external is what the cockpit wants.
    unbundle: false,
  };
}

/** Removes only filenames owned by the isolated MCP build, including obsolete declarations. */
function cleanMcpOutput(packageDir: string): void {
  const dist = path.join(packageDir, 'dist');
  if (!fs.existsSync(dist)) return;
  for (const relative of fs.readdirSync(dist, { recursive: true, encoding: 'utf8' })) {
    const normalized = relative.split(path.sep).join('/');
    if (!/^(?:extensions\/mcp|.+\.mcp)\.(?:mjs|cjs|d\.mts|d\.cts)(?:\.map)?$/u.test(normalized)) continue;
    const absolute = path.join(dist, relative);
    if (fs.lstatSync(absolute).isFile()) fs.rmSync(absolute);
  }
}

export function doompiExtension(
  options: ExtensionPresetOptions = { packageDir: process.cwd() },
): PresetConfig | (PresetConfig | BrowserPresetConfig)[] {
  const packageDir = options.packageDir ?? process.cwd();
  const result = generateExtension({ ...options, packageDir, check: options.check ?? false });

  for (const notice of result.notices) process.stderr.write(`[doompi-build] ${notice.path}: ${notice.message}\n`);

  const mcpOnly = options.target === 'mcp';
  if (mcpOnly && !options.check) cleanMcpOutput(packageDir);
  const emptyMcp = mcpOnly && !result.targets.includes('mcp');
  const emptyEntry = '\0doompi-empty-mcp';
  if (emptyMcp && !options.check) writeMcpManifest(packageDir, false);
  const entry: Record<string, string> = mcpOnly
    ? result.targets.includes('mcp')
      ? { 'extensions/mcp': `${GENERATED_DIR}/mcp.ts` }
      : { 'extensions/mcp': emptyEntry }
    : {
        ...exportEntries(packageDir, options.exportsDir ?? DEFAULT_EXPORTS_DIR),
        ...(result.targets.includes('cli') ? { 'extensions/pi': `${GENERATED_DIR}/pi.ts` } : {}),
        ...(result.targets.includes('server') ? { 'extensions/server': `${GENERATED_DIR}/server.ts` } : {}),
        ...options.entry,
      };

  const baseNode: Omit<BasePresetConfig, 'entry' | 'unbundle'> = {
    // MCP shares dist/ with the normal build, so neither build may erase the other.
    clean: false,
    dts: emptyMcp ? false : { incremental: true, parallel: false, eager: true },
    // tsdown rejects both an empty entry and an empty config array. A virtual
    // input completes its normal lifecycle without publishing an empty facet.
    ...(emptyMcp
      ? {
          write: false as const,
          plugins: [
            {
              name: 'doompi-empty-mcp',
              resolveId: (source: string) => (source === emptyEntry ? emptyEntry : undefined),
              load: (id: string) => (id === emptyEntry ? 'export {};' : undefined),
            },
          ],
        }
      : {}),
    exports: !mcpOnly,
    format: ['esm', 'cjs'],
    // No minify. This is a library build, and a mangled stack trace inside a
    // published extension is far more expensive than the bytes it saves.
    // Node output uses fixed extensions, so pi.extensions and doompiServer.dist
    // both land on the .mjs filenames their hosts require.
    platform: 'node',
    outExtensions: ({ format }) => ({
      js: format === 'es' ? '.mjs' : '.cjs',
      dts: format === 'es' ? '.d.mts' : '.d.cts',
    }),
    sourcemap: true,
  };

  // Contract bundles are published as a self-contained graph. Normal extension
  // entries remain unbundled for routed runtime resources, while MCP remains
  // isolated from the shared dist directory.
  const node = (entries: Record<string, string>, _unbundle: boolean): PresetConfig => ({
    ...baseNode,
    entry: entries,
    // Public entry facades must remain bundled. Otherwise their relative
    // imports target unbundled implementation chunks, which Vite treats as
    // source files when resolving a workspace package.
    unbundle: false,
    hooks: {
      'build:done': () => {
        if (mcpOnly) {
          writeMcpManifest(packageDir, result.targets.includes('mcp'));
          return;
        }
        writeManifest({
          packageDir,
          manifest: JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as Record<
            string,
            unknown
          >,
          graph: result.graph,
          targets: result.targets,
          pluginId: result.pluginId,
        });
      },
    },
  });
  const unsyncedNode = (entries: Record<string, string>, unbundle: boolean): PresetConfig => ({
    ...baseNode,
    entry: entries,
    unbundle,
  });
  const configs =
    !mcpOnly && 'api-contracts' in entry
      ? [
          unsyncedNode({ 'api-contracts': entry['api-contracts'] }, false),
          node(Object.fromEntries(Object.entries(entry).filter(([name]) => name !== 'api-contracts')), true),
        ]
      : [node(entry, !mcpOnly)];
  if (!mcpOnly && result.targets.includes('web')) return [...configs, browserConfig()];
  return configs.length === 1 ? configs[0]! : configs;
}
