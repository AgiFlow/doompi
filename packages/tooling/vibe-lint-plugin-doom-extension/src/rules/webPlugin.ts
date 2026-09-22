import * as fs from 'node:fs';
import * as path from 'node:path';

import { isBrowserFile } from '@agimon-ai/doompi-build/browser-file';
import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import ts from 'typescript';

import { projectPath } from './manifestEntries.js';

/**
 * The web (cockpit) plugin an extension package ships from the browser half of
 * its routed tree.
 *
 * A browser-bound routed file is compiled into the host bundle by the cockpit's
 * bundler, so it may reach only the shared browser runtimes, the web contract,
 * the shared components, its own colocated files, and the package's
 * `src/types`. `isBrowserFile` is the same predicate the build uses, so the
 * rules and the bundle agree on which half a file belongs to. The manifest
 * block is what `doompi sync` discovers, so a malformed one is caught here
 * rather than at sync.
 */

const PACKAGE_MANIFEST_NAME = 'package.json';
/** The pre-routing browser root, still walked by the tool renderer scan. */
export const WEB_ROOT = 'src/web';
/** The routing root the browser half is scanned from. */
const EXTENSIONS_ROOT = 'src/extensions';
/**
 * The build's typed API client, the one generated module browser code may read.
 *
 * It is the reason a plugin no longer writes its own URLs, so a page must be
 * able to reach it. The rest of `generated/` stays out: those are host entries,
 * and a browser file importing the server one would pull Node into the bundle.
 */
const GENERATED_API_CLIENT = 'generated/client';
/** The remaining raw hub sender is migrated after the Author pilot. */
const LEGACY_HUB_SENDERS = new Set(['@agimon-ai/doompi-git']);
const ROUTED_WEB_TSCONFIG = 'tsconfig.web.json';
const TYPES_ROOT = 'src/types';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const CONTRACTS_PACKAGE = '@agimon-ai/doompi-core';
const WEB_CONTRACTS_ENTRY = `${CONTRACTS_PACKAGE}/web`;
const COMPONENTS_PACKAGE = '@agimon-ai/doompi-web-components';
/** The shared sealed transport; a plugin calling bare fetch sends plaintext to the tunnel's relay. */
const SECURITY_BROWSER_PACKAGE = '@agimon-ai/doompi-web-security/browser';
const ALLOWED_BARE_SPECIFIERS = new Set([
  'react',
  'react/jsx-runtime',
  '@tanstack/store',
  '@tanstack/react-store',
  // The browser-only MCP App bridge. Server and host SDK subpaths remain disallowed.
  '@modelcontextprotocol/ext-apps',
  WEB_CONTRACTS_ENTRY,
  COMPONENTS_PACKAGE,
  SECURITY_BROWSER_PACKAGE,
]);
/**
 * Story files may also reach for the contract's own slot fixtures.
 *
 * The allowlist exists because the cockpit's bundler compiles a plugin's web/
 * folder into the host bundle. A story is never imported by the plugin entry,
 * so the bundler never reaches it, and `files` in each package excludes
 * `*.stories.tsx` from the tarball. Hand-rolled prop stubs would be the only
 * alternative, and those drift silently when the slot contract changes.
 */
const STORY_SUFFIX = '.stories.tsx';
const CONTRACTS_TESTING_PACKAGE = `${WEB_CONTRACTS_ENTRY}/testing`;
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const WEB_PLUGIN_EXPORT = 'webPlugin';
const DEFINE_WEB_PLUGIN = 'defineWebPlugin';
const STORE_HELPERS = 'defineGlobalStore/defineSessionStore';
/**
 * A private transport inside the browser half: a protocol, transport,
 * communication, or socket folder, or a `*Socket` module. The platform suffix
 * sits between the name and the extension, so the name is matched up to its
 * first dot.
 */
const PRIVATE_BROWSER_TRANSPORT = /\/(?:protocol|transport|communication|socket)(?:\/|\.)|\/[^/.]*Socket\.[^/]+$/u;

export interface WebPluginBlock {
  pluginId?: unknown;
  registrationOrder?: unknown;
  client?: unknown;
  hub?: unknown;
}

export interface WebPackageManifest {
  name?: unknown;
  files?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  doompiWeb?: unknown;
}

function readText(filePath: string): string | null {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

export function readManifest(configRoot: string): WebPackageManifest | null {
  const text = readText(path.join(configRoot, PACKAGE_MANIFEST_NAME));
  if (!text) return null;
  try {
    return JSON.parse(text) as WebPackageManifest;
  } catch {
    return null;
  }
}

export function readSource(filePath: string): ts.SourceFile | null {
  const text = readText(filePath);
  return text !== null && SOURCE_EXTENSIONS.has(path.extname(filePath))
    ? ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true)
    : null;
}

/**
 * Whether a repo-relative path sits in the pre-routing browser root.
 *
 * Only an import target is still asked this: a routed browser file may reach
 * the src/web modules it has not absorbed yet. It goes when the folder does.
 */
function isWebPath(relativePath: string): boolean {
  return relativePath === WEB_ROOT || relativePath.startsWith(`${WEB_ROOT}/`);
}

/** The repo-relative path of a browser-bound source file, or null for anything else. */
function webSourcePath(filePath: string, configRoot: string): string | null {
  const relativePath = projectPath(filePath, configRoot);
  if (relativePath === null || !isBrowserFile(relativePath)) return null;
  if (!SOURCE_EXTENSIONS.has(path.extname(filePath))) return null;
  return relativePath;
}

/** Package browser messages use scoped typed calls; only host administration uses raw hub frames. */
export const webPluginTypedCalls: RuleDefinition = {
  preflight: true,
  rule: 'Web plugins call typed scoped server methods instead of sending raw hub frames',
  rationale:
    'A raw frame has no request or response schema and can silently reach the wrong composition scope. Typed methods validate both sides and carry an explicit global or workspace address.',
  check(filePath, configRoot) {
    const manifest = readManifest(configRoot);
    if (!manifest?.doompiWeb || (typeof manifest.name === 'string' && LEGACY_HUB_SENDERS.has(manifest.name)))
      return null;
    if (webSourcePath(filePath, configRoot) === null) return null;
    const source = readSource(filePath);
    if (!source) return null;
    let rawSender = false;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === 'sendHubFrame') rawSender = true;
      ts.forEachChild(node, visit);
    };
    visit(source);
    return rawSender ? 'Use runtime.invokeServerMethod with a declared scoped plugin method.' : null;
  },
};

/** Prevents a second package-owned transport tree from growing beside the typed contract. */
export const webPluginProtocolLayout: RuleDefinition = {
  preflight: true,
  rule: 'Plugin protocol schemas live in src/schemas and packages do not create private transport roots',
  rationale:
    'Private protocol, transport, and socket trees duplicate the host connection and leave unused message handlers behind. Package methods belong in src/schemas, server registration in a routed (backend) api file, and browser callers in a routed (frontend) one.',
  check(filePath, configRoot) {
    const manifest = readManifest(configRoot);
    if (!manifest?.doompiWeb || !fs.existsSync(filePath)) return null;
    const relativePath = projectPath(filePath, configRoot);
    if (relativePath === null || !SOURCE_EXTENSIONS.has(path.extname(filePath))) return null;
    if (
      /^(?:src\/)?(?:protocol|transport|communication|socket)(?:\/|\.)/u.test(relativePath) ||
      /^src\/adapters\/(?:protocol|transport|communication|socket)(?:\/|\.)/u.test(relativePath) ||
      (isBrowserFile(relativePath) && PRIVATE_BROWSER_TRANSPORT.test(relativePath))
    )
      return `${relativePath} creates a private protocol or transport surface; use the host plugin method runtime.`;
    const source = readSource(filePath);
    if (!source) return null;
    let definesMethod = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'defineDoomPluginMethod'
      )
        definesMethod = true;
      ts.forEachChild(node, visit);
    };
    visit(source);
    return definesMethod && !relativePath.startsWith('src/schemas/')
      ? `${relativePath} defines a plugin method outside src/schemas/.`
      : null;
  },
};

/** Every module specifier a file names: static imports and re-exports, type-only ones included, and dynamic imports. */
function moduleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteralLike(argument)) specifiers.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function isTypesPath(relativePath: string): boolean {
  return relativePath === TYPES_ROOT || relativePath.startsWith(`${TYPES_ROOT}/`);
}

/** A relative specifier resolved to a repo-relative path, or null when it leaves the package. */
function relativeTarget(filePath: string, specifier: string, configRoot: string): string | null {
  return projectPath(path.resolve(path.dirname(filePath), specifier), configRoot);
}

function bareSpecifierPackage(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? specifier);
}

export function normalizeEntry(value: unknown): string | null {
  const entry = typeof value === 'string' ? value : ((value as { entry?: unknown } | null)?.entry ?? null);
  return typeof entry === 'string' ? entry : null;
}

export function stripDot(relativePath: string): string {
  return relativePath.replace(/^\.\//, '');
}

export function pluginBlocks(manifest: WebPackageManifest): WebPluginBlock[] {
  if (manifest.doompiWeb === undefined) return [];
  const blocks = Array.isArray(manifest.doompiWeb) ? manifest.doompiWeb : [manifest.doompiWeb];
  return blocks.filter((block): block is WebPluginBlock => typeof block === 'object' && block !== null);
}

/** Matches the literal directories and glob patterns used by package publication allowlists. */
export function isPublished(files: readonly string[], relativePath: string): boolean {
  const matches = (entry: string): boolean => {
    const normalized = stripDot(entry).replace(/\/$/, '');
    return (
      relativePath === normalized ||
      relativePath.startsWith(`${normalized}/`) ||
      path.matchesGlob(relativePath, normalized)
    );
  };
  return (
    files.some((entry) => !entry.startsWith('!') && matches(entry)) &&
    !files.some((entry) => entry.startsWith('!') && matches(entry.slice(1)))
  );
}

/** Follow package-local source dependencies from the published browser entry, including worker URL imports. */
function unpublishedBrowserDependencies(configRoot: string, entry: string, files: readonly string[]): string[] {
  const pending = [path.resolve(configRoot, stripDot(entry))];
  const visited = new Set<string>();
  const missing = new Set<string>();
  while (pending.length > 0) {
    const filePath = pending.pop()!;
    if (visited.has(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    visited.add(filePath);
    const source = readSource(filePath);
    if (!source) continue;
    for (const specifier of moduleSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      // Vite queries select how the file is bundled, but are not part of its packed filename.
      const target = path.resolve(path.dirname(filePath), specifier.replace(/[?#].*$/u, ''));
      if (projectPath(target, configRoot) === null) continue;
      const candidates = [
        target,
        ...[...SOURCE_EXTENSIONS].map((extension) => `${target}${extension}`),
        ...[...SOURCE_EXTENSIONS].map((extension) => path.join(target, `index${extension}`)),
      ];
      const dependency = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (!dependency) continue;
      const relative = projectPath(dependency, configRoot)!;
      if (!isPublished(files, relative)) missing.add(relative);
      pending.push(dependency);
    }
  }
  return [...missing].sort();
}

export function walkSources(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walkSources(entryPath));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) found.push(entryPath);
  }
  return found;
}

/** The `src/types` files and the bare packages every browser-bound source in a package reaches. */
function webImports(configRoot: string): { typeFiles: Set<string>; packages: Set<string> } {
  const typeFiles = new Set<string>();
  const packages = new Set<string>();
  for (const filePath of walkSources(path.join(configRoot, EXTENSIONS_ROOT))) {
    const relativePath = projectPath(filePath, configRoot);
    if (relativePath === null || !isBrowserFile(relativePath)) continue;
    const sourceFile = readSource(filePath);
    if (!sourceFile) continue;
    for (const specifier of moduleSpecifiers(sourceFile)) {
      if (specifier.startsWith('.')) {
        const target = relativeTarget(filePath, specifier, configRoot);
        if (target !== null && isTypesPath(target)) {
          const resolved = SOURCE_EXTENSIONS.has(path.extname(target))
            ? target
            : ([...SOURCE_EXTENSIONS]
                .map((extension) => `${target}${extension}`)
                .find((candidate) => fs.existsSync(path.join(configRoot, candidate))) ?? target);
          typeFiles.add(resolved);
        }
      } else {
        packages.add(bareSpecifierPackage(specifier));
      }
    }
  }
  return { typeFiles, packages };
}

export const webPluginImportAllowlist: RuleDefinition = {
  preflight: true,
  rule: 'A web plugin imports only react, the TanStack store packages, the web contract, the shared components, its own browser-bound routed files, the generated API client, and its package src/types and src/constants',
  rationale:
    "The cockpit's bundler compiles a plugin's browser-bound routed files into the host bundle, so whatever they import ships to the browser: a node builtin or a server framework breaks the build or leaks into the page, and another plugin's module couples two packages that must stay installable apart. The core boundary rule only sees relative paths, so bare specifiers are checked here.",
  check(filePath, configRoot) {
    if (webSourcePath(filePath, configRoot) === null) return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile) return null;
    const offenders = new Set<string>();
    const allowed = filePath.endsWith(STORY_SUFFIX)
      ? new Set([...ALLOWED_BARE_SPECIFIERS, CONTRACTS_TESTING_PACKAGE])
      : ALLOWED_BARE_SPECIFIERS;
    for (const specifier of moduleSpecifiers(sourceFile)) {
      if (specifier.startsWith('.')) {
        const target = relativeTarget(filePath, specifier, configRoot);
        if (
          target === null ||
          !(
            isBrowserFile(target) ||
            isWebPath(target) ||
            isTypesPath(target) ||
            target === GENERATED_API_CLIENT ||
            target === 'src/constants' ||
            target.startsWith('src/constants/')
          )
        ) {
          offenders.add(specifier);
        }
      } else if (!allowed.has(specifier)) {
        offenders.add(specifier);
      }
    }
    if (offenders.size === 0) return null;
    return `Web plugin code may import only react, @tanstack/store, @tanstack/react-store, ${WEB_CONTRACTS_ENTRY}, ${COMPONENTS_PACKAGE}, its own browser-bound routed files, ${GENERATED_API_CLIENT} and src/types/** or src/constants/**; found: ${[...offenders].join(', ')}.`;
  },
};

export const webPluginNoModuleState: RuleDefinition = {
  preflight: true,
  rule: 'A web plugin keeps no mutable module state: page-wide state lives in defineGlobalStore and per-session state lives in defineSessionStore',
  rationale:
    'A module-level let is state nothing subscribes to and nothing resets: a remembered runtime sender outlives the page it was bound for, a cached status goes stale without a re-render, and each plugin reinvents the bookkeeping. The contract gives every component sendSessionFrame and the session statuses as props, defineGlobalStore owns page-wide reactive state, and defineSessionStore owns session records.',
  check(filePath, configRoot) {
    if (webSourcePath(filePath, configRoot) === null) return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile) return null;
    const names: string[] = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      if (statement.declarationList.flags & ts.NodeFlags.Const) continue;
      for (const declaration of statement.declarationList.declarations) names.push(declaration.name.getText());
    }
    if (names.length === 0) return null;
    return `Browser modules keep no mutable module state (${names.join(', ')}). Put it in ${STORE_HELPERS} or a const Store; components send through props.sendSessionFrame and read statuses from their props.`;
  },
};

function hasBrowserRuntime(manifest: WebPackageManifest, packageName: string): boolean {
  if (manifest.dependencies?.[packageName] !== undefined) return true;
  return (
    manifest.peerDependencies?.[packageName] !== undefined &&
    manifest.peerDependenciesMeta?.[packageName]?.optional === true &&
    manifest.devDependencies?.[packageName] !== undefined
  );
}

export const webPluginManifest: RuleDefinition = {
  preflight: true,
  rule: 'A doompiWeb manifest block names a kebab-case browser-only plugin with the canonical client entry',
  rationale:
    'doompi sync discovers browser presentation from doompiWeb.client while server facets own APIs and channels. An alternate client path, web-owned hub entry, unpublished type file, or missing contract dependency fails only after packaging unless rejected here.',
  check(filePath, configRoot) {
    if (path.basename(filePath) !== PACKAGE_MANIFEST_NAME) return null;
    const manifest = readManifest(configRoot);
    if (!manifest || manifest.doompiWeb === undefined) return null;
    const blocks = pluginBlocks(manifest);
    const files = Array.isArray(manifest.files) ? manifest.files.filter((entry) => typeof entry === 'string') : [];
    const problems: string[] = [];
    for (const block of blocks) {
      const id = typeof block.pluginId === 'string' ? block.pluginId : String(block.pluginId);
      if (typeof block.pluginId !== 'string' || !PLUGIN_ID_PATTERN.test(block.pluginId)) {
        problems.push(`pluginId '${id}' must be kebab-case`);
      }
      if (
        block.registrationOrder !== undefined &&
        (!Number.isInteger(block.registrationOrder) || (block.registrationOrder as number) < 0)
      ) {
        problems.push(`'${id}' registrationOrder must be a non-negative integer when present`);
      }
      const client = normalizeEntry(block.client);
      // Two spellings while packages migrate: a hand-written source entry the
      // cockpit compiles itself, or the browser bundle a folder-routed package
      // builds for it.
      const clients = ['./src/extensions/web.ts', './dist/extensions/web.mjs'];
      const bundled = client === './dist/extensions/web.mjs';
      if (client === null || !clients.includes(client)) {
        problems.push(`'${id}' client must be one of ${clients.join(' or ')}`);
      } else {
        // A routed bundle does not exist in a clean checkout. Its generated source
        // and final artifact are created by the package build, after preflight.
        if (!bundled && !fs.existsSync(path.join(configRoot, client)))
          problems.push(`'${id}' client '${client}' does not exist`);
        if (!isPublished(files, stripDot(client)))
          problems.push(`'${id}' client '${client}' is not in the files allowlist`);
        if (!bundled) {
          for (const dependency of unpublishedBrowserDependencies(configRoot, client, files))
            problems.push(`'${id}' browser entry imports '${dependency}', which is not in the files allowlist`);
        }
      }
      if (bundled && !fs.existsSync(path.join(configRoot, ROUTED_WEB_TSCONFIG))) {
        problems.push(`'${id}' has no ${ROUTED_WEB_TSCONFIG}, so its web entry is never typechecked`);
      }
      if (block.hub !== undefined) {
        problems.push(`'${id}' must not declare doompiWeb.hub; register channels and APIs through doompiServer`);
      }
    }
    const imports = webImports(configRoot);
    if (blocks.some((block) => normalizeEntry(block.client) !== './dist/extensions/web.mjs')) {
      for (const typeFile of [...imports.typeFiles].sort()) {
        if (!isPublished(files, typeFile))
          problems.push(`the browser half imports '${typeFile}', which is not in the files allowlist`);
      }
    }
    if (!hasBrowserRuntime(manifest, CONTRACTS_PACKAGE)) {
      problems.push(`${CONTRACTS_PACKAGE} must be a dependency: the synced bundle imports it at runtime`);
    }
    if (imports.packages.has(COMPONENTS_PACKAGE) && !hasBrowserRuntime(manifest, COMPONENTS_PACKAGE)) {
      problems.push(`${COMPONENTS_PACKAGE} must be a dependency: the browser half imports it`);
    }
    return problems.length > 0 ? `doompiWeb manifest: ${problems.join('; ')}.` : null;
  },
};

/**
 * The file a pure re-export of `webPlugin` forwards to, or null when this file
 * is not one. A client entry published through src/exports names the plugin in
 * one `export { webPlugin } from '...'`, so the definition itself lives one hop
 * away and has to be validated there.
 */
function reExportedWebPluginTarget(sourceFile: ts.SourceFile, filePath: string): string | null {
  if (sourceFile.statements.length === 0) return null;
  let target: string | null = null;
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined) return null;
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) return null;
    const clause = statement.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) continue;
    if (clause.elements.some((element) => element.name.text === WEB_PLUGIN_EXPORT)) {
      target = path.resolve(path.dirname(filePath), statement.moduleSpecifier.text);
    }
  }
  return target;
}

/** The source of a re-export target, resolving the extensionless and directory forms. */
function readResolvedSource(target: string): ts.SourceFile | null {
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    path.join(target, 'index.ts'),
    path.join(target, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const sourceFile = readSource(candidate);
    if (sourceFile) return sourceFile;
  }
  return null;
}

/** Whether the file exports `webPlugin` as a `defineWebPlugin(...)` call with the helper imported from the contract. */
function exportsWebPlugin(sourceFile: ts.SourceFile): boolean {
  let importsHelper = false;
  let exportsDefinition = false;
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings;
      if (statement.moduleSpecifier.text === WEB_CONTRACTS_ENTRY && bindings && ts.isNamedImports(bindings)) {
        importsHelper ||= bindings.elements.some(
          (element) => (element.propertyName ?? element.name).text === DEFINE_WEB_PLUGIN,
        );
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!exported) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === WEB_PLUGIN_EXPORT &&
        initializer !== undefined &&
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === DEFINE_WEB_PLUGIN
      ) {
        exportsDefinition = true;
      }
    }
  }
  return importsHelper && exportsDefinition;
}

export const webPluginEntry: RuleDefinition = {
  preflight: true,
  rule: 'The doompiWeb client entry exports webPlugin built with defineWebPlugin from the web contract',
  rationale:
    "The host's generated registry imports { webPlugin } from every client entry by name, and defineWebPlugin is what type-checks the literal against the contract. An entry that exports something else, or builds the definition by hand, fails at the host build after publishing instead of in the editor.",
  check(filePath, configRoot) {
    // Gated on being a declared client entry rather than on living in the web
    // root, so an entry re-exported from src/exports is still checked.
    const relativePath = projectPath(filePath, configRoot);
    if (relativePath === null || !SOURCE_EXTENSIONS.has(path.extname(filePath))) return null;
    const manifest = readManifest(configRoot);
    if (!manifest) return null;
    const entries = pluginBlocks(manifest)
      .map((block) => normalizeEntry(block.client))
      .filter((entry): entry is string => entry !== null)
      .map(stripDot);
    if (!entries.includes(relativePath)) return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile) return null;
    if (exportsWebPlugin(sourceFile)) return null;
    const target = reExportedWebPluginTarget(sourceFile, filePath);
    if (target !== null) {
      const forwarded = readResolvedSource(target);
      if (forwarded && exportsWebPlugin(forwarded)) return null;
    }
    return `The doompiWeb client entry must export ${WEB_PLUGIN_EXPORT} built with ${DEFINE_WEB_PLUGIN}(...) imported from ${WEB_CONTRACTS_ENTRY}, directly or through one re-export; the host registry imports { ${WEB_PLUGIN_EXPORT} } from it.`;
  },
};

/**
 * Keeps a hand-built API URL from reappearing once a package has a client.
 *
 * Every one of these strings used to be written out, and they rotted quietly:
 * matchers kept naming `/api/plugins/<base>/...` long after the real route
 * moved under a workspace prefix, so they matched nothing and the fixture
 * beside them answered instead. The generated client builds the URL, and a
 * literal here means someone went around it.
 *
 * `fetch` is the same failure with a worse consequence: a plugin calling the
 * global directly sends plaintext to the relay a remote session tunnels
 * through, where every sibling goes through the sealed transport.
 */
export const webPluginNoHandBuiltApiUrl: RuleDefinition = {
  preflight: true,
  rule: 'Browser code reaches its API through the generated client rather than a hand-built /api/ string or the global fetch',
  rationale:
    'A URL written by hand agrees with the route only until one of them moves, and nothing reports the disagreement: an unmatched path is answered by the service worker out of the signed bundle cache, and a stale test matcher simply stops firing. The global fetch additionally bypasses the sealed transport, which is what protects a remote session from its own relay. Applies only once a package declares src/types/apiRoutes.ts, so it arrives with the client rather than ahead of it.',
  check(filePath, configRoot) {
    const manifest = readManifest(configRoot);
    if (!manifest?.doompiWeb || !fs.existsSync(filePath)) return null;
    // Only a package that declares a route table has a client to use instead.
    // The rest still hand-build their URLs, and telling them off for it before
    // the alternative exists would be noise they cannot act on.
    if (!fs.existsSync(path.join(configRoot, 'src/types/apiRoutes.ts'))) return null;
    // A story replaces the global fetch and matches the request by URL, which
    // is the seam it has. createRpcStub is the better pattern, because a
    // matcher keyed off a client method cannot rot the way a substring does,
    // but a story naming a URL is doing its job rather than going around the
    // client.
    if (filePath.endsWith(STORY_SUFFIX)) return null;
    const relative = projectPath(filePath, configRoot);
    if (relative === null || !isBrowserFile(relative)) return null;

    const source = fs.readFileSync(filePath, 'utf8');
    const offenders: string[] = [];
    if (/(['"`])\/api\//u.test(source)) offenders.push("a hand-built '/api/...' URL");
    if (/(?<![.\w])fetch\s*\(/u.test(source) && !/\.fetch\s*\(/u.test(source)) {
      offenders.push('a call to the global fetch');
    }
    if (offenders.length === 0) return null;
    return `${offenders.join(' and ')}: build the URL with the generated client in generated/client.ts, which carries the sealed transport.`;
  },
};

/**
 * Makes the per-package wiring step impossible to forget.
 *
 * The generated client is only type-checked if the browser tsconfig includes
 * it. Miss that line and nothing complains here; the failure lands on whoever
 * next runs the browser typecheck, as a module that cannot be found.
 */
export const webPluginGeneratedClientWiring: RuleDefinition = {
  preflight: true,
  rule: 'A package whose tree mounts an api/<base-path>/ folder includes generated/client.ts in its browser tsconfig',
  rationale:
    'The generated client is authored code as far as the browser typecheck is concerned, and an include list that omits it silently drops it from the project. The omission surfaces far from the package that caused it.',
  check(filePath, configRoot) {
    if (path.basename(filePath) !== 'tsconfig.web.json' || !fs.existsSync(filePath)) return null;
    const apiRoot = path.join(configRoot, EXTENSIONS_ROOT);
    if (!fs.existsSync(apiRoot)) return null;
    if (!fs.existsSync(path.join(configRoot, 'src/types/apiRoutes.ts'))) return null;

    const source = fs.readFileSync(filePath, 'utf8');
    if (source.includes(`${GENERATED_API_CLIENT}.ts`)) return null;
    return `Add "${GENERATED_API_CLIENT}.ts" to include, beside generated/web.ts, so the generated client is type-checked.`;
  },
};
