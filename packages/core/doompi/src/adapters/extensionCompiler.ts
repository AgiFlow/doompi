import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LogLevel, LogOrStringHandler, OutputAsset, OutputChunk, RolldownLog, RolldownOutput } from 'rolldown';
import { optionalPackageEntry } from './modules/moduleResolution';
import {
  contentSha256,
  findSharedBuild,
  materializeSharedBuild,
  publishSharedBuild,
  type ResolvedSharedBuild,
  type SharedBuildInput,
  withSharedBuildLock,
} from './sharedBuildCache.ts';

/**
 * Compiles TypeScript extensions into plain ESM ahead of the session.
 *
 * Pi loads extensions through jiti, which transpiles TypeScript at import time.
 * That works, but it costs a transform per module on a cold cache and makes Node
 * complain about type stripping under node_modules on every launch. Resolution
 * already knows the full extension list, so each TypeScript graph is compiled
 * to native ESM here and Pi imports it without a runtime transform. Lazy imports
 * remain separate content-addressed chunks so their evaluation semantics survive
 * compilation.
 *
 * Mode artifacts bundle their JavaScript dependencies. Node built-ins, native
 * packages, and Pi's shared runtime stay external; those imports are rewritten
 * to absolute paths so a worktree-local artifact never relies on its
 * generated directory having its own `node_modules` tree. Immutable build objects
 * may be shared by linked worktrees, but materialized output stays worktree-local.
 */

const TYPESCRIPT_SUFFIXES = ['.ts', '.mts', '.cts'] as const;
const COMPILED_SUFFIX = '.mjs';
const SET_CACHE_VERSION = 'v14';
const HASH_LENGTH = 16;
const SET_DIRECTORY = 'sets';
const MANIFEST_SUFFIX = '.json';
const VIRTUAL_SET_ENTRY = '\0doompi-extension-set';
const EXTENSION_SOURCE_HELPER = '@agimon-ai/doompi-ui/extensionName';
const SHARED_BUILD_VERSION = 'v3-rolldown-1.2.5';
const SHARED_PATH_TOKEN_PREFIX = '__DOOMPI_PATH_';
const REPOSITORY_INPUT_PREFIX = 'repo/';
const EXTERNAL_INPUT_PREFIX = 'external/';
const DEFAULT_SET_OUTPUT_NAME = 'doom-set';

/** Serializes data embedded in generated JavaScript without leaving HTML or line-separator code boundaries. */
function javascriptStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}
/** Pi's former npm scope. The packages are the same, published under a new name. */
const PI_SCOPE_RENAMES: Readonly<Record<string, string>> = {
  '@mariozechner/pi-coding-agent': '@earendil-works/pi-coding-agent',
  '@mariozechner/pi-tui': '@earendil-works/pi-tui',
  '@mariozechner/pi-ai': '@earendil-works/pi-ai',
  '@sinclair/typebox': 'typebox',
};

export function isTypeScriptEntry(entry: string): boolean {
  return TYPESCRIPT_SUFFIXES.some((suffix) => entry.endsWith(suffix));
}

function renameScope(specifier: string): string {
  for (const [before, after] of Object.entries(PI_SCOPE_RENAMES)) {
    if (specifier === before) return after;
    if (specifier.startsWith(`${before}/`)) return `${after}${specifier.slice(before.length)}`;
  }
  return specifier;
}

/**
 * Packages that must resolve to the copy this harness runs, never to a second
 * one bundled into an extension. Pi owns the TUI and the session state, so a
 * duplicate renders into a different screen and mutates a different store.
 */
const HOSTED_PACKAGES = new Set(['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', '@earendil-works/pi-ai']);

/**
 * Resolves packages Pi exposes to extensions as compatibility aliases.
 *
 * Extensions do not need to declare TypeBox themselves because Pi's loader
 * provides it as a virtual module. A dist bundle bypasses that loader, so it
 * resolves the same package against Pi's dependency tree and bundles it.
 */
function piExtensionDependencyEntry(specifier: string): string | undefined {
  const piEntry = optionalPackageEntry('@earendil-works/pi-coding-agent');
  if (!piEntry) return undefined;
  try {
    return createRequire(piEntry).resolve(specifier);
  } catch {
    return undefined;
  }
}

/** Packages whose native binaries or runtime discovery cannot be rolled up. */
const NATIVE_PACKAGES = new Set([
  '@parcel/watcher',
  '@napi-rs/keyring',
  'better-sqlite3',
  'canvas',
  'fsevents',
  'isolated-vm',
  'keytar',
  'node-pty',
  'onnxruntime-node',
  'playwright',
  'playwright-core',
  'puppeteer',
  'sharp',
  // TypeScript 7 exposes version metadata at its top-level entry and keeps its
  // compiler APIs behind unstable native ESM subpaths. Preserve the installed
  // package graph so extensions resolve those entrypoints at runtime.
  'typescript',
]);

/**
 * Dependency-heavy ESM runtimes that should retain their installed graph.
 *
 * Folding these packages into the aggregate creates dozens of generated chunks
 * that Node must parse and link before any extension factory can register. Node
 * can load the installed graph directly while still sharing its module cache.
 */
const STARTUP_EXTERNAL_PACKAGES = new Set([
  '@agimon-ai/foundation-port-registry',
  '@agimon-ai/foundation-process-registry',
  '@agimon-ai/log-sink-mcp',
  '@modelcontextprotocol/sdk',
  '@narumitw/pi-tui-kit',
  '@rmux/sdk',
  '@tursodatabase/database',
  '@tursodatabase/database-common',
  'ajv',
  'ajv-formats',
  'gpt-tokenizer',
  'highlight.js',
  'hono',
  'inversify',
  // open 11 resolves its bundled xdg-open helper relative to import.meta.url.
  // Bundling changes that module location and can break helper discovery.
  'open',
  'reflect-metadata',
  'zod-to-json-schema',
  'yaml',
  'zod',
]);
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

interface InputFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
}

interface CompiledExtensionManifest {
  version: string;
  output: string;
  artifacts: string[];
}

interface ExtensionSetManifest extends CompiledExtensionManifest {
  entries: string[];
  inputs: InputFingerprint[];
}

export interface CompileExtensionSetOptions {
  /** Persistent worktree artifact directory. Compiler manifests remain local. */
  outputDirectory?: string;
  /** Human-readable artifact prefix, normally the major-mode name. */
  outputName?: string;
  /** Canonical worktree root used to create relocatable logical input paths. */
  repositoryRoot?: string;
  /** Repository-level immutable cache shared by linked worktrees. */
  sharedCacheDirectory?: string;
}

function safeOutputName(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return normalized || DEFAULT_SET_OUTPUT_NAME;
}

function packageRootOf(specifier: string): string | undefined {
  const slash = specifier.startsWith('@') ? specifier.indexOf('/', specifier.indexOf('/') + 1) : specifier.indexOf('/');
  return slash === -1 ? specifier : specifier.slice(0, slash);
}

function packageRootFromPath(target: string): string | undefined {
  let directory = path.dirname(target);
  while (true) {
    const manifestPath = path.join(directory, 'package.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
        if (isRecord(manifest) && typeof manifest.name === 'string') return manifest.name;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

interface LogicalInput {
  logicalPath: string;
  target: string;
  sourcePath?: string;
}

function canonicalPath(target: string): string {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function isInside(directory: string, target: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function externalLogicalPath(sourcePath: string): string {
  const identity = createHash('sha256').update(sourcePath).digest('hex');
  return `${EXTERNAL_INPUT_PREFIX}${identity}`;
}

function logicalInput(target: string, repositoryRoot: string): LogicalInput {
  const absolute = canonicalPath(target);
  if (isInside(repositoryRoot, absolute)) {
    return {
      logicalPath: `${REPOSITORY_INPUT_PREFIX}${path.relative(repositoryRoot, absolute).split(path.sep).join('/')}`,
      target: absolute,
    };
  }
  return {
    logicalPath: externalLogicalPath(absolute),
    target: absolute,
    sourcePath: absolute,
  };
}

function resolveLogicalInputPath(input: SharedBuildInput, repositoryRoot: string): string | undefined {
  if (input.logicalPath.startsWith(REPOSITORY_INPUT_PREFIX) && input.sourcePath === undefined) {
    const target = path.resolve(repositoryRoot, input.logicalPath.slice(REPOSITORY_INPUT_PREFIX.length));
    return isInside(repositoryRoot, target) ? target : undefined;
  }
  if (
    input.logicalPath.startsWith(EXTERNAL_INPUT_PREFIX) &&
    input.sourcePath !== undefined &&
    input.logicalPath === externalLogicalPath(input.sourcePath)
  ) {
    return input.sourcePath;
  }
  return undefined;
}

function fingerprint(target: string): InputFingerprint | undefined {
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) return undefined;
    return { path: target, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

function artifactsAreFresh(manifest: CompiledExtensionManifest, version: string, output: string): boolean {
  return (
    manifest.version === version &&
    manifest.output === output &&
    fs.existsSync(output) &&
    manifest.artifacts.every((artifact) => fs.existsSync(artifact))
  );
}

function manifestIsFresh(manifest: ExtensionSetManifest, entries: string[]): boolean {
  if (!artifactsAreFresh(manifest, SET_CACHE_VERSION, manifest.output)) return false;
  if (JSON.stringify(manifest.entries) !== JSON.stringify(entries)) {
    return false;
  }
  return manifest.inputs.every((previous) => {
    const current = fingerprint(previous.path);
    return current?.size === previous.size && current.mtimeMs === previous.mtimeMs;
  });
}

function readCompiledExtensionManifest(manifestPath: string): CompiledExtensionManifest | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CompiledExtensionManifest;
    return parsed && typeof parsed.output === 'string' && Array.isArray(parsed.artifacts) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readSetManifest(manifestPath: string): ExtensionSetManifest | undefined {
  const parsed = readCompiledExtensionManifest(manifestPath) as ExtensionSetManifest | undefined;
  return parsed && Array.isArray(parsed.entries) && Array.isArray(parsed.inputs) ? parsed : undefined;
}

function writeAtomic(target: string, contents: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, contents);
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (!fs.existsSync(target)) throw error;
  }
}

interface CompiledGraph {
  entry: string;
  artifacts: string[];
}

function splitOutputOptions(entryFileNames: string) {
  return {
    format: 'esm' as const,
    sourcemap: false,
    minify: true,
    codeSplitting: true,
    hashCharacters: 'hex' as const,
    entryFileNames,
    chunkFileNames: `chunks/[name].[hash:${HASH_LENGTH}]${COMPILED_SUFFIX}`,
    assetFileNames: `assets/[name].[hash:${HASH_LENGTH}][extname]`,
  };
}

function artifactTarget(outputDirectory: string, artifact: OutputAsset | OutputChunk): string {
  const target = path.resolve(outputDirectory, artifact.fileName);
  const relative = path.relative(outputDirectory, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Rolldown emitted an artifact outside the output directory: ${artifact.fileName}`);
  }
  return target;
}

function artifactMatches(target: string, contents: string | Uint8Array): boolean {
  try {
    const current = fs.readFileSync(target);
    const generated = typeof contents === 'string' ? Buffer.from(contents) : Buffer.from(contents);
    return current.equals(generated);
  } catch {
    return false;
  }
}

/** Writes referenced chunks first so a visible entry always has a complete graph. */
function writeCompiledGraph(generated: RolldownOutput, outputDirectory: string): CompiledGraph {
  const entry = generated.output.find((artifact) => artifact.type === 'chunk' && artifact.isEntry);
  if (!entry || entry.type !== 'chunk') throw new Error('Rolldown produced no extension entry');
  const root = path.resolve(outputDirectory);
  const remaining = generated.output.filter((artifact) => artifact !== entry);
  for (const artifact of [...remaining, entry]) {
    const contents = artifact.type === 'chunk' ? artifact.code : artifact.source;
    const target = artifactTarget(root, artifact);
    if (!artifactMatches(target, contents)) writeAtomic(target, contents);
  }
  return {
    entry: artifactTarget(root, entry),
    artifacts: generated.output.map((artifact) => artifactTarget(root, artifact)).sort(),
  };
}

function sharedLookupKey(entries: readonly LogicalInput[], outputName: string): string {
  return createHash('sha256')
    .update(SHARED_BUILD_VERSION)
    .update(process.version)
    .update(process.platform)
    .update(process.arch)
    .update(outputName)
    .update(JSON.stringify(entries.map((entry) => entry.logicalPath)))
    .digest('hex');
}

interface TokenizedInputs {
  shared: SharedBuildInput[];
  byTarget: Map<string, string>;
}

function tokenizedInputs(inputs: ReadonlySet<string>, repositoryRoot: string): TokenizedInputs {
  const logical: LogicalInput[] = [];
  for (const target of inputs) logical.push(logicalInput(target, repositoryRoot));
  logical.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
  const shared: SharedBuildInput[] = [
    { logicalPath: REPOSITORY_INPUT_PREFIX, sha256: '', token: `${SHARED_PATH_TOKEN_PREFIX}ROOT__` },
  ];
  const byTarget = new Map<string, string>([[repositoryRoot, `${SHARED_PATH_TOKEN_PREFIX}ROOT__`]]);
  const tokenByLogicalPath = new Map<string, string>();
  logical.forEach((input, index) => {
    const existing = tokenByLogicalPath.get(input.logicalPath);
    const token = existing ?? `${SHARED_PATH_TOKEN_PREFIX}${String(index)}__`;
    if (!existing) {
      shared.push({
        logicalPath: input.logicalPath,
        sha256: contentSha256(fs.readFileSync(input.target)),
        token,
        ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
      });
      tokenByLogicalPath.set(input.logicalPath, token);
    }
    byTarget.set(path.resolve(input.target), token);
  });
  for (const target of inputs) {
    const input = logicalInput(target, repositoryRoot);
    const token = tokenByLogicalPath.get(input.logicalPath);
    if (token) byTarget.set(path.resolve(target), token);
  }
  return { shared, byTarget };
}

function tokenizedArtifactContents(
  generated: RolldownOutput,
  tokens: ReadonlyMap<string, string>,
): Map<string, string | Uint8Array> {
  const artifacts = new Map<string, string | Uint8Array>();
  const replacements = [...tokens.entries()].sort(([left], [right]) => right.length - left.length);
  for (const artifact of generated.output) {
    if (artifact.type === 'asset') {
      artifacts.set(artifact.fileName, typeof artifact.source === 'string' ? artifact.source : artifact.source);
      continue;
    }
    let source = artifact.code;
    for (const [target, token] of replacements) {
      source = source
        .replaceAll(pathToFileURL(target).href, `${token}:url`)
        .replaceAll(pathToImportSpecifier(target), token)
        .replaceAll(target, token);
    }
    artifacts.set(artifact.fileName, source);
  }
  return artifacts;
}

function writeLocalSetManifest(
  manifestPath: string,
  entries: string[],
  output: string,
  artifacts: string[],
  inputs: ReadonlySet<string>,
): void {
  const inputFingerprints = [...inputs]
    .map(fingerprint)
    .filter((value): value is InputFingerprint => value !== undefined)
    .sort((left, right) => left.path.localeCompare(right.path));
  writeAtomic(
    manifestPath,
    `${JSON.stringify(
      { version: SET_CACHE_VERSION, entries, output, artifacts: [...artifacts].sort(), inputs: inputFingerprints },
      null,
      2,
    )}\n`,
  );
}

function materializeSharedSet(
  build: ResolvedSharedBuild,
  outputDirectory: string,
  manifestPath: string,
  entries: string[],
): string {
  const output = materializeSharedBuild(build, outputDirectory);
  const inputs = new Set(build.replacements.values());
  const artifacts = build.manifest.artifacts.map((artifact) => path.join(outputDirectory, artifact.path));
  writeLocalSetManifest(manifestPath, entries, output, artifacts, inputs);
  return output;
}

/** Stable lookup key for one exact Pi load order. */
export function extensionSetKey(entries: readonly string[]): string {
  return createHash('sha256')
    .update(SET_CACHE_VERSION)
    .update(JSON.stringify(entries.map((entry) => path.resolve(entry))))
    .digest('hex')
    .slice(0, HASH_LENGTH);
}

function extensionSetSource(entries: readonly string[]): string {
  const helper = optionalPackageEntry(EXTENSION_SOURCE_HELPER);
  if (!helper) throw new Error(`Cannot resolve ${EXTENSION_SOURCE_HELPER}`);
  const loaders = entries.map((entry) => `() => import(${javascriptStringLiteral(pathToImportSpecifier(entry))})`);
  const names = entries.map((entry) => javascriptStringLiteral(entry));
  return [
    `import { withExtensionSource } from ${javascriptStringLiteral(pathToImportSpecifier(helper))};`,
    `const loaders = [${loaders.join(',')}];`,
    `const names = [${names.join(',')}];`,
    'function report(index, phase, startedAt, error) {',
    '  const elapsed = (performance.now() - startedAt).toFixed(1);',
    '  const detail = error instanceof Error ? ": " + error.message : error === undefined ? "" : ": " + String(error);',
    '  process.stderr.write("[doompi:timing] " + phase + " " + elapsed + "ms " + names[index] + detail + "\\n");',
    '}',
    'export default async function doompiExtensionSet(pi) {',
    '  const timings = process.env.DOOMPI_TIMING === "1" || process.env.PI_TIMING === "1";',
    '  const loaded = await Promise.all(loaders.map(async (load, index) => {',
    '    const startedAt = performance.now();',
    '    try {',
    '      const extension = await load();',
    '      if (timings) report(index, "import", startedAt);',
    '      return extension;',
    '    } catch (error) {',
    '      report(index, "import-error", startedAt, error);',
    '      return undefined;',
    '    }',
    '  }));',
    '  for (let index = 0; index < loaded.length; index += 1) {',
    '    const extension = loaded[index];',
    '    if (!extension) continue;',
    '    const startedAt = performance.now();',
    '    try {',
    '      const factory = extension.default;',
    "      if (typeof factory !== 'function') throw new Error('does not export an extension factory');",
    '      await factory(withExtensionSource(pi, names[index]));',
    '      if (timings) report(index, "factory", startedAt);',
    '    } catch (error) {',
    '      report(index, "factory-error", startedAt, error);',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

function pathToImportSpecifier(target: string): string {
  // Rolldown accepts absolute POSIX paths directly. Windows needs a file URL,
  // but replacing separators is enough for its platform-independent parser.
  return path.resolve(target).split(path.sep).join('/');
}

function setExternalResolver(inputs: Set<string>, entry?: string) {
  return {
    name: 'doom-set-external',
    async resolveId(
      this: { resolve: (id: string, importer?: string, options?: unknown) => Promise<{ id: string } | null> },
      specifier: string,
      importer: string | undefined,
      options: unknown,
    ): Promise<{ id: string; external: boolean } | null> {
      if (specifier === VIRTUAL_SET_ENTRY) return null;
      if (NODE_BUILTINS.has(specifier) || specifier.startsWith('node:')) {
        return { id: specifier, external: true };
      }

      if (path.isAbsolute(specifier)) {
        if (!importer && entry && path.resolve(specifier) === path.resolve(entry)) return null;
        const root = packageRootFromPath(specifier);
        if (root && (HOSTED_PACKAGES.has(root) || NATIVE_PACKAGES.has(root) || STARTUP_EXTERNAL_PACKAGES.has(root))) {
          inputs.add(specifier);
          return { id: specifier, external: true };
        }
        return null;
      }
      if (specifier.startsWith('.')) return null;

      const renamed = renameScope(specifier);
      const root = packageRootOf(renamed);
      if (root && HOSTED_PACKAGES.has(root)) {
        const hosted = optionalPackageEntry(renamed);
        if (hosted) {
          inputs.add(hosted);
          return { id: hosted, external: true };
        }
      }
      if (root === 'typebox') {
        const typebox = piExtensionDependencyEntry(renamed);
        if (typebox) {
          inputs.add(typebox);
          return { id: typebox, external: true };
        }
      }
      if (root && (NATIVE_PACKAGES.has(root) || STARTUP_EXTERNAL_PACKAGES.has(root))) {
        const resolved = await this.resolve(renamed, importer, options);
        if (resolved) {
          inputs.add(resolved.id);
          return { id: resolved.id, external: true };
        }
      }
      return null;
    },
  };
}

function inputCollector(inputs: Set<string>) {
  return {
    name: 'doom-set-inputs',
    load(id: string): null {
      if (path.isAbsolute(id) && fs.existsSync(id)) inputs.add(id);
      return null;
    },
  };
}

/** An unresolved bare import would otherwise become a broken dist external. */
function failUnresolvedImport(_level: LogLevel, log: RolldownLog, handler: LogOrStringHandler): void {
  if (log.code === 'UNRESOLVED_IMPORT') handler('error', log);
}

interface SourceRange {
  start: number;
  end: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectImportMetaUrlRanges(value: unknown, ranges: SourceRange[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectImportMetaUrlRanges(item, ranges);
    return;
  }
  if (!isRecord(value)) return;

  const object = value.object;
  const property = value.property;
  if (
    value.type === 'MemberExpression' &&
    value.computed === false &&
    typeof value.start === 'number' &&
    typeof value.end === 'number' &&
    isRecord(object) &&
    object.type === 'MetaProperty' &&
    isRecord(object.meta) &&
    object.meta.name === 'import' &&
    isRecord(object.property) &&
    object.property.name === 'meta' &&
    isRecord(property) &&
    property.name === 'url'
  ) {
    ranges.push({ start: value.start, end: value.end });
    return;
  }

  for (const child of Object.values(value)) collectImportMetaUrlRanges(child, ranges);
}

/** Keeps package-owned resource lookup anchored to each original source file. */
function preserveImportMetaUrl() {
  return {
    name: 'doom-original-import-meta-url',
    transform(
      this: {
        parse: (source: string, options?: { lang?: 'js' | 'jsx' | 'ts' | 'tsx' }) => unknown;
      },
      source: string,
      id: string,
    ): string | null {
      if (!path.isAbsolute(id) || !source.includes('import.meta.url')) return null;
      const extension = path.extname(id).toLowerCase();
      const lang = extension === '.tsx' ? 'tsx' : extension === '.jsx' ? 'jsx' : isTypeScriptEntry(id) ? 'ts' : 'js';
      const ranges: SourceRange[] = [];
      collectImportMetaUrlRanges(this.parse(source, { lang }), ranges);
      if (ranges.length === 0) return null;
      const replacement = javascriptStringLiteral(pathToFileURL(id).href);
      let transformed = source;
      for (const range of ranges.sort((left, right) => right.start - left.start)) {
        transformed = `${transformed.slice(0, range.start)}${replacement}${transformed.slice(range.end)}`;
      }
      return transformed;
    },
  };
}

/** Location of the lightweight input-fingerprint record for one extension set. */
export function extensionSetManifestPath(
  entries: readonly string[],
  cacheDirectory: string,
  options: CompileExtensionSetOptions = {},
): string {
  const normalized = entries.map((entry) => path.resolve(entry));
  const key = extensionSetKey(normalized);
  const outputDirectory = path.resolve(options.outputDirectory ?? path.join(cacheDirectory, SET_DIRECTORY));
  const outputName = safeOutputName(options.outputName ?? DEFAULT_SET_OUTPUT_NAME);
  // One graph can be emitted under several named mode artifacts. Keep their
  // cache records separate without changing extensionSetKey, which is the
  // runtime lookup key for an exact activation order.
  const outputKey = createHash('sha256').update(outputDirectory).update(outputName).digest('hex').slice(0, HASH_LENGTH);
  return path.join(cacheDirectory, SET_DIRECTORY, `${key}.${outputKey}${MANIFEST_SUFFIX}`);
}

/**
 * Compiles an ordered extension set into one native ESM entry.
 *
 * The generated entry starts every module load together, then invokes factories
 * sequentially in activation order. Its manifest records every loaded module,
 * so a dependency edit invalidates the cache without running the compiler.
 */
export async function compileExtensionSet(
  entries: readonly string[],
  cacheDirectory: string,
  options: CompileExtensionSetOptions = {},
): Promise<string> {
  if (entries.length === 0) throw new Error('Cannot compile an empty extension set');
  const normalized = entries.map((entry) => path.resolve(entry));
  const setDirectory = path.join(cacheDirectory, SET_DIRECTORY);
  fs.mkdirSync(setDirectory, { recursive: true });
  const outputDirectory = path.resolve(options.outputDirectory ?? setDirectory);
  const outputName = safeOutputName(options.outputName ?? DEFAULT_SET_OUTPUT_NAME);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const manifestPath = extensionSetManifestPath(normalized, cacheDirectory, options);
  const previous = readSetManifest(manifestPath);
  if (previous && manifestIsFresh(previous, normalized)) return previous.output;

  const generate = async (): Promise<{ generated: RolldownOutput; inputs: Set<string> }> => {
    const inputs = new Set(normalized);
    const source = extensionSetSource(normalized);
    const { rolldown } = await import('rolldown');
    const build = await rolldown({
      input: VIRTUAL_SET_ENTRY,
      platform: 'node',
      plugins: [
        {
          name: 'doom-set-entry',
          resolveId(id: string): string | null {
            return id === VIRTUAL_SET_ENTRY ? id : null;
          },
          load(id: string): string | null {
            return id === VIRTUAL_SET_ENTRY ? source : null;
          },
        },
        setExternalResolver(inputs),
        preserveImportMetaUrl(),
        inputCollector(inputs),
      ],
      onLog: failUnresolvedImport,
    });
    try {
      return {
        generated: await build.generate(splitOutputOptions(`${outputName}.[hash:${HASH_LENGTH}]${COMPILED_SUFFIX}`)),
        inputs,
      };
    } finally {
      await build.close();
    }
  };

  const repositoryRoot = options.repositoryRoot ? canonicalPath(options.repositoryRoot) : undefined;

  if (repositoryRoot && options.sharedCacheDirectory) {
    const logicalEntries = normalized.map((entry) => logicalInput(entry, repositoryRoot));
    const lookupKey = sharedLookupKey(logicalEntries, outputName);
    const resolveInput = (input: SharedBuildInput): string | undefined =>
      resolveLogicalInputPath(input, repositoryRoot);
    return withSharedBuildLock(options.sharedCacheDirectory, lookupKey, async () => {
      const cached = findSharedBuild(options.sharedCacheDirectory as string, lookupKey, resolveInput);
      if (cached) return materializeSharedSet(cached, outputDirectory, manifestPath, normalized);

      const { generated, inputs } = await generate();
      const tokenized = tokenizedInputs(inputs, repositoryRoot);
      const artifacts = tokenizedArtifactContents(generated, tokenized.byTarget);
      if (
        [...artifacts.values()].some((contents) => typeof contents === 'string' && contents.includes(repositoryRoot))
      ) {
        throw new Error('Shared build graph still contains an absolute worktree path after tokenization');
      }
      const entry = generated.output.find((artifact) => artifact.type === 'chunk' && artifact.isEntry);
      if (!entry) throw new Error('Rolldown produced no shared extension entry');
      publishSharedBuild({
        cacheDirectory: options.sharedCacheDirectory as string,
        lookupKey,
        entry: entry.fileName,
        inputs: tokenized.shared,
        artifacts,
      });
      const published = findSharedBuild(options.sharedCacheDirectory as string, lookupKey, resolveInput);
      if (!published) throw new Error('Published shared build could not be verified');
      return materializeSharedSet(published, outputDirectory, manifestPath, normalized);
    });
  }

  const { generated, inputs } = await generate();
  const compiled = writeCompiledGraph(generated, outputDirectory);
  writeLocalSetManifest(manifestPath, normalized, compiled.entry, compiled.artifacts, inputs);
  return compiled.entry;
}
