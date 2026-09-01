import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import ts from 'typescript';
import { projectPath } from './manifestEntries.js';

/**
 * The web (cockpit) plugin an extension package ships from its `src/web/`
 * folder.
 *
 * `src/web` is browser code the cockpit's bundler compiles into the host
 * bundle, so it may reach only the shared browser runtimes, the web contract,
 * the shared components, its own files, and the package's `src/types`. Its
 * manifest block is what `doompi sync` discovers, so a malformed one is caught
 * here rather than at sync.
 */

const PACKAGE_MANIFEST_NAME = 'package.json';
/** The root a package keeps its cockpit plugin in. */
export const WEB_ROOT = 'src/web';
const WEB_TSCONFIG = 'tsconfig.json';
const TYPES_ROOT = 'src/types';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const CONTRACTS_PACKAGE = '@agimon-ai/doompi-web-contracts';
const COMPONENTS_PACKAGE = '@agimon-ai/doompi-web-components';
/** The shared sealed transport; a plugin calling bare fetch sends plaintext to the tunnel's relay. */
const SECURITY_BROWSER_PACKAGE = '@agimon-ai/doompi-web-security/browser';
const ALLOWED_BARE_SPECIFIERS = new Set([
  'react',
  'react/jsx-runtime',
  '@tanstack/store',
  '@tanstack/react-store',
  CONTRACTS_PACKAGE,
  COMPONENTS_PACKAGE,
  SECURITY_BROWSER_PACKAGE,
]);
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const WEB_PLUGIN_EXPORT = 'webPlugin';
const DEFINE_WEB_PLUGIN = 'defineWebPlugin';
const STORE_HELPERS = 'defineGlobalStore/defineSessionStore';

export interface WebPluginBlock {
  pluginId?: unknown;
  registrationOrder?: unknown;
  client?: unknown;
  hub?: unknown;
}

export interface WebPackageManifest {
  files?: unknown;
  dependencies?: Record<string, string>;
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

/** Whether a repo-relative path sits in the web root. */
function isWebPath(relativePath: string): boolean {
  return relativePath === WEB_ROOT || relativePath.startsWith(`${WEB_ROOT}/`);
}

/** The web root a package has on disk, or undefined when it ships no cockpit plugin. */
function existingWebRoot(configRoot: string): string | undefined {
  return fs.existsSync(path.join(configRoot, WEB_ROOT)) ? WEB_ROOT : undefined;
}

/** The repo-relative path of a web plugin source file, or null for anything else. */
function webSourcePath(filePath: string, configRoot: string): string | null {
  const relativePath = projectPath(filePath, configRoot);
  if (relativePath === null || !isWebPath(relativePath)) return null;
  if (!SOURCE_EXTENSIONS.has(path.extname(filePath))) return null;
  return relativePath;
}

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

/** Whether a `files` allowlist entry covers a repo-relative path: the entry itself or a directory above it. */
export function isPublished(files: readonly string[], relativePath: string): boolean {
  return files.some((entry) => {
    const normalized = stripDot(entry).replace(/\/$/, '');
    return relativePath === normalized || relativePath.startsWith(`${normalized}/`);
  });
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

/** The `src/types` files and the bare packages every web plugin source in a package reaches. */
function webImports(configRoot: string): { typeFiles: Set<string>; packages: Set<string> } {
  const typeFiles = new Set<string>();
  const packages = new Set<string>();
  for (const filePath of walkSources(path.join(configRoot, WEB_ROOT))) {
    const sourceFile = readSource(filePath);
    if (!sourceFile) continue;
    for (const specifier of moduleSpecifiers(sourceFile)) {
      if (specifier.startsWith('.')) {
        const target = relativeTarget(filePath, specifier, configRoot);
        if (target !== null && isTypesPath(target)) typeFiles.add(target);
      } else {
        packages.add(bareSpecifierPackage(specifier));
      }
    }
  }
  return { typeFiles, packages };
}

export const webPluginImportAllowlist: RuleDefinition = {
  preflight: true,
  rule: 'A web plugin imports only react, the TanStack store packages, the web contract, the shared components, its own web/ files, and its package src/types',
  rationale:
    "The cockpit's bundler compiles a plugin's web/ folder into the host bundle, so whatever it imports ships to the browser: a node builtin or a server framework breaks the build or leaks into the page, and another plugin's module couples two packages that must stay installable apart. The core boundary rule only sees relative paths, so bare specifiers are checked here.",
  check(filePath, configRoot) {
    if (webSourcePath(filePath, configRoot) === null) return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile) return null;
    const offenders = new Set<string>();
    for (const specifier of moduleSpecifiers(sourceFile)) {
      if (specifier.startsWith('.')) {
        const target = relativeTarget(filePath, specifier, configRoot);
        if (target === null || !(isWebPath(target) || isTypesPath(target))) {
          offenders.add(specifier);
        }
      } else if (!ALLOWED_BARE_SPECIFIERS.has(specifier)) {
        offenders.add(specifier);
      }
    }
    if (offenders.size === 0) return null;
    return `Web plugin code may import only react, @tanstack/store, @tanstack/react-store, ${CONTRACTS_PACKAGE}, ${COMPONENTS_PACKAGE}, its own ${WEB_ROOT}/** and src/types/**; found: ${[...offenders].join(', ')}.`;
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
    return `src/web modules keep no mutable module state (${names.join(', ')}). Put it in ${STORE_HELPERS} or a const Store; components send through props.sendSessionFrame and read statuses from their props.`;
  },
};

export const webPluginManifest: RuleDefinition = {
  preflight: true,
  rule: 'A doompiWeb manifest block names a kebab-case plugin with an existing, typechecked client entry, publishes what its web/ code ships, and depends on the web contract',
  rationale:
    'doompi sync discovers a plugin from this block and Vite compiles the shipped web/ source from the installed package, so a wrong entry path, an unpublished src/types file, or a missing contract dependency only fails on a user machine after publishing. Checking the block against the files it names catches that before the package leaves the repository.',
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
      if (client === null || !client.startsWith('./') || client.includes('..')) {
        problems.push(`'${id}' client must be a package-relative ./path`);
      } else {
        if (!fs.existsSync(path.join(configRoot, client))) problems.push(`'${id}' client '${client}' does not exist`);
        if (!isPublished(files, stripDot(client)))
          problems.push(`'${id}' client '${client}' is not in the files allowlist`);
      }
      // Keyed off the root the package actually has, not the client path: the
      // client may be a re-export from src/exports, which sits in neither root.
      const webRoot = existingWebRoot(configRoot);
      if (webRoot !== undefined && !fs.existsSync(path.join(configRoot, webRoot, WEB_TSCONFIG))) {
        problems.push(`'${id}' has no ${webRoot}/${WEB_TSCONFIG}, so its web entry is never typechecked`);
      }
      if (block.hub !== undefined) {
        const hub = block.hub as { entry?: unknown; dist?: unknown } | string;
        const entry = normalizeEntry(hub);
        const dist = typeof hub === 'object' && hub !== null ? hub.dist : undefined;
        if (entry === null || !fs.existsSync(path.join(configRoot, entry))) {
          problems.push(`'${id}' hub.entry '${String(entry)}' does not exist`);
        }
        if (typeof dist !== 'string' || !dist.startsWith('./')) {
          problems.push(`'${id}' hub.dist must be the package-relative ./path of the built hub entry`);
        }
      }
    }
    const imports = webImports(configRoot);
    for (const typeFile of [...imports.typeFiles].sort()) {
      if (!isPublished(files, typeFile))
        problems.push(`${WEB_ROOT}/ imports '${typeFile}', which is not in the files allowlist`);
    }
    if (manifest.dependencies?.[CONTRACTS_PACKAGE] === undefined) {
      problems.push(`${CONTRACTS_PACKAGE} must be a dependency: the synced bundle imports it at runtime`);
    }
    if (imports.packages.has(COMPONENTS_PACKAGE) && manifest.dependencies?.[COMPONENTS_PACKAGE] === undefined) {
      problems.push(`${COMPONENTS_PACKAGE} must be a dependency: ${WEB_ROOT}/ imports it`);
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
      if (statement.moduleSpecifier.text === CONTRACTS_PACKAGE && bindings && ts.isNamedImports(bindings)) {
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
    if (!sourceFile || exportsWebPlugin(sourceFile)) return null;
    const target = reExportedWebPluginTarget(sourceFile, filePath);
    if (target !== null) {
      const forwarded = readResolvedSource(target);
      if (forwarded && exportsWebPlugin(forwarded)) return null;
    }
    return `The doompiWeb client entry must export ${WEB_PLUGIN_EXPORT} built with ${DEFINE_WEB_PLUGIN}(...) imported from ${CONTRACTS_PACKAGE}, directly or through one re-export; the host registry imports { ${WEB_PLUGIN_EXPORT} } from it.`;
  },
};
