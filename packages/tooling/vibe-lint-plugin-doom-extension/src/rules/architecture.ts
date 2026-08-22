import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RuleDefinition, RuleOptions } from '@agimon-ai/vibe-lint';
import ts from 'typescript';
import {
  type DoomPackageManifest,
  piDiscoveryEntryStems,
  projectPath,
  readPackageManifest,
  runtimeStem,
} from './manifestEntries.js';

const CANONICAL_ROOTS = new Set([
  'adapters',
  'commands',
  'container',
  'exports',
  'providers',
  'schemas',
  'services',
  'tui',
  'types',
]);
const RESOURCE_ROOTS = new Set(['prompts']);
const TRANSITIONAL_ROOTS = new Set(['bin', 'extensions']);
const FORBIDDEN_ROOTS = new Set([
  'agents',
  'api',
  'common',
  'components',
  'config',
  'delegation',
  'entries',
  'helpers',
  'interfaces',
  'misc',
  'protocol',
  'runs',
  'shared',
  'slash',
  'store',
  'tool',
  'utils',
  'workflow',
]);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const HOST_PACKAGES = ['@earendil-works/pi-', '@deepseek-ai/cordis', 'inversify'];
/**
 * Node builtins that are pure computation: no I/O, no ambient state, no
 * nondeterminism. They leave a service just as testable as a local helper
 * would, so the host-independence boundary has no reason to reject them.
 * node:crypto is deliberately absent because randomUUID and friends are exactly the
 * nondeterminism a service should take as a dependency.
 */
const PURE_NODE_BUILTINS = new Set([
  'node:assert',
  'node:buffer',
  'node:path',
  'node:punycode',
  'node:querystring',
  'node:string_decoder',
  'node:url',
  'node:util',
]);
const EXTERNAL_IMPLEMENTATION_ROOTS = ['adapters', 'bin', 'commands', 'container', 'exports', 'extensions', 'tui'];
const ALLOWED_ROOT_DEPENDENCIES: Readonly<Record<string, ReadonlySet<string>>> = {
  adapters: new Set(['adapters', 'schemas', 'services', 'types']),
  commands: new Set(['commands', 'schemas', 'services', 'types']),
  container: new Set(['adapters', 'commands', 'container', 'providers', 'schemas', 'services', 'tui', 'types']),
  providers: new Set(['providers', 'schemas', 'services', 'types']),
  exports: new Set([...CANONICAL_ROOTS, ...TRANSITIONAL_ROOTS]),
  schemas: new Set(['schemas', 'types']),
  services: new Set(['schemas', 'services', 'types']),
  tui: new Set(['schemas', 'services', 'tui', 'types']),
  types: new Set(['types']),
  bin: new Set(['adapters', 'bin', 'commands', 'container', 'providers', 'schemas', 'services', 'tui', 'types']),
};

const DEFAULT_COMPOSITION_ADAPTER_ROOTS = ['src/adapters/pi'];
const DEFAULT_COMPOSITION_PACKAGES = ['@agimon-ai/doompi'];
const DEFAULT_COMPOSITION_PATHS = [
  'src/adapters/composer.ts',
  'src/adapters/extensionCompiler.ts',
  'src/adapters/runtimeBundle.ts',
  'src/adapters/syncState.ts',
  'src/adapters/syncedRuntimeBuilder.ts',
  'src/services/extensionAssembler.ts',
  'src/services/transitionClassifier.ts',
  'src/services/transitionCoordinator.ts',
];
const DEFAULT_FIXED_CORE_PACKAGES = [
  '@agimon-ai/doompi',
  '@agimon-ai/doompi-autostop',
  '@agimon-ai/doompi-cache',
  '@agimon-ai/doompi-config',
  '@agimon-ai/doompi-domain',
  '@agimon-ai/doompi-major-mode',
  '@agimon-ai/doompi-notification',
  '@agimon-ai/doompi-profile',
  '@agimon-ai/doompi-skill',
  '@agimon-ai/doompi-ui',
];

/**
 * Package dependency tiers, lowest first. A package may import its own tier and
 * any tier below it. An upward import is rejected.
 *
 * These are dependency depth, not activation role. doompi-domain is fixed host
 * core in exactly the way doompi-config is, but it needs doompi-mcp, so the two
 * cannot share a tier. Activation role is `fixedCorePackages`, kept separately.
 *
 * Extensions share one tier because they legitimately compose each other
 * (doompi-autocompact needs doompi-task, doompi-plan needs doompi-user-feedback).
 */
const DEFAULT_PACKAGE_LAYER_ORDER = ['contracts', 'platform', 'integration', 'extension', 'host'];
const DEFAULT_PACKAGE_LAYER_FALLBACK = 'extension';
const DEFAULT_PACKAGE_LAYERS: Readonly<Record<string, string>> = {
  '@agimon-ai/doompi-extension-contracts': 'contracts',
  '@agimon-ai/doompi-telemetry': 'contracts',
  '@agimon-ai/doompi-config': 'platform',
  '@agimon-ai/doompi-ui': 'platform',
  '@agimon-ai/doompi-cache': 'integration',
  '@agimon-ai/doompi-mcp': 'integration',
  '@agimon-ai/doompi': 'host',
};
const DEFAULT_INFRASTRUCTURE_PACKAGES = ['@agimon-ai/doompi-extension-contracts', '@agimon-ai/doompi-telemetry'];
const DEFAULT_FEATURE_PACKAGE_PREFIXES = ['@agimon-ai/doompi-'];
const DEFAULT_FOUNDATION_PACKAGES = ['@agimon-ai/doompi-extension-contracts'];
const DEFAULT_FOUNDATION_PACKAGE_PREFIXES = ['@agimon-ai/foundation-'];
const DEFAULT_PI_PACKAGE_PREFIXES = ['@agimon-ai/doompi-'];
const DEFAULT_NON_PI_PACKAGES = ['@agimon-ai/doompi-extension-contracts', '@agimon-ai/doompi-telemetry'];
const DEFAULT_NON_PI_PACKAGE_PREFIXES = ['@agimon-ai/doompi-runner-rmux-', '@agimon-ai/doompi-runner-rtk-'];
const DEFAULT_FIXED_FEATURE_IDENTIFIERS = [
  'curatedComposition',
  'dispatcherExtension',
  'featureExtensionMap',
  'featureFactories',
  'featureMap',
  'featureNames',
  'featurePackages',
  'featureSlots',
  'fixedFeatures',
  'fixedFeatureSlots',
  'nativeAggregate',
  'nativeOwners',
  'selectedPackageExtension',
];
const LEGACY_DOOM_ENTRY_PATTERN = /(?:^|\/)extensions\/doom\.(?:cjs|cts|js|mjs|mts|ts|tsx)$/i;
const PUBLIC_ABI_REFERENCE_PATTERN =
  /(?:^|[/._-])(?:cordis|kernel|capabilities|native(?:[/_-][a-z0-9-]+)?)(?:$|[/._-])/i;
const PUBLIC_ABI_NAME_PATTERN = /^(?:Cordis|Kernel|Native|Capabilities|CapabilityRoot)/;
const SOURCE_BUILD_ENTRY_PATTERN = /^\.?\/?src\//;
const TSDOWN_CONFIG_PATTERN = /(?:^|\/)tsdown\.config\.(?:cjs|cts|js|mjs|mts|ts)$/;
const VALID_PI_TARGET_PATTERN = /^\.\/dist\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.mjs$/;
const SOURCE_TARGET_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;
const CAPABILITIES_PACKAGE_FRAGMENT = 'doompi-capabilities';
const PACKAGE_MANIFEST_PATH = 'package.json';
const DOOM_PACKAGE_NAME = '@agimon-ai/doompi';
const DOOM_PACKAGE_PREFIX = `${DOOM_PACKAGE_NAME}-`;
const CORDIS_CONTRACTS_PACKAGE = '@agimon-ai/doompi-extension-contracts';
const CORDIS_HOST_ADAPTER_PATH = 'src/adapters/pi/cordisHost.ts';
const CORDIS_HOST_EXPORT = '@agimon-ai/doompi-extension-contracts/cordis-host';
const LEGACY_SESSION_CONTEXT_EXPORT = '@agimon-ai/doompi-extension-contracts/session-context';
const LEGACY_SESSION_CONTEXT_PATHS = new Set(['src/exports/sessionContext.ts', 'src/schemas/sessionContext.ts']);
const DOOM_HOST_CORDIS_FEATURE_PATHS = [
  'src/extensions/entries/modeCatalog.ts',
  'src/extensions/entries/styleSystem.ts',
  'src/extensions/entries/transitionCoordinator.ts',
] as const;
const DOOM_EXTENSION_ASSEMBLER_PATH = 'src/services/extensionAssembler.ts';
const REQUIRED_CORDIS_HELPERS = new Map<string, string>([
  ['requireDoomConfigContext', 'DOOM_CONFIG_SERVICE'],
  ['requireDoomConfigService', 'DOOM_CONFIG_SERVICE'],
  ['requireDoomMcpProjectionService', 'DOOM_MCP_PROJECTION_SERVICE'],
  ['requireDoomReadinessCoordinator', 'DOOM_READINESS_SERVICE'],
  ['requireDoomTransitionCoordinator', 'DOOM_TRANSITION_SERVICE'],
  ['requireDoomUiHub', 'DOOM_UI_HUB_SERVICE'],
  ['requireMinorModeCatalog', 'DOOM_MINOR_MODE_CATALOG_SERVICE'],
]);
const CORDIS_SERVICE_IDENTIFIER_PATTERN = /^(?:DOOM_[A-Z0-9_]+_SERVICE|MINOR_MODE_CATALOG_SERVICE)$/;
const REQUIRED_CORDIS_HELPER_PATTERN = /^require(Doom|Minor)([A-Z][A-Za-z0-9]*?)(?:Service|Context|Coordinator)?$/;

interface CleanArchitectureOptions {
  compositionPackages: string[];
  compositionPaths: string[];
  fixedCorePackages: string[];
  infrastructurePackages: string[];
  featurePackagePrefixes: string[];
  foundationPackages: string[];
  foundationPackagePrefixes: string[];
  piPackagePrefixes: string[];
  nonPiPackages: string[];
  nonPiPackagePrefixes: string[];
  fixedFeatureIdentifiers: string[];
}

interface ArchitectureManifest extends DoomPackageManifest {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
}

function stringListOption(options: Readonly<RuleOptions> | undefined, key: string, fallback: string[]): string[] {
  const configured = options?.[key];
  return Array.isArray(configured) && configured.every((value): value is string => typeof value === 'string')
    ? [...configured]
    : [...fallback];
}

function stringOption(options: Readonly<RuleOptions> | undefined, key: string, fallback: string): string {
  const configured = options?.[key];
  return typeof configured === 'string' ? configured : fallback;
}

function stringRecordOption(
  options: Readonly<RuleOptions> | undefined,
  key: string,
  fallback: Readonly<Record<string, string>>,
): Record<string, string> {
  const configured = options?.[key];
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) return { ...fallback };
  const entries = Object.entries(configured).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : { ...fallback };
}

function cleanArchitectureOptions(options: Readonly<RuleOptions> | undefined): CleanArchitectureOptions {
  return {
    compositionPackages: stringListOption(options, 'compositionPackages', DEFAULT_COMPOSITION_PACKAGES),
    compositionPaths: stringListOption(options, 'compositionPaths', DEFAULT_COMPOSITION_PATHS),
    fixedCorePackages: stringListOption(options, 'fixedCorePackages', DEFAULT_FIXED_CORE_PACKAGES),
    infrastructurePackages: stringListOption(options, 'infrastructurePackages', DEFAULT_INFRASTRUCTURE_PACKAGES),
    featurePackagePrefixes: stringListOption(options, 'featurePackagePrefixes', DEFAULT_FEATURE_PACKAGE_PREFIXES),
    foundationPackages: stringListOption(options, 'foundationPackages', DEFAULT_FOUNDATION_PACKAGES),
    foundationPackagePrefixes: stringListOption(
      options,
      'foundationPackagePrefixes',
      DEFAULT_FOUNDATION_PACKAGE_PREFIXES,
    ),
    piPackagePrefixes: stringListOption(options, 'piPackagePrefixes', DEFAULT_PI_PACKAGE_PREFIXES),
    nonPiPackages: stringListOption(options, 'nonPiPackages', DEFAULT_NON_PI_PACKAGES),
    nonPiPackagePrefixes: stringListOption(options, 'nonPiPackagePrefixes', DEFAULT_NON_PI_PACKAGE_PREFIXES),
    fixedFeatureIdentifiers: stringListOption(options, 'fixedFeatureIdentifiers', DEFAULT_FIXED_FEATURE_IDENTIFIERS),
  };
}

function readSource(filePath: string): ts.SourceFile | null {
  if (!fs.existsSync(filePath) || !SOURCE_EXTENSIONS.has(path.extname(filePath))) return null;
  return ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
}

type FunctionWithBody = ts.FunctionLikeDeclaration & { readonly body: ts.ConciseBody };

function isFunctionWithBody(node: ts.Node): node is FunctionWithBody {
  return ts.isFunctionLike(node) && 'body' in node && node.body !== undefined;
}

function isDoomPackageName(packageName: string | undefined): boolean {
  return packageName === DOOM_PACKAGE_NAME || packageName?.startsWith(DOOM_PACKAGE_PREFIX) === true;
}

function cordisContextConstructionCount(sourceFile: ts.SourceFile): number {
  const contextAliases = new Set<string>();
  const cordisNamespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@deepseek-ai/cordis'
    ) {
      continue;
    }
    if (statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) cordisNamespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        if ((element.propertyName ?? element.name).text === 'Context') contextAliases.add(element.name.text);
      }
    }
  }

  const isCordisRequire = (node: ts.Expression): boolean =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    node.arguments[0].text === '@deepseek-ai/cordis';
  const isContextValue = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) return contextAliases.has(node.text);
    return (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'Context' &&
      ((ts.isIdentifier(node.expression) && cordisNamespaces.has(node.expression.text)) ||
        isCordisRequire(node.expression))
    );
  };
  const isNamespaceValue = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && cordisNamespaces.has(node.text)) || isCordisRequire(node);

  let changed = true;
  while (changed) {
    changed = false;
    const add = (set: Set<string>, name: string): void => {
      if (!set.has(name)) {
        set.add(name);
        changed = true;
      }
    };
    const visitAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) {
          if (isContextValue(node.initializer)) add(contextAliases, node.name.text);
          if (isNamespaceValue(node.initializer)) add(cordisNamespaces, node.name.text);
        }
        if (ts.isObjectBindingPattern(node.name) && isNamespaceValue(node.initializer)) {
          for (const element of node.name.elements) {
            const property = element.propertyName ?? element.name;
            if (
              ts.isIdentifier(element.name) &&
              ((ts.isIdentifier(property) && property.text === 'Context') ||
                (ts.isStringLiteralLike(property) && property.text === 'Context'))
            ) {
              add(contextAliases, element.name.text);
            }
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        if (isContextValue(node.right)) add(contextAliases, node.left.text);
        if (isNamespaceValue(node.right)) add(cordisNamespaces, node.left.text);
      }
      ts.forEachChild(node, visitAliases);
    };
    visitAliases(sourceFile);
  }

  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression) && contextAliases.has(node.expression.text)) count += 1;
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'Context' &&
        ts.isIdentifier(node.expression.expression) &&
        cordisNamespaces.has(node.expression.expression.text)
      ) {
        count += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

function cordisHostConnectorNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== CORDIS_HOST_EXPORT
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'connectDoomCordisHost') names.add(element.name.text);
    }
  }
  return names;
}

interface CordisFeatureMount {
  connectionCount: number;
  capturedConnectionCount: number;
  rootPluginCount: number;
  capturedFiberCount: number;
  hasOrderedShutdownDisposal: boolean;
}

type CordisDisposalKind = 'connection' | 'fiber';

interface CordisDisposalStep {
  readonly awaited: boolean;
  readonly guaranteed: boolean;
  readonly kind: CordisDisposalKind;
}

function directlyAwaited(node: ts.Expression): boolean {
  let current: ts.Node = node;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent) ||
    ts.isNonNullExpression(current.parent)
  ) {
    current = current.parent;
  }
  return ts.isAwaitExpression(current.parent);
}

function returnedIdentifiers(callback: ts.FunctionLikeDeclaration): ReadonlySet<string> {
  const identifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (node !== callback && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      const expression = unwrapArchitectureExpression(node.expression);
      if (ts.isIdentifier(expression)) identifiers.add(expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(callback);
  return identifiers;
}

function unwrapArchitectureExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function resultObservedByFunction(node: ts.Expression, callback: ts.FunctionLikeDeclaration): boolean {
  const returned = returnedIdentifiers(callback);
  let current: ts.Node = node;
  for (;;) {
    const parent = current.parent;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent)
    ) {
      current = parent;
      continue;
    }
    if (ts.isAwaitExpression(parent)) return true;
    if (ts.isReturnStatement(parent) && parent.expression === current) return true;
    if (callback.body !== undefined && !ts.isBlock(callback.body) && callback.body === current) return true;
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === current &&
      ts.isIdentifier(parent.name) &&
      returned.has(parent.name.text)
    ) {
      return true;
    }
    if (ts.isBinaryExpression(parent) && parent.right === current) {
      if (ts.isIdentifier(parent.left) && returned.has(parent.left.text)) return true;
      if (
        [
          ts.SyntaxKind.EqualsToken,
          ts.SyntaxKind.AmpersandAmpersandEqualsToken,
          ts.SyntaxKind.BarBarEqualsToken,
          ts.SyntaxKind.QuestionQuestionEqualsToken,
        ].includes(parent.operatorToken.kind)
      ) {
        current = parent;
        continue;
      }
    }
    return false;
  }
}

function conditionallyExecuted(node: ts.Node, callback: ts.FunctionLikeDeclaration): boolean {
  for (let current = node.parent; current && current !== callback; current = current.parent) {
    if (
      ts.isIfStatement(current) ||
      ts.isConditionalExpression(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Walk a shutdown callback in execution order, inlining local cleanup helpers
 * at their call sites. Function declarations and callback literals are skipped
 * until invoked, so their source positions cannot masquerade as call order.
 */
function cordisShutdownDisposals(
  callback: ts.Node,
  fibers: ReadonlySet<string>,
  connections: ReadonlySet<string>,
  localCleanupFunctions: ReadonlyMap<string, ts.FunctionLikeDeclaration>,
): CordisDisposalStep[] {
  const steps: CordisDisposalStep[] = [];
  const activeHelpers = new Set<ts.FunctionLikeDeclaration>();

  const walk = (
    node: ts.Node,
    functionResultObserved: boolean,
    owningFunction: ts.FunctionLikeDeclaration | undefined,
    enteredFunction = false,
  ): void => {
    if (ts.isFunctionLike(node) && !enteredFunction) return;
    if (ts.isCallExpression(node)) {
      const callResultObserved =
        functionResultObserved &&
        (directlyAwaited(node) || (!!owningFunction && resultObservedByFunction(node, owningFunction)));
      let callee: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
      if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
        walk(callee, callResultObserved, callee, true);
        return;
      }
      if (ts.isIdentifier(node.expression)) {
        const helper = localCleanupFunctions.get(node.expression.text);
        if (helper && !activeHelpers.has(helper)) {
          activeHelpers.add(helper);
          walk(helper, callResultObserved, helper, true);
          activeHelpers.delete(helper);
          return;
        }
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'dispose' &&
        ts.isIdentifier(node.expression.expression)
      ) {
        const receiver = node.expression.expression.text;
        const kind: CordisDisposalKind | undefined = fibers.has(receiver)
          ? 'fiber'
          : connections.has(receiver)
            ? 'connection'
            : undefined;
        if (kind) {
          steps.push({
            kind,
            awaited: callResultObserved,
            guaranteed: !!owningFunction && !conditionallyExecuted(node, owningFunction),
          });
          return;
        }
      }
      if (callResultObserved) {
        for (const argument of node.arguments) {
          if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
            walk(argument, true, argument, true);
          }
        }
      }
    }
    ts.forEachChild(node, (child) => walk(child, functionResultObserved, owningFunction, false));
  };

  const owningFunction = isFunctionWithBody(callback) ? callback : undefined;
  walk(callback, true, owningFunction, true);
  return steps;
}

function cordisFeatureMount(sourceFile: ts.SourceFile): CordisFeatureMount {
  const connectors = cordisHostConnectorNames(sourceFile);
  const connections = new Set<string>();
  const fibers = new Set<string>();
  let connectionCount = 0;
  let capturedConnectionCount = 0;
  let rootPluginCount = 0;

  const enclosingVariable = (expression: ts.Expression): string | undefined => {
    let current: ts.Node = expression;
    while (
      ts.isAwaitExpression(current.parent) ||
      ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isNonNullExpression(current.parent)
    ) {
      current = current.parent;
    }
    const declaration = current.parent;
    return ts.isVariableDeclaration(declaration) &&
      declaration.initializer === current &&
      ts.isIdentifier(declaration.name)
      ? declaration.name.text
      : undefined;
  };

  const collectConnections = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && connectors.has(node.expression.text)) {
      connectionCount += 1;
      const binding = enclosingVariable(node);
      if (binding) {
        capturedConnectionCount += 1;
        connections.add(binding);
      }
    }
    ts.forEachChild(node, collectConnections);
  };
  collectConnections(sourceFile);

  const collectFibers = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'plugin' &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'root' &&
      ts.isIdentifier(node.expression.expression.expression) &&
      connections.has(node.expression.expression.expression.text)
    ) {
      rootPluginCount += 1;
      const binding = enclosingVariable(node);
      if (binding) fibers.add(binding);
    }
    ts.forEachChild(node, collectFibers);
  };
  collectFibers(sourceFile);

  const sessionShutdownAliases = new Set<string>();
  const localCleanupFunctions = new Map<string, ts.FunctionLikeDeclaration>();
  const collectLocalBindings = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) localCleanupFunctions.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isStringLiteralLike(node.initializer) && node.initializer.text === 'session_shutdown') {
        sessionShutdownAliases.add(node.name.text);
      }
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        localCleanupFunctions.set(node.name.text, node.initializer);
      }
    }
    ts.forEachChild(node, collectLocalBindings);
  };
  collectLocalBindings(sourceFile);

  let hasOrderedShutdownDisposal = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'on' &&
      ((ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === 'session_shutdown') ||
        (ts.isIdentifier(node.arguments[0]) && sessionShutdownAliases.has(node.arguments[0].text)))
    ) {
      const callback = node.arguments[1];
      if (!callback) return;
      const referencedCleanup = ts.isIdentifier(callback) ? localCleanupFunctions.get(callback.text) : undefined;
      const disposals = cordisShutdownDisposals(
        referencedCleanup ?? callback,
        fibers,
        connections,
        localCleanupFunctions,
      );
      const firstFiberDisposal = disposals.findIndex(({ kind }) => kind === 'fiber');
      const firstConnectionDisposal = disposals.findIndex(({ kind }) => kind === 'connection');
      if (
        firstFiberDisposal >= 0 &&
        firstConnectionDisposal >= 0 &&
        disposals[firstFiberDisposal]?.awaited === true &&
        disposals[firstFiberDisposal]?.guaranteed === true &&
        disposals[firstConnectionDisposal]?.awaited === true &&
        disposals[firstConnectionDisposal]?.guaranteed === true &&
        firstFiberDisposal < firstConnectionDisposal
      ) {
        hasOrderedShutdownDisposal = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    connectionCount,
    capturedConnectionCount,
    rootPluginCount,
    capturedFiberCount: fibers.size,
    hasOrderedShutdownDisposal,
  };
}

function cordisFeatureMountViolations(mount: CordisFeatureMount): string[] {
  const violations: string[] = [];
  if (mount.connectionCount !== 1) {
    violations.push(`exactly one connectDoomCordisHost() call is required (found ${mount.connectionCount})`);
  } else if (mount.capturedConnectionCount !== 1) {
    violations.push('the host connection must be captured in a local lease variable');
  }
  if (mount.rootPluginCount !== 1) {
    violations.push(`exactly one capturedConnection.root.plugin() call is required (found ${mount.rootPluginCount})`);
  } else if (mount.capturedFiberCount !== 1) {
    violations.push('the root.plugin() result must be captured in a local fiber variable');
  }
  if (!mount.hasOrderedShutdownDisposal) {
    violations.push(
      'session_shutdown must await the captured fiber.dispose() before awaiting the host connection.dispose()',
    );
  }
  return violations;
}

function isOwnCordisEntry(expression: ts.Expression | undefined, entry: 'cordisHost' | 'cordisFinalizer'): boolean {
  return (
    !!expression &&
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === 'resolve' &&
    expression.expression.name.text === 'ownEntry' &&
    expression.arguments.length === 1 &&
    ts.isPropertyAccessExpression(expression.arguments[0]) &&
    ts.isIdentifier(expression.arguments[0].expression) &&
    expression.arguments[0].expression.text === 'OWN_ENTRIES' &&
    expression.arguments[0].name.text === entry
  );
}

function cordisActivationOrderViolations(sourceFile: ts.SourceFile): string[] {
  const violations: string[] = [];
  for (const functionName of ['parentActivation', 'childActivation'] as const) {
    const declaration = sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === functionName,
    );
    if (!declaration?.body) {
      violations.push(`${functionName}() is missing`);
      continue;
    }
    const activationDeclaration = declaration.body.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === 'activation');
    const initializer = activationDeclaration?.initializer;
    if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
      violations.push(`${functionName}() must declare its activation array explicitly`);
      continue;
    }
    if (!isOwnCordisEntry(initializer.elements[0] as ts.Expression | undefined, 'cordisHost')) {
      violations.push(`${functionName}() must put cordisHost first`);
    }

    const pushes: ts.CallExpression[] = [];
    const forbiddenMutations: string[] = [];
    const returns: ts.ReturnStatement[] = [];
    let hostReferences = initializer.elements.filter(
      (element) => ts.isExpression(element) && isOwnCordisEntry(element, 'cordisHost'),
    ).length;
    let finalizerReferences = initializer.elements.filter(
      (element) => ts.isExpression(element) && isOwnCordisEntry(element, 'cordisFinalizer'),
    ).length;
    const visit = (node: ts.Node): void => {
      if (node !== declaration && ts.isFunctionLike(node)) return;
      if (ts.isIdentifier(node) && node.text === 'activation' && node !== activationDeclaration.name) {
        const parent = node.parent;
        const isPushReceiver =
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          parent.name.text === 'push' &&
          ts.isCallExpression(parent.parent) &&
          parent.parent.expression === parent;
        const isDirectReturn = ts.isReturnStatement(parent) && parent.expression === node;
        const isDeduplicatedReturn =
          ts.isCallExpression(parent) &&
          parent.arguments.length === 1 &&
          parent.arguments[0] === node &&
          ts.isIdentifier(parent.expression) &&
          parent.expression.text === 'deduplicatePaths' &&
          ts.isReturnStatement(parent.parent) &&
          parent.parent.expression === parent;
        if (!isPushReceiver && !isDirectReturn && !isDeduplicatedReturn) forbiddenMutations.push('alias/escape');
      }
      if (ts.isCallExpression(node)) {
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'activation'
        ) {
          if (node.expression.name.text === 'push') {
            pushes.push(node);
            hostReferences += node.arguments.filter((argument) => isOwnCordisEntry(argument, 'cordisHost')).length;
            finalizerReferences += node.arguments.filter((argument) =>
              isOwnCordisEntry(argument, 'cordisFinalizer'),
            ).length;
          } else {
            forbiddenMutations.push(node.expression.name.text);
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ((ts.isIdentifier(node.left) && node.left.text === 'activation') ||
          (ts.isElementAccessExpression(node.left) &&
            ts.isIdentifier(node.left.expression) &&
            node.left.expression.text === 'activation'))
      ) {
        forbiddenMutations.push('assignment');
      }
      if (ts.isReturnStatement(node)) returns.push(node);
      ts.forEachChild(node, visit);
    };
    visit(declaration.body);
    if (hostReferences !== 1) violations.push(`${functionName}() must contain cordisHost exactly once`);
    if (finalizerReferences !== 1) violations.push(`${functionName}() must contain cordisFinalizer exactly once`);
    const lastPush = pushes.sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile)).at(-1);
    if (!lastPush || lastPush.arguments.length !== 1 || !isOwnCordisEntry(lastPush.arguments[0], 'cordisFinalizer')) {
      violations.push(`${functionName}() must append cordisFinalizer after every other activation`);
    }
    if (forbiddenMutations.length > 0) {
      violations.push(
        `${functionName}() mutates activation outside append-only push (${[...new Set(forbiddenMutations)].sort().join(', ')})`,
      );
    }
    const validReturn = returns.some(({ expression }) => {
      if (!expression) return false;
      if (ts.isIdentifier(expression)) return expression.text === 'activation';
      return (
        ts.isCallExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === 'deduplicatePaths' &&
        expression.arguments.length === 1 &&
        ts.isIdentifier(expression.arguments[0]) &&
        expression.arguments[0].text === 'activation'
      );
    });
    if (returns.length !== 1 || !validReturn) {
      violations.push(`${functionName}() must return the final activation array without wrapping or reordering it`);
    }
  }
  return violations;
}

interface CordisInjectionFact {
  readonly callback: ts.ArrowFunction | ts.FunctionExpression;
  readonly services: ReadonlySet<string>;
  readonly ownsLifecycle: boolean;
  readonly ownsStableBinding: boolean;
}

interface CordisServiceUse {
  readonly service: string;
  readonly filePath: string;
  readonly position: number;
  readonly directlyOwned: boolean;
}

interface CordisServiceFacts {
  readonly injections: CordisInjectionFact[];
  readonly invalidProviders: readonly string[];
  readonly uses: CordisServiceUse[];
}

interface CordisSourceUnit {
  readonly filePath: string;
  readonly sourceFile: ts.SourceFile;
}

interface CordisFunctionRecord {
  readonly name: string;
  readonly node: ts.FunctionLikeDeclaration;
}

type OwnedCordisScopes = ReadonlyMap<ts.FunctionLikeDeclaration, ReadonlySet<string>>;

function productionSourceFiles(configRoot: string): string[] {
  const sourceRoot = path.join(configRoot, 'src');
  if (!fs.existsSync(sourceRoot)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(target);
    }
  };
  visit(sourceRoot);
  return files.sort();
}

function cordisImportBindings(sourceFile: ts.SourceFile): {
  requiredHelpers: Map<string, string>;
  serviceConstants: Map<string, string>;
} {
  const requiredHelpers = new Map<string, string>();
  const serviceConstants = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      const local = element.name.text;
      const explicitService = REQUIRED_CORDIS_HELPERS.get(imported);
      const helperMatch = REQUIRED_CORDIS_HELPER_PATTERN.exec(imported);
      const inferredTopic = helperMatch?.[2]?.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
      const requiredService =
        explicitService ??
        (helperMatch && inferredTopic
          ? `DOOM_${helperMatch[1] === 'Minor' ? 'MINOR_' : ''}${inferredTopic}_SERVICE`
          : undefined);
      if (requiredService) requiredHelpers.set(local, requiredService);
      if (CORDIS_SERVICE_IDENTIFIER_PATTERN.test(imported)) serviceConstants.set(local, imported);
    }
  }
  return { requiredHelpers, serviceConstants };
}

function cordisServiceExpression(
  expression: ts.Expression | undefined,
  serviceConstants: ReadonlyMap<string, string>,
): string | undefined {
  if (!expression) return undefined;
  if (ts.isIdentifier(expression)) return serviceConstants.get(expression.text);
  if (ts.isStringLiteralLike(expression) && expression.text.startsWith('doom/')) {
    return `DOOM_${expression.text
      .slice('doom/'.length)
      .replace(/[^A-Za-z0-9]+/g, '_')
      .toUpperCase()}_SERVICE`;
  }
  return undefined;
}

function localFunctionBindings(callback: ts.FunctionLikeDeclaration): Map<string, ts.FunctionLikeDeclaration> {
  const bindings = new Map<string, ts.FunctionLikeDeclaration>();
  const visit = (node: ts.Node): void => {
    if (node !== callback && ts.isFunctionLike(node)) return;
    if (ts.isFunctionDeclaration(node) && node.name && node.body) bindings.set(node.name.text, node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(callback);
  return bindings;
}

function returnedCleanupFunctions(
  callback: ts.FunctionLikeDeclaration,
  bindings: ReadonlyMap<string, ts.FunctionLikeDeclaration>,
): ts.FunctionLikeDeclaration[] {
  const cleanups: ts.FunctionLikeDeclaration[] = [];
  const addExpression = (expression: ts.Expression | undefined): void => {
    if (!expression) return;
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) cleanups.push(expression);
    if (ts.isIdentifier(expression)) {
      const binding = bindings.get(expression.text);
      if (binding) cleanups.push(binding);
    }
  };
  if (callback.body && !ts.isBlock(callback.body)) addExpression(callback.body);
  const visit = (node: ts.Node): void => {
    if (node !== callback && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) addExpression(node.expression);
    if (ts.isYieldExpression(node)) addExpression(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(callback);
  return cleanups;
}

function injectionCleanupFunctions(callback: ts.ArrowFunction | ts.FunctionExpression): ts.FunctionLikeDeclaration[] {
  const bindings = localFunctionBindings(callback);
  const cleanups = returnedCleanupFunctions(callback, bindings);
  const visit = (node: ts.Node): void => {
    if (node !== callback && ts.isFunctionLike(node)) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'effect'
    ) {
      const factory = node.arguments[0];
      if (factory && (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) {
        cleanups.push(...returnedCleanupFunctions(factory, localFunctionBindings(factory)));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(callback);
  return [...new Set(cleanups)];
}

function identityPair(node: ts.BinaryExpression): readonly [string, string] | undefined {
  if (
    ![
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(node.operatorToken.kind) ||
    !ts.isIdentifier(node.left) ||
    !ts.isIdentifier(node.right)
  ) {
    return undefined;
  }
  return [node.left.text, node.right.text];
}

function containsBindingIdentity(node: ts.Node, target: string, binding: string, equality: boolean): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (ts.isBinaryExpression(candidate)) {
      const pair = identityPair(candidate);
      const pairMatches =
        pair !== undefined &&
        ((pair[0] === target && pair[1] === binding) || (pair[0] === binding && pair[1] === target));
      const isEquality = [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(
        candidate.operatorToken.kind,
      );
      if (pairMatches && isEquality === equality) found = true;
    }
    if (!found) ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

function identityGuardsClear(
  clear: ts.BinaryExpression,
  cleanup: ts.FunctionLikeDeclaration,
  target: string,
  binding: string,
): boolean {
  for (let current: ts.Node = clear; current.parent && current.parent !== cleanup; current = current.parent) {
    const parent = current.parent;
    if (ts.isIfStatement(parent)) {
      if (parent.thenStatement.pos <= clear.pos && clear.end <= parent.thenStatement.end) {
        return containsBindingIdentity(parent.expression, target, binding, true);
      }
      if (parent.elseStatement && parent.elseStatement.pos <= clear.pos && clear.end <= parent.elseStatement.end) {
        return containsBindingIdentity(parent.expression, target, binding, false);
      }
    }
    if (ts.isConditionalExpression(parent)) {
      if (parent.whenTrue.pos <= clear.pos && clear.end <= parent.whenTrue.end) {
        return containsBindingIdentity(parent.condition, target, binding, true);
      }
      if (parent.whenFalse.pos <= clear.pos && clear.end <= parent.whenFalse.end) {
        return containsBindingIdentity(parent.condition, target, binding, false);
      }
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right.pos <= clear.pos &&
      clear.end <= parent.right.end &&
      containsBindingIdentity(parent.left, target, binding, true)
    ) {
      return true;
    }
  }
  return false;
}

function injectionOwnership(callback: ts.ArrowFunction | ts.FunctionExpression): {
  ownsLifecycle: boolean;
  ownsStableBinding: boolean;
} {
  const cleanups = injectionCleanupFunctions(callback);
  const cleanupSet = new Set<ts.Node>(cleanups);
  let ownsLifecycle = !ts.isBlock(callback.body) || cleanups.length > 0;
  const assigned = new Map<string, string>();
  const visitActivation = (node: ts.Node): void => {
    if (node !== callback && ts.isFunctionLike(node)) return;
    if (cleanupSet.has(node)) return;
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      !(ts.isIdentifier(node.expression) && node.expression.text === 'undefined')
    ) {
      ownsLifecycle = true;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'effect'
    ) {
      ownsLifecycle = true;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      ts.isIdentifier(node.right) &&
      node.right.text !== 'undefined'
    ) {
      assigned.set(node.left.text, node.right.text);
    }
    ts.forEachChild(node, visitActivation);
  };
  visitActivation(callback.body);

  const ownsStableBinding = cleanups.some((cleanup) => {
    const clears = new Map<string, ts.BinaryExpression[]>();
    const visitCleanup = (node: ts.Node): void => {
      if (node !== cleanup && ts.isFunctionLike(node)) return;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        ts.isIdentifier(node.right) &&
        node.right.text === 'undefined'
      ) {
        const assignments = clears.get(node.left.text) ?? [];
        assignments.push(node);
        clears.set(node.left.text, assignments);
      }
      ts.forEachChild(node, visitCleanup);
    };
    visitCleanup(cleanup);
    return [...assigned].some(([target, binding]) =>
      (clears.get(target) ?? []).some((clear) => identityGuardsClear(clear, cleanup, target, binding)),
    );
  });
  return { ownsLifecycle: ownsLifecycle || ownsStableBinding, ownsStableBinding };
}

function namedCordisFunctions(units: readonly CordisSourceUnit[]): {
  readonly aliasesByFile: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly recordsByName: ReadonlyMap<string, readonly CordisFunctionRecord[]>;
} {
  const aliasesByFile = new Map<string, Map<string, string>>();
  const recordsByName = new Map<string, CordisFunctionRecord[]>();
  const addRecord = (name: string, node: ts.FunctionLikeDeclaration): void => {
    const records = recordsByName.get(name) ?? [];
    records.push({ name, node });
    recordsByName.set(name, records);
  };
  for (const { filePath, sourceFile } of units) {
    const aliases = new Map<string, string>();
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly) aliases.set(element.name.text, (element.propertyName ?? element.name).text);
          }
        }
      }
    }
    aliasesByFile.set(filePath, aliases);
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) addRecord(node.name.text, node);
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        addRecord(node.name.text, node.initializer);
      }
      if (ts.isClassDeclaration(node) && node.name) {
        const constructor = node.members.find(ts.isConstructorDeclaration);
        if (constructor) addRecord(node.name.text, constructor);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { aliasesByFile, recordsByName };
}

function ownedCordisScopes(units: readonly CordisSourceUnit[]): OwnedCordisScopes {
  const { aliasesByFile, recordsByName } = namedCordisFunctions(units);
  const owned = new Map<ts.FunctionLikeDeclaration, Set<string>>();
  const markParameter = (callback: ts.FunctionLikeDeclaration, index: number): boolean => {
    const parameter = callback.parameters[index];
    if (!parameter || !ts.isIdentifier(parameter.name)) return false;
    const names = owned.get(callback) ?? new Set<string>();
    const before = names.size;
    names.add(parameter.name.text);
    owned.set(callback, names);
    return names.size !== before;
  };
  const functionAncestors = (node: ts.Node): ts.FunctionLikeDeclaration[] => {
    const result: ts.FunctionLikeDeclaration[] = [];
    for (let current = node.parent; current; current = current.parent) {
      if (isFunctionWithBody(current)) result.push(current);
    }
    return result;
  };
  const isOwned = (expression: ts.Expression, use: ts.Node): boolean => {
    const unwrapped = expression;
    if (!ts.isIdentifier(unwrapped)) return false;
    return functionAncestors(use).some((scope) => owned.get(scope)?.has(unwrapped.text) === true);
  };
  const targetRecords = (filePath: string, expression: ts.Expression): readonly CordisFunctionRecord[] => {
    if (!ts.isIdentifier(expression)) return [];
    const imported = aliasesByFile.get(filePath)?.get(expression.text) ?? expression.text;
    return recordsByName.get(imported) ?? [];
  };

  // A callback passed to Context.plugin owns the context Cordis gives it.
  for (const { filePath, sourceFile } of units) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'plugin'
      ) {
        const callback = node.arguments[0];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) markParameter(callback, 0);
        else if (callback && ts.isExpression(callback)) {
          for (const { node: target } of targetRecords(filePath, callback)) markParameter(target, 0);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const { filePath, sourceFile } of units) {
      const visit = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          isOwned(node.initializer, node)
        ) {
          const scope = ts.findAncestor(node, (candidate): candidate is FunctionWithBody =>
            isFunctionWithBody(candidate),
          );
          if (scope) {
            const names = owned.get(scope) ?? new Set<string>();
            const before = names.size;
            names.add(node.name.text);
            owned.set(scope, names);
            changed ||= names.size !== before;
          }
        }
        if (ts.isCallExpression(node)) {
          if (
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'inject' &&
            isOwned(node.expression.expression, node)
          ) {
            const callback = node.arguments[1];
            if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
              changed = markParameter(callback, 0) || changed;
            } else if (callback && ts.isExpression(callback)) {
              for (const { node: target } of targetRecords(filePath, callback)) {
                changed = markParameter(target, 0) || changed;
              }
            }
          }
          if (ts.isIdentifier(node.expression)) {
            const targets = targetRecords(filePath, node.expression);
            for (const { node: target } of targets) {
              node.arguments.forEach((argument, index) => {
                if (ts.isExpression(argument) && isOwned(argument, node)) {
                  changed = markParameter(target, index) || changed;
                }
              });
            }
          }
        }
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
          for (const { node: target } of targetRecords(filePath, node.expression)) {
            node.arguments?.forEach((argument, index) => {
              if (isOwned(argument, node)) changed = markParameter(target, index) || changed;
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }
  return owned;
}

function isOwnedCordisExpression(expression: ts.Expression, use: ts.Node, owned: OwnedCordisScopes): boolean {
  if (!ts.isIdentifier(expression)) return false;
  for (let current = use.parent; current; current = current.parent) {
    if (isFunctionWithBody(current) && owned.get(current)?.has(expression.text)) {
      return true;
    }
  }
  return false;
}

function methodName(expression: ts.LeftHandSideExpression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return undefined;
}

function methodReceiver(expression: ts.LeftHandSideExpression): ts.Expression | undefined {
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    ? expression.expression
    : undefined;
}

function isAccessorDefinition(node: ts.Node): boolean {
  const owner = ts.findAncestor(node, ts.isFunctionLike);
  if (!owner) return false;
  if (ts.isFunctionDeclaration(owner) && owner.name) return /^(?:read|require)(?:Doom|Minor)/.test(owner.name.text);
  const declaration = owner.parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    /^(?:read|require)(?:Doom|Minor)/.test(declaration.name.text)
  );
}

function isDirectInjectionUse(node: ts.Node, injection: CordisInjectionFact): boolean {
  for (let current = node.parent; current && current !== injection.callback; current = current.parent) {
    if (ts.isFunctionLike(current)) return false;
  }
  return injection.callback.pos <= node.pos && node.end <= injection.callback.end;
}

function cordisServiceFacts(
  filePath: string,
  sourceFile: ts.SourceFile,
  configRoot: string,
  owned: OwnedCordisScopes,
): CordisServiceFacts {
  const { requiredHelpers, serviceConstants } = cordisImportBindings(sourceFile);
  const injections: CordisInjectionFact[] = [];
  const invalidProviders: string[] = [];
  const uses: CordisServiceUse[] = [];
  const collectInjections = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const method = methodName(node.expression);
      if (method) {
        const firstArgument = node.arguments[0];
        if (method === 'inject' && ts.isArrayLiteralExpression(firstArgument)) {
          const callback = node.arguments[1];
          if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
            const services = new Set(
              firstArgument.elements.flatMap((element) =>
                ts.isExpression(element) ? (cordisServiceExpression(element, serviceConstants) ?? []) : [],
              ),
            );
            const ownership = injectionOwnership(callback);
            injections.push({ callback, services, ...ownership });
          }
        }
      }
    }
    ts.forEachChild(node, collectInjections);
  };
  collectInjections(sourceFile);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        const service = requiredHelpers.get(node.expression.text);
        if (service) {
          uses.push({
            service,
            filePath,
            position: node.getStart(sourceFile),
            directlyOwned: injections.some(
              (injection) => injection.services.has(service) && isDirectInjectionUse(node, injection),
            ),
          });
        }
      }
      const method = methodName(node.expression);
      const receiver = methodReceiver(node.expression);
      if (method && receiver) {
        const service = cordisServiceExpression(node.arguments[0], serviceConstants);
        if (method === 'get' && service && !isAccessorDefinition(node)) {
          uses.push({
            service,
            filePath,
            position: node.getStart(sourceFile),
            directlyOwned: injections.some(
              (injection) => injection.services.has(service) && isDirectInjectionUse(node, injection),
            ),
          });
        }
        if (method === 'provide' && service && !isOwnedCordisExpression(receiver, node, owned)) {
          invalidProviders.push(
            `${service} is provided outside a mounted plugin or injection-owned context at ${projectPath(filePath, configRoot) ?? filePath}`,
          );
        }
      }
      if (node.expression.kind === ts.SyntaxKind.SuperKeyword) {
        const context = node.arguments[0];
        for (const argument of node.arguments.slice(1)) {
          const service = cordisServiceExpression(argument, serviceConstants);
          if (service && (!context || !isOwnedCordisExpression(context, node, owned))) {
            invalidProviders.push(
              `${service} Service is constructed outside a mounted plugin or injection-owned context`,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { injections, invalidProviders, uses };
}

function cordisServiceInjectionViolations(configRoot: string): string[] {
  const units = productionSourceFiles(configRoot).flatMap((filePath) => {
    const sourceFile = readSource(filePath);
    return sourceFile ? [{ filePath, sourceFile }] : [];
  });
  const owned = ownedCordisScopes(units);
  const facts = units.map(({ filePath, sourceFile }) => cordisServiceFacts(filePath, sourceFile, configRoot, owned));
  const injections = facts.flatMap((fact) => fact.injections);
  const violations = new Map<string, Set<string>>();
  for (const invalidProvider of facts.flatMap((fact) => fact.invalidProviders)) {
    violations.set(invalidProvider, new Set());
  }
  for (const use of facts.flatMap((fact) => fact.uses)) {
    const localInjection = injections.find(
      (injection) =>
        injection.ownsLifecycle &&
        injection.services.has(use.service) &&
        use.directlyOwned &&
        injection.callback.getSourceFile().fileName === use.filePath &&
        injection.callback.getStart() <= use.position &&
        use.position < injection.callback.getEnd(),
    );
    if (localInjection) continue;
    const stableInjection = injections.some(
      (injection) => injection.ownsStableBinding && injection.services.has(use.service),
    );
    if (stableInjection) continue;
    const reason = injections.some((injection) => injection.services.has(use.service))
      ? 'does not establish and clear an active binding for stable Pi wrappers'
      : 'has no owning ctx.inject dependency';
    const files = violations.get(`${use.service} ${reason}`) ?? new Set<string>();
    files.add(projectPath(use.filePath, configRoot) ?? use.filePath);
    violations.set(`${use.service} ${reason}`, files);
  }
  return [...violations.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([message, files]) => (files.size > 0 ? `${message}: ${[...files].sort().join(', ')}` : message));
}

function sourcePathForStem(stem: string): string | null {
  if (SOURCE_EXTENSIONS.has(path.extname(stem))) return fs.existsSync(stem) ? stem : null;
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${stem}${extension}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function defaultFactorySpecifiers(sourceFile: ts.SourceFile): string[] {
  const defaultLocals = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      defaultLocals.add(statement.expression.text);
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text === 'default' && element.propertyName) defaultLocals.add(element.propertyName.text);
      }
    }
  }

  const specifiers = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      (!ts.isExportDeclaration(statement) && !ts.isImportDeclaration(statement)) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      if (statement.exportClause.elements.some((element) => element.name.text === 'default')) {
        specifiers.add(statement.moduleSpecifier.text);
      }
      continue;
    }
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause?.name && defaultLocals.has(clause.name.text)) specifiers.add(statement.moduleSpecifier.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      if (clause.namedBindings.elements.some((element) => defaultLocals.has(element.name.text))) {
        specifiers.add(statement.moduleSpecifier.text);
      }
    }
  }
  return [...specifiers];
}

function publicFeatureAdapterPaths(configRoot: string, manifest: DoomPackageManifest): string[] {
  const facadeStems = new Set(piDiscoveryEntryStems(configRoot));
  if (manifest.exports && typeof manifest.exports === 'object' && !Array.isArray(manifest.exports)) {
    for (const subpath of Object.keys(manifest.exports)) {
      if (subpath.startsWith('./extensions/')) facadeStems.add(subpath.slice(2));
    }
  }

  const adapters = new Set<string>();
  for (const facadeStem of facadeStems) {
    const facadePath = sourcePathForStem(path.join(configRoot, 'src', 'exports', facadeStem));
    if (!facadePath) continue;
    const facade = readSource(facadePath);
    if (!facade) continue;
    const facadeMount = cordisFeatureMount(facade);
    if (facadeMount.connectionCount > 0 || facadeMount.rootPluginCount > 0) adapters.add(facadePath);

    for (const specifier of defaultFactorySpecifiers(facade)) {
      if (!specifier.startsWith('.')) continue;
      const target = sourcePathForStem(path.resolve(path.dirname(facadePath), specifier));
      if (!target) continue;
      const relativeTarget = projectPath(target, configRoot);
      if (relativeTarget?.startsWith('src/adapters/pi/')) adapters.add(target);
    }
  }
  return [...adapters].sort();
}

function usesCordisReflection(sourceFile: ts.SourceFile): boolean {
  const contextTypeAliases = new Set<string>();
  const cordisNamespaces = new Set<string>();
  const connectorAliases = cordisHostConnectorNames(sourceFile);
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@deepseek-ai/cordis'
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) cordisNamespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === 'Context') contextTypeAliases.add(element.name.text);
      }
    }
  }

  const contexts = new Set<string>();
  const connections = new Set<string>();
  const hasContextType = (node: ts.TypeNode | undefined): boolean => {
    if (!node) return false;
    if (ts.isTypeReferenceNode(node)) {
      const typeName = node.typeName;
      return (
        (ts.isIdentifier(typeName) && contextTypeAliases.has(typeName.text)) ||
        (ts.isQualifiedName(typeName) &&
          typeName.right.text === 'Context' &&
          ts.isIdentifier(typeName.left) &&
          cordisNamespaces.has(typeName.left.text))
      );
    }
    return ts.isParenthesizedTypeNode(node) && hasContextType(node.type);
  };
  const unwrapped = (node: ts.Expression): ts.Expression => {
    let current = node;
    while (
      ts.isAwaitExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };
  const isConnectorCall = (node: ts.Expression): boolean => {
    const expression = unwrapped(node);
    return (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      connectorAliases.has(expression.expression.text)
    );
  };
  const isConnectionRoot = (node: ts.Expression): boolean => {
    const expression = unwrapped(node);
    return (
      (ts.isPropertyAccessExpression(expression) &&
        expression.name.text === 'root' &&
        ts.isIdentifier(expression.expression) &&
        connections.has(expression.expression.text)) ||
      (ts.isElementAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        connections.has(expression.expression.text) &&
        expression.argumentExpression !== undefined &&
        ts.isStringLiteralLike(expression.argumentExpression) &&
        expression.argumentExpression.text === 'root')
    );
  };
  const isContextExpression = (node: ts.Expression): boolean => {
    const expression = unwrapped(node);
    if (ts.isIdentifier(expression)) return contexts.has(expression.text);
    if (isConnectionRoot(expression)) return true;
    return (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text === 'root' &&
      isContextExpression(expression.expression)
    );
  };

  let changed = true;
  while (changed) {
    changed = false;
    const add = (set: Set<string>, name: string): void => {
      if (!set.has(name)) {
        set.add(name);
        changed = true;
      }
    };
    const visitBindings = (node: ts.Node): void => {
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && hasContextType(node.type)) {
        add(contexts, node.name.text);
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) {
          if (isConnectorCall(node.initializer)) add(connections, node.name.text);
          if (hasContextType(node.type) || isContextExpression(node.initializer)) add(contexts, node.name.text);
        }
        if (ts.isObjectBindingPattern(node.name)) {
          const initializer = unwrapped(node.initializer);
          if (ts.isIdentifier(initializer) && connections.has(initializer.text)) {
            for (const element of node.name.elements) {
              const property = element.propertyName ?? element.name;
              if (
                ts.isIdentifier(element.name) &&
                ((ts.isIdentifier(property) && property.text === 'root') ||
                  (ts.isStringLiteralLike(property) && property.text === 'root'))
              ) {
                add(contexts, element.name.text);
              }
            }
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        if (isConnectorCall(node.right)) add(connections, node.left.text);
        if (isContextExpression(node.right)) add(contexts, node.left.text);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'inject' &&
        isContextExpression(node.expression.expression)
      ) {
        const callback = node.arguments[1];
        if (
          callback &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
          callback.parameters[0] &&
          ts.isIdentifier(callback.parameters[0].name)
        ) {
          add(contexts, callback.parameters[0].name.text);
        }
      }
      ts.forEachChild(node, visitBindings);
    };
    visitBindings(sourceFile);
  }

  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === 'reflect' && isContextExpression(node.expression)) ||
      (ts.isElementAccessExpression(node) &&
        isContextExpression(node.expression) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'reflect')
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function normalizedParts(filePath: string): string[] {
  return filePath.split(path.sep).filter(Boolean);
}

function sourceRoot(filePath: string): string | undefined {
  const parts = normalizedParts(filePath);
  const sourceIndex = parts.lastIndexOf('src');
  return sourceIndex >= 0 ? parts[sourceIndex + 1] : undefined;
}

/**
 * A type-only import is erased at build time. It imposes no runtime dependency
 * and leaves the module independently constructible, so it does not count
 * against a boundary that exists to protect runtime independence.
 */
function isTypeOnlyImport(node: ts.Node): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    return (
      clause?.isTypeOnly === true ||
      (clause?.namedBindings !== undefined &&
        clause.name === undefined &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly))
    );
  }
  return ts.isExportDeclaration(node) && node.isTypeOnly;
}

function collectRuntimeSpecifiers(sourceFile: ts.SourceFile): string[] {
  return collectSpecifiers(sourceFile, { runtimeOnly: true });
}

function collectSpecifiers(sourceFile: ts.SourceFile, options?: { runtimeOnly?: boolean }): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      !(options?.runtimeOnly === true && isTypeOnlyImport(node))
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function collectStringLiterals(sourceFile: ts.SourceFile): string[] {
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) values.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return values;
}

function collectObjectStrings(value: unknown, includeKeys = false): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => collectObjectStrings(entry, includeKeys));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    ...(includeKeys ? [key] : []),
    ...collectObjectStrings(entry, includeKeys),
  ]);
}

function collectObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectObjectKeys);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) => [key, ...collectObjectKeys(entry)]);
}

function packageNameFromSpecifier(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function startsWithAny(value: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function isFeaturePackage(packageName: string, options: CleanArchitectureOptions): boolean {
  return (
    startsWithAny(packageName, options.featurePackagePrefixes) &&
    !options.fixedCorePackages.includes(packageName) &&
    !options.infrastructurePackages.includes(packageName)
  );
}

function isFoundationPackage(packageName: string, options: CleanArchitectureOptions): boolean {
  return (
    options.foundationPackages.includes(packageName) || startsWithAny(packageName, options.foundationPackagePrefixes)
  );
}

function isCompositionPath(relativePath: string, options: CleanArchitectureOptions): boolean {
  if (options.compositionPaths.includes(relativePath)) return true;
  const fileName = path.posix.basename(relativePath).replace(/\.(?:cts|mts|ts|tsx)$/, '');
  return /(?:composition|composer|extensionassembler|runtimebundle|syncedruntimebuilder)/i.test(fileName);
}

function normalizedIdentifier(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isFixedFeatureIdentifier(value: string, options: CleanArchitectureOptions): boolean {
  const normalized = normalizedIdentifier(value);
  const configured = new Set(options.fixedFeatureIdentifiers.map(normalizedIdentifier));
  if (configured.has(normalized)) return true;
  return /^(?:fixed)?feature(?:name|package|extension)?(?:declarations?|factories|map|names?|packages?|slots?)$/.test(
    normalized,
  );
}

function collectForbiddenIdentifiers(sourceFile: ts.SourceFile, options: CleanArchitectureOptions): string[] {
  const identifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isFixedFeatureIdentifier(node.text, options)) identifiers.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...identifiers].sort();
}

function isForbiddenAbiReference(value: string): boolean {
  return PUBLIC_ABI_REFERENCE_PATTERN.test(value.replaceAll('\\', '/'));
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
}

function exportedDeclarationNames(sourceFile: ts.SourceFile): string[] {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add(element.name.text);
      continue;
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      names.add(statement.expression.text);
      continue;
    }
    const exported =
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) names.add(name);
      }
      continue;
    }
    if (
      (ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isModuleDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    }
  }
  return [...names].sort();
}

function publicSourcePath(relativePath: string): boolean {
  return /^src\/(?:index|exports\/)/.test(relativePath);
}

function publicSourceAbiReferences(sourceFile: ts.SourceFile): string[] {
  const references = collectSpecifiers(sourceFile).filter(isForbiddenAbiReference);
  references.push(...exportedDeclarationNames(sourceFile).filter((name) => PUBLIC_ABI_NAME_PATTERN.test(name)));
  return [...new Set(references)].sort();
}

function sourceTargetExists(configRoot: string, stem: string): boolean {
  for (const prefix of ['src/', 'src/exports/']) {
    for (const extension of SOURCE_TARGET_EXTENSIONS) {
      if (fs.existsSync(path.join(configRoot, `${prefix}${stem}${extension}`))) return true;
    }
  }
  return false;
}

function validPiTarget(target: string): boolean {
  if (!VALID_PI_TARGET_PATTERN.test(target) || target.includes('\\')) return false;
  return !target
    .slice(2)
    .split('/')
    .some((segment) => segment === '.' || segment === '..');
}

function requiresPiEntry(manifest: ArchitectureManifest, options: CleanArchitectureOptions): boolean {
  const packageName = manifest.name;
  if (!packageName) return manifest.pi !== undefined;
  if (options.nonPiPackages.includes(packageName) || startsWithAny(packageName, options.nonPiPackagePrefixes)) {
    return false;
  }
  return manifest.pi !== undefined || startsWithAny(packageName, options.piPackagePrefixes);
}

function piTargetViolations(
  manifest: ArchitectureManifest,
  configRoot: string,
  options: CleanArchitectureOptions,
): string[] {
  if (!requiresPiEntry(manifest, options)) return [];
  const configured = manifest.pi?.extensions;
  if (!Array.isArray(configured) || configured.length === 0) {
    return ['package.json must declare a non-empty pi.extensions array'];
  }

  const violations: string[] = [];
  for (const target of configured) {
    if (typeof target !== 'string' || !validPiTarget(target)) {
      violations.push(`invalid pi.extensions target ${JSON.stringify(target)}`);
      continue;
    }
    if (LEGACY_DOOM_ENTRY_PATTERN.test(target)) {
      violations.push(`legacy Doom Pi target ${target}`);
      continue;
    }
    const stem = runtimeStem(target);
    if (!stem || !sourceTargetExists(configRoot, stem)) {
      violations.push(`pi.extensions target has no source entry: ${target}`);
    }
  }
  return violations;
}

function dependencyNames(manifest: ArchitectureManifest): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ];
}

/**
 * Directory-level check of the source vocabulary.
 *
 * doom-folder-layout only sees files, so a root that is empty, or one whose
 * files are all pure re-exports, slips past it. An empty `src/tool` left behind
 * by a migration is invisible to every file-based rule but still shows up as
 * package structure to anyone reading the tree. This runs once per package, off
 * package.json, and reads the directory listing directly.
 */
function sourceRootVocabularyViolations(configRoot: string): string[] {
  const sourceDirectory = path.join(configRoot, 'src');
  if (!fs.existsSync(sourceDirectory)) return [];

  const offenders: string[] = [];
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        offenders.push(`loose source file src/${entry.name}`);
      }
      continue;
    }
    if (CANONICAL_ROOTS.has(entry.name) || RESOURCE_ROOTS.has(entry.name) || TRANSITIONAL_ROOTS.has(entry.name)) {
      continue;
    }
    const empty = fs.readdirSync(path.join(sourceDirectory, entry.name)).length === 0;
    offenders.push(empty ? `empty leftover root src/${entry.name}` : `noncanonical root src/${entry.name}`);
  }
  return offenders.length > 0 ? [`source vocabulary: ${offenders.sort().join('; ')}`] : [];
}

function packageManifestViolations(
  manifest: ArchitectureManifest,
  configRoot: string,
  options: CleanArchitectureOptions,
): string[] {
  const violations: string[] = [];
  const serialized = JSON.stringify(manifest) ?? '';
  if (serialized.includes(CAPABILITIES_PACKAGE_FRAGMENT)) {
    violations.push('doompi-capabilities must not be declared or referenced');
  }

  const exportReferences = collectObjectStrings(manifest.exports, true);
  const legacyExports = exportReferences.filter((reference) => LEGACY_DOOM_ENTRY_PATTERN.test(reference));
  if (legacyExports.length > 0) violations.push(`legacy extensions/doom export: ${legacyExports.join(', ')}`);
  // Pi's factory signature has no Context parameter, so this one versioned
  // contracts-owned bootstrap is the intentional exception to the public ABI
  // ban. Feature packages may consume it but may not publish a competing host.
  const forbiddenAbi = exportReferences.filter(
    (reference) =>
      isForbiddenAbiReference(reference) &&
      !(manifest.name === CORDIS_CONTRACTS_PACKAGE && reference === './cordis-host'),
  );
  if (forbiddenAbi.length > 0) violations.push(`public native/Cordis ABI export: ${forbiddenAbi.join(', ')}`);

  if (manifest.name && isFoundationPackage(manifest.name, options)) {
    const featureDependencies = dependencyNames(manifest).filter((name) => isFeaturePackage(name, options));
    const fixedDeclarations = collectObjectKeys(manifest).filter((name) => isFixedFeatureIdentifier(name, options));
    if (featureDependencies.length > 0) {
      violations.push(`foundation package declares feature dependencies: ${featureDependencies.join(', ')}`);
    }
    if (fixedDeclarations.length > 0) {
      violations.push(`foundation package declares fixed features: ${fixedDeclarations.join(', ')}`);
    }
  }

  violations.push(...undeclaredFixedCoreViolations(manifest, configRoot, options));
  violations.push(...piTargetViolations(manifest, configRoot, options));
  violations.push(...sourceRootVocabularyViolations(configRoot));
  return violations;
}

/**
 * The host resolves fixed core entries with import.meta.resolve, so a fixed core
 * package it does not declare works in the workspace, where pnpm links every
 * sibling, and fails only once the tarball is installed somewhere else. Only
 * packages that exist beside this one are required: the list also names packages
 * a migration has not created yet.
 */
function undeclaredFixedCoreViolations(
  manifest: ArchitectureManifest,
  configRoot: string,
  options: CleanArchitectureOptions,
): string[] {
  if (!manifest.name || !options.compositionPackages.includes(manifest.name)) return [];
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  const missing = options.fixedCorePackages
    .filter((name) => name !== manifest.name && !declared.has(name))
    .filter((name) => siblingPackageExists(configRoot, name))
    .sort();
  return missing.length > 0 ? [`fixed core packages missing from dependencies: ${missing.join(', ')}`] : [];
}

function siblingPackageExists(configRoot: string, packageName: string): boolean {
  const directory = packageName.split('/').pop();
  if (!directory) return false;
  const manifestPath = path.join(path.dirname(configRoot), directory, PACKAGE_MANIFEST_PATH);
  return readPackageManifest(path.dirname(manifestPath))?.name === packageName;
}

function sourceArchitectureViolations(
  relativePath: string,
  sourceFile: ts.SourceFile,
  manifest: ArchitectureManifest,
  options: CleanArchitectureOptions,
): string[] {
  const violations: string[] = [];
  const packageName = manifest.name ?? '';
  const specifiers = collectSpecifiers(sourceFile);
  // Only shipped source is checked: the packaging guard that bans this fragment
  // from tarballs has to name it, and that guard lives under tests.
  const capabilityReferences = relativePath.startsWith('src/')
    ? collectStringLiterals(sourceFile).filter((value) => value.includes(CAPABILITIES_PACKAGE_FRAGMENT))
    : [];
  if (capabilityReferences.length > 0) violations.push('doompi-capabilities must not be referenced');

  if (relativePath.startsWith('src/') && options.compositionPackages.includes(packageName)) {
    if (isCompositionPath(relativePath, options)) {
      const featureImports = specifiers
        .map(packageNameFromSpecifier)
        .filter((specifier) => isFeaturePackage(specifier, options));
      if (featureImports.length > 0) {
        violations.push(`DoomPi composition imports feature packages: ${[...new Set(featureImports)].join(', ')}`);
      }
    }
    const fixedIdentifiers = collectForbiddenIdentifiers(sourceFile, options);
    if (fixedIdentifiers.length > 0) {
      violations.push(`DoomPi composition contains fixed feature maps or slots: ${fixedIdentifiers.join(', ')}`);
    }
  }

  if (relativePath.startsWith('src/') && isFoundationPackage(packageName, options)) {
    const featureImports = specifiers
      .map(packageNameFromSpecifier)
      .filter((specifier) => isFeaturePackage(specifier, options));
    const declarations = collectForbiddenIdentifiers(sourceFile, options);
    if (featureImports.length > 0) {
      violations.push(`foundation package imports feature packages: ${[...new Set(featureImports)].join(', ')}`);
    }
    if (declarations.length > 0) {
      violations.push(`foundation package declares fixed features: ${declarations.join(', ')}`);
    }
  }

  if (publicSourcePath(relativePath)) {
    const abiReferences = publicSourceAbiReferences(sourceFile);
    if (abiReferences.length > 0) {
      violations.push(`public source exports native/Cordis ABI: ${abiReferences.join(', ')}`);
    }
  }

  if (TSDOWN_CONFIG_PATTERN.test(relativePath)) {
    const buildEntries = collectStringLiterals(sourceFile).filter((entry) => SOURCE_BUILD_ENTRY_PATTERN.test(entry));
    const legacyEntries = buildEntries.filter((entry) => LEGACY_DOOM_ENTRY_PATTERN.test(entry));
    const abiEntries = buildEntries.filter(isForbiddenAbiReference);
    if (legacyEntries.length > 0) violations.push(`legacy extensions/doom build entry: ${legacyEntries.join(', ')}`);
    if (abiEntries.length > 0) violations.push(`public native/Cordis build entry: ${abiEntries.join(', ')}`);
  }

  return violations;
}

function containsRuntimeSchema(node: ts.Node): boolean {
  if (
    ts.isCallExpression(node) &&
    ((ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      ['Type', 'z'].includes(node.expression.expression.text) &&
      node.expression.name.text !== 'toJSONSchema') ||
      (ts.isIdentifier(node.expression) && ['Type', 'z'].includes(node.expression.text)))
  ) {
    return true;
  }
  return node.getChildren().some(containsRuntimeSchema);
}

export function isPureReExportModule(sourceFile: ts.SourceFile): boolean {
  return (
    sourceFile.statements.length > 0 &&
    sourceFile.statements.every(
      (statement) => ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined,
    )
  );
}

function relativeImportRoot(filePath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  return sourceRoot(path.resolve(path.dirname(filePath), specifier));
}

/**
 * The Pi adapter subtree is the package's composition root: the host hands it a
 * single registration call, so it is the one place under adapters that
 * legitimately reaches across commands and TUI to wire them together. Without
 * this exemption every package restates the same per-file override.
 */
function isCompositionAdapter(
  filePath: string,
  configRoot: string,
  options: Readonly<RuleOptions> | undefined,
): boolean {
  const relativePath = projectPath(filePath, configRoot);
  if (!relativePath) return false;
  return stringListOption(options, 'compositionAdapterRoots', DEFAULT_COMPOSITION_ADAPTER_ROOTS).some(
    (root) => relativePath === root || relativePath.startsWith(`${root}/`),
  );
}

export const doomFolderLayout: RuleDefinition = {
  preflight: true,
  rule: 'Doom source modules use the canonical root vocabulary, with src/exports as the public boundary',
  rationale: 'One predictable folder vocabulary makes package boundaries navigable and mechanically enforceable.',
  check(filePath) {
    const root = sourceRoot(filePath);
    if (
      !root ||
      root === 'index.ts' ||
      CANONICAL_ROOTS.has(root) ||
      RESOURCE_ROOTS.has(root) ||
      TRANSITIONAL_ROOTS.has(root)
    ) {
      return null;
    }
    const sourceFile = readSource(filePath);
    if (sourceFile && isPureReExportModule(sourceFile)) return null;
    const detail = FORBIDDEN_ROOTS.has(root)
      ? `Legacy root "${root}" must be a forwarding wrapper during migration.`
      : `Unknown root "${root}" is not canonical.`;
    return `${detail} Move implementation under exports, types, schemas, services, adapters, commands, container, or tui. Put Help resources under prompts.`;
  },
};

/** @deprecated Remove after all Doom packages enable public-export-boundary. */
export const compatibilityWrapperOnly: RuleDefinition = {
  preflight: true,
  rule: 'Noncanonical compatibility modules contain forwarding exports only during migration',
  rationale: 'Compatibility paths may remain public temporarily without becoming a second implementation architecture.',
  check(filePath) {
    const root = sourceRoot(filePath);
    if (
      !root ||
      root === 'index.ts' ||
      CANONICAL_ROOTS.has(root) ||
      RESOURCE_ROOTS.has(root) ||
      TRANSITIONAL_ROOTS.has(root)
    ) {
      return null;
    }
    const sourceFile = readSource(filePath);
    return sourceFile && !isPureReExportModule(sourceFile)
      ? 'Noncanonical public paths must contain only re-exports from canonical modules during migration.'
      : null;
  },
};

export const publicExportBoundary: RuleDefinition = {
  preflight: true,
  rule: 'Pure forwarding modules may exist only under src/exports',
  rationale:
    'A single manifest-facing boundary keeps compatibility facades from becoming a parallel internal architecture.',
  check(filePath) {
    const sourceFile = readSource(filePath);
    if (!sourceFile || !isPureReExportModule(sourceFile) || sourceRoot(filePath) === 'exports') return null;
    return 'Move this public facade under src/exports and import its canonical implementation directly everywhere else.';
  },
};

export const noInternalPublicImport: RuleDefinition = {
  preflight: true,
  rule: 'Implementation modules never import src/exports or their own package public subpaths',
  rationale:
    'Internal code should depend on canonical implementations rather than cycling through compatibility facades.',
  check(filePath, configRoot) {
    const root = sourceRoot(filePath);
    if (!root || root === 'exports') return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile) return null;
    const packageName = readPackageManifest(configRoot)?.name;
    const blocked = collectSpecifiers(sourceFile).filter((specifier) => {
      if (relativeImportRoot(filePath, specifier) === 'exports') return true;
      return packageName !== undefined && (specifier === packageName || specifier.startsWith(`${packageName}/`));
    });
    const uniqueBlocked = [...new Set(blocked)];
    return uniqueBlocked.length > 0
      ? `Implementation imports public package facades: ${uniqueBlocked.join(', ')}`
      : null;
  },
};

export const doomLayerBoundary: RuleDefinition = {
  preflight: true,
  rule: 'Canonical Doom layers point inward through types, schemas, services, adapters, and composition roots',
  rationale: 'A small universal dependency direction prevents host and presentation concerns from leaking into policy.',
  check(filePath, configRoot, context) {
    const root = sourceRoot(filePath);
    const allowedRoots = root ? ALLOWED_ROOT_DEPENDENCIES[root] : undefined;
    if (!root || !allowedRoots) return null;
    if (isCompositionAdapter(filePath, configRoot, context?.options)) return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile || isPureReExportModule(sourceFile)) return null;
    const blocked = collectRuntimeSpecifiers(sourceFile).filter((specifier) => {
      const targetRoot = relativeImportRoot(filePath, specifier);
      return targetRoot !== undefined && !allowedRoots.has(targetRoot);
    });
    const uniqueBlocked = [...new Set(blocked)];
    return uniqueBlocked.length > 0 ? `Layer imports forbidden dependencies: ${uniqueBlocked.join(', ')}` : null;
  },
};

const RELATIVE_IMPORT_EXTENSION = /\.(?:cts|js|mjs|mts|ts|tsx)$/;
const BARREL_INDEX_SUFFIX = /\/index$/;

export const cleanImportPath: RuleDefinition = {
  preflight: true,
  rule: 'Relative imports carry no file extension and no /index suffix',
  rationale:
    'One module has one spelling. Extensions and explicit /index give the same file several import paths, so moving or barrelling it silently leaves both forms behind and deduplication, refactoring, and go-to-definition all degrade.',
  check(filePath) {
    const sourceFile = readSource(filePath);
    if (!sourceFile) return null;
    const offenders = collectSpecifiers(sourceFile).filter((specifier) => {
      if (!specifier.startsWith('.')) return false;
      const withoutExtension = specifier.replace(RELATIVE_IMPORT_EXTENSION, '');
      return RELATIVE_IMPORT_EXTENSION.test(specifier) || BARREL_INDEX_SUFFIX.test(withoutExtension);
    });
    const unique = [...new Set(offenders)];
    return unique.length > 0 ? `Drop the extension and any /index suffix: ${unique.join(', ')}` : null;
  },
};

const PORT_NAME_PATTERN = /^I[A-Z]/;

/** Strip the scope and the distribution prefix: @agimon-ai/doompi-voice -> voice. */
function packageTopic(packageName: string | undefined): string | undefined {
  if (!packageName) return undefined;
  const bare = packageName.split('/').pop();
  return bare?.replace(/^doompi-?/, '') || undefined;
}

function normalizedName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Ambient reads a service cannot be given by its caller. Each is reachable
 * without an import, so no import-based rule can see them.
 */
const AMBIENT_MEMBER_READS: Readonly<Record<string, readonly string[]>> = {
  Date: ['now'],
  Math: ['random'],
  performance: ['now'],
  process: ['argv', 'cwd', 'env', 'hrtime', 'pid', 'platform', 'uptime'],
};
const AMBIENT_CALLS = new Set(['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask']);

export const noAmbientHostAccess: RuleDefinition = {
  preflight: true,
  rule: 'Services take time, randomness, and process state as dependencies rather than reading them ambiently',
  rationale:
    'Date.now(), Math.random(), the timer functions and process.* need no import, so the import-based boundaries cannot see them. A service that reads one is no longer a function of its arguments: the same call gives a different answer on a different day or machine, and a test can only pin it by patching a global. Take a clock, an id factory, or the environment as a parameter, and the impurity moves to the adapter that already owns it.',
  check(filePath) {
    if (sourceRoot(filePath) !== 'services') return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile || isPureReExportModule(sourceFile)) return null;

    const found = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const members = AMBIENT_MEMBER_READS[node.expression.text];
        if (members?.includes(node.name.text)) found.add(`${node.expression.text}.${node.name.text}`);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && AMBIENT_CALLS.has(node.expression.text)) {
        found.add(`${node.expression.text}()`);
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date') {
        if ((node.arguments?.length ?? 0) === 0) found.add('new Date()');
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    return found.size > 0
      ? `Service reads ambient host state: ${[...found].sort().join(', ')}. Take it as a dependency instead.`
      : null;
  },
};

export const flatServiceLayout: RuleDefinition = {
  preflight: true,
  rule: 'src/services is flat unless it holds several genuinely separate domains',
  rationale:
    'A package already names its subject, so src/services/<subject> restates it and every import pays for a level that separates nothing. A lone subdirectory is the same thing in a different shape: with no sibling to distinguish it from, the folder is not grouping, it is indirection. Group under services only where two or more domains actually need telling apart.',
  check(filePath, configRoot) {
    if (projectPath(filePath, configRoot) !== PACKAGE_MANIFEST_PATH) return null;
    const servicesDirectory = path.join(configRoot, 'src', 'services');
    if (!fs.existsSync(servicesDirectory)) return null;

    const entries = fs.readdirSync(servicesDirectory, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const files = entries.filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)));
    if (directories.length === 0) return null;

    const topic = packageTopic(readPackageManifest(configRoot)?.name);
    const restating = topic
      ? directories.filter((directory) => normalizedName(directory) === normalizedName(topic))
      : [];
    if (restating.length > 0) {
      return `src/services/${restating[0]} restates the package subject. Move its modules up into src/services.`;
    }
    if (directories.length === 1 && files.length === 0) {
      return `src/services/${directories[0]} is the only thing under src/services, so the folder groups nothing. Move its modules up into src/services.`;
    }
    return null;
  },
};

export const portsDeclaredInTypes: RuleDefinition = {
  preflight: true,
  rule: 'Ports are declared in src/types; src/adapters holds only their implementations',
  rationale:
    'A port is the interface the core needs, expressed in the core vocabulary; an adapter is one technology that satisfies it. That is what makes the dependency point inward. Declaring the port inside the adapter folder inverts it back: services may not import adapters, so a service can no longer depend on the capability at all, and the only way to use it becomes moving the caller out to the adapter layer too. The folder keeps the name without the property that earns it.',
  check(filePath) {
    if (sourceRoot(filePath) !== 'adapters') return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile) return null;

    const ports = sourceFile.statements
      .filter(
        (statement) =>
          (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
          ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true &&
          PORT_NAME_PATTERN.test(statement.name.text),
      )
      .map((statement) => (statement as ts.InterfaceDeclaration).name.text);

    return ports.length > 0
      ? `Move ${ports.sort().join(', ')} to src/types and have this module implement the port from there.`
      : null;
  },
};

export const noForwardingModule: RuleDefinition = {
  preflight: true,
  rule: 'A module must not exist only to forward another module',
  rationale:
    'A file whose whole body is a re-export adds a name and a hop without adding behavior. It hides where a symbol really lives, defeats go-to-definition, and lets two import paths for the same thing drift apart. Import the canonical module directly. src/exports is the one exception, because the package manifest requires a file at each published subpath.',
  check(filePath, configRoot) {
    const root = sourceRoot(filePath);
    if (!root || root === 'exports') return null;
    const relativePath = projectPath(filePath, configRoot);
    if (!relativePath) return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile || !isPureReExportModule(sourceFile)) return null;
    return 'This module only forwards another. Delete it and import the canonical module directly, or move it under src/exports if it is a published subpath.';
  },
};

export const cordisContextInPiAdapter: RuleDefinition = {
  preflight: true,
  rule: 'Exactly one production Cordis Context is constructed by the shared Doom host adapter',
  rationale:
    'One application Context belongs to each Pi runner. The extension-contracts host adapter owns it, publishes the runtime and session services, and recursively disposes the plugin tree. A package-local Context splits service discovery and creates a competing lifecycle.',
  check(filePath, configRoot) {
    const relativePath = projectPath(filePath, configRoot);
    const manifest = readPackageManifest(configRoot);
    if (!relativePath || !isDoomPackageName(manifest?.name)) return null;

    if (relativePath === PACKAGE_MANIFEST_PATH && manifest?.name === CORDIS_CONTRACTS_PACKAGE) {
      const hostSource = readSource(path.join(configRoot, CORDIS_HOST_ADAPTER_PATH));
      const count = hostSource ? cordisContextConstructionCount(hostSource) : 0;
      return count === 1
        ? null
        : `The shared host must contain exactly one Cordis Context construction at ${CORDIS_HOST_ADAPTER_PATH}; found ${count}.`;
    }

    // Tests build their own Context to drive an extension under a harness.
    if (!relativePath.startsWith('src/')) return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile) return null;

    const count = cordisContextConstructionCount(sourceFile);
    const isSharedHost =
      manifest?.name === '@agimon-ai/doompi-extension-contracts' && relativePath === CORDIS_HOST_ADAPTER_PATH;
    if (isSharedHost) {
      return count === 1 ? null : `The shared host adapter must construct exactly one Cordis Context; found ${count}.`;
    }

    return count > 0
      ? 'Do not construct a package-local Cordis root. Connect to @agimon-ai/doompi-extension-contracts/cordis-host and mount a plugin on the shared root.'
      : null;
  },
};

export const cordisHostOrder: RuleDefinition = {
  preflight: true,
  rule: 'Doom parent and detached-child activation start with cordisHost and end with cordisFinalizer',
  rationale:
    'Every feature factory needs the shared Context before it connects, and the finalizer must remain after every package so it can recursively await any resources a package failed to release. Applying the same brackets to detached children prevents them from inheriting or leaking the parent lifecycle.',
  check(filePath, configRoot) {
    const manifest = readPackageManifest(configRoot);
    const relativePath = projectPath(filePath, configRoot);
    if (manifest?.name !== DOOM_PACKAGE_NAME || !relativePath) return null;
    if (relativePath !== PACKAGE_MANIFEST_PATH && relativePath !== DOOM_EXTENSION_ASSEMBLER_PATH) return null;
    const assembler = readSource(path.join(configRoot, DOOM_EXTENSION_ASSEMBLER_PATH));
    if (!assembler) return `Doom activation assembler is missing at ${DOOM_EXTENSION_ASSEMBLER_PATH}.`;
    const violations = cordisActivationOrderViolations(assembler);
    return violations.length > 0 ? `Invalid Cordis activation order: ${violations.join('; ')}.` : null;
  },
};

export const cordisFeaturePlugin: RuleDefinition = {
  preflight: true,
  rule: 'Every Doom feature Pi adapter owns exactly one host lease and one root plugin fiber',
  rationale:
    'The host connection joins the one runner-owned service registry, while root.plugin gives each package a provider-owned fiber whose registrations and effects unload together. Cardinality and ordered teardown prevent split ownership, duplicate providers, and a released host outliving its package fiber.',
  check(filePath, configRoot) {
    const relativePath = projectPath(filePath, configRoot);
    const manifest = readPackageManifest(configRoot);
    const isFeaturePackage =
      manifest?.name !== CORDIS_CONTRACTS_PACKAGE &&
      manifest?.name?.startsWith(DOOM_PACKAGE_PREFIX) === true &&
      piDiscoveryEntryStems(configRoot).size > 0;
    const isDoomHost = manifest?.name === DOOM_PACKAGE_NAME;
    if (!relativePath || (!isFeaturePackage && !isDoomHost)) return null;

    if (relativePath === PACKAGE_MANIFEST_PATH) {
      const adapterPaths = isDoomHost
        ? DOOM_HOST_CORDIS_FEATURE_PATHS.map((entryPath) => path.join(configRoot, entryPath))
        : publicFeatureAdapterPaths(configRoot, manifest);
      if (adapterPaths.length === 0) {
        return 'A Doom Pi feature package must expose at least one adapter under src/adapters/pi through its ./extensions/* facade.';
      }
      const invalid = adapterPaths.flatMap((adapterPath) => {
        const sourceFile = readSource(adapterPath);
        if (!sourceFile) return [`${projectPath(adapterPath, configRoot) ?? adapterPath} (missing)`];
        const mount = cordisFeatureMount(sourceFile);
        const violations = cordisFeatureMountViolations(mount);
        return violations.length === 0
          ? []
          : [`${projectPath(adapterPath, configRoot) ?? adapterPath} (${violations.join('; ')})`];
      });
      return invalid.length === 0 ? null : `Invalid Cordis feature lifecycle: ${invalid.join(', ')}.`;
    }

    const isDoomHostFeature =
      isDoomHost &&
      DOOM_HOST_CORDIS_FEATURE_PATHS.includes(relativePath as (typeof DOOM_HOST_CORDIS_FEATURE_PATHS)[number]);
    if (!relativePath.startsWith('src/adapters/pi/') && !isDoomHostFeature) return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile) return null;
    const mount = cordisFeatureMount(sourceFile);
    const participates = mount.connectionCount > 0 || mount.rootPluginCount > 0 || isDoomHostFeature;
    if (!participates) return null;
    const violations = cordisFeatureMountViolations(mount);
    return violations.length > 0
      ? `Invalid Cordis feature lifecycle: ${violations.join('; ')}. Import the connector from ${CORDIS_HOST_EXPORT}.`
      : null;
  },
};

export const noLegacyCordisAccess: RuleDefinition = {
  preflight: true,
  rule: 'Doom packages use injected, provider-owned Cordis services rather than session-context or reflect access',
  rationale:
    'The session-context WeakMap is bundle-local and cannot reliably join independently loaded packages. Cordis reflection also bypasses dependency tracking, so a consumer can outlive a replaced provider. The shared host connection, ctx.provide or Service, and inject preserve ownership and reload semantics.',
  check(filePath, configRoot) {
    const relativePath = projectPath(filePath, configRoot);
    const manifest = readPackageManifest(configRoot);
    if (!relativePath || !isDoomPackageName(manifest?.name)) return null;

    if (relativePath === PACKAGE_MANIFEST_PATH) {
      const exports = manifest?.exports;
      return exports && typeof exports === 'object' && !Array.isArray(exports) && './session-context' in exports
        ? 'Remove the legacy ./session-context export and use ./cordis-host plus injected services.'
        : null;
    }
    if (!relativePath.startsWith('src/')) return null;
    if (LEGACY_SESSION_CONTEXT_PATHS.has(relativePath)) {
      return fs.existsSync(filePath)
        ? 'Remove the legacy session-context module; the runner-owned host is the only Context discovery boundary.'
        : null;
    }

    const sourceFile = readSource(filePath);
    if (!sourceFile) return null;
    const violations: string[] = [];
    if (collectSpecifiers(sourceFile).includes(LEGACY_SESSION_CONTEXT_EXPORT)) {
      violations.push(`legacy ${LEGACY_SESSION_CONTEXT_EXPORT} import`);
    }
    if (usesCordisReflection(sourceFile)) violations.push('Cordis reflect access');
    return violations.length > 0
      ? `Legacy Cordis access is forbidden: ${violations.join(' and ')}. Publish from the owning plugin and consume with inject or ctx.get().`
      : null;
  },
};

export const cordisServiceInjection: RuleDefinition = {
  preflight: true,
  rule: 'Every required Doom service is consumed under an owning Cordis inject dependency',
  rationale:
    'A required ctx.get or requireDoom* call without inject can retain a provider after it unloads or execute before it exists. An injected callback owns direct use; stable Pi wrappers may close over an active binding only when that callback also clears the binding during dependency disposal.',
  check(filePath, configRoot) {
    const relativePath = projectPath(filePath, configRoot);
    const manifest = readPackageManifest(configRoot);
    if (relativePath !== PACKAGE_MANIFEST_PATH || !isDoomPackageName(manifest?.name)) {
      return null;
    }
    const violations = cordisServiceInjectionViolations(configRoot);
    return violations.length > 0 ? `Invalid required Cordis service ownership: ${violations.join('; ')}.` : null;
  },
};

export const serviceBoundary: RuleDefinition = {
  preflight: true,
  rule: 'Services depend only on services, types, and schemas and never on hosts, containers, concrete adapters, or node:*',
  rationale:
    'Host-neutral services remain independently testable and reusable when infrastructure points inward through contracts.',
  check(filePath) {
    if (sourceRoot(filePath) !== 'services') return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile || isPureReExportModule(sourceFile)) return null;
    const blocked = collectRuntimeSpecifiers(sourceFile).filter((specifier) => {
      if (specifier.startsWith('node:') && !PURE_NODE_BUILTINS.has(specifier)) return true;
      if (HOST_PACKAGES.some((packageName) => specifier.startsWith(packageName))) return true;
      const targetRoot = relativeImportRoot(filePath, specifier);
      return targetRoot ? EXTERNAL_IMPLEMENTATION_ROOTS.includes(targetRoot) : false;
    });
    return blocked.length > 0 ? `Service imports forbidden dependencies: ${blocked.join(', ')}` : null;
  },
};

export const schemaPlacement: RuleDefinition = {
  preflight: true,
  rule: 'Runtime TypeBox and Zod schema construction lives under src/schemas',
  rationale:
    'Central runtime schemas keep validation contracts discoverable while services consume schema-derived types.',
  check(filePath) {
    const root = sourceRoot(filePath);
    if (!root || root === 'schemas') return null;
    const sourceFile = readSource(filePath);
    return sourceFile && containsRuntimeSchema(sourceFile)
      ? 'Move runtime TypeBox or Zod schema construction under src/schemas and import the derived contract.'
      : null;
  },
};

interface PackageLayerOptions {
  order: string[];
  layers: Record<string, string>;
  fallback: string;
  featurePackagePrefixes: string[];
}

function packageLayerOptions(options: Readonly<RuleOptions> | undefined): PackageLayerOptions {
  return {
    order: stringListOption(options, 'packageLayerOrder', DEFAULT_PACKAGE_LAYER_ORDER),
    layers: stringRecordOption(options, 'packageLayers', DEFAULT_PACKAGE_LAYERS),
    fallback: stringOption(options, 'packageLayerFallback', DEFAULT_PACKAGE_LAYER_FALLBACK),
    featurePackagePrefixes: stringListOption(options, 'featurePackagePrefixes', DEFAULT_FEATURE_PACKAGE_PREFIXES),
  };
}

/** Tier index, or undefined for a package this distribution does not rank. */
function packageLayerRank(packageName: string, options: PackageLayerOptions): number | undefined {
  const named =
    options.layers[packageName] ??
    (startsWithAny(packageName, options.featurePackagePrefixes) ? options.fallback : undefined);
  if (!named) return undefined;
  const rank = options.order.indexOf(named);
  return rank >= 0 ? rank : undefined;
}

function packageReferences(filePath: string, relativePath: string, manifest: ArchitectureManifest): string[] {
  if (relativePath === PACKAGE_MANIFEST_PATH) return dependencyNames(manifest);
  if (!relativePath.startsWith('src/')) return [];
  const sourceFile = readSource(filePath);
  return sourceFile ? collectSpecifiers(sourceFile).map(packageNameFromSpecifier) : [];
}

export const packageLayerOrder: RuleDefinition = {
  preflight: true,
  rule: 'A package depends on its own tier or a lower one, never on a higher one',
  rationale:
    'The distribution is a layered graph: contracts, then platform, then integration, then extensions, then the host. An edge that points up closes a cycle. nx orders builds by `dependsOn: ["^build"]` over that same graph, so a cycle is not a slow build, it is a build with no valid order, and it surfaces as an error in an unrelated package long after the import was written. The tiers are dependency depth, not activation role: a package can be fixed host core and still sit above the platform it needs.',
  check(filePath, configRoot, context) {
    const manifest = readPackageManifest(configRoot) as ArchitectureManifest | null;
    const packageName = manifest?.name;
    const relativePath = projectPath(filePath, configRoot);
    if (!manifest || !packageName || !relativePath) return null;

    const options = packageLayerOptions(context?.options);
    const rank = packageLayerRank(packageName, options);
    if (rank === undefined) return null;

    const above = [...new Set(packageReferences(filePath, relativePath, manifest))].filter((name) => {
      if (name === packageName) return false;
      const targetRank = packageLayerRank(name, options);
      return targetRank !== undefined && targetRank > rank;
    });
    if (above.length === 0) return null;

    const topRank = options.order.length - 1;
    const cyclic = above.filter((name) => packageLayerRank(name, options) === topRank);
    const cycleDetail =
      cyclic.length > 0 ? ` Depending on ${cyclic.sort().join(', ')} makes the nx project graph cyclic.` : '';
    return `${packageName} is a ${options.order[rank]} package and depends on a higher tier: ${above.sort().join(', ')}.${cycleDetail}`;
  },
};

export const doomCleanArchitectureBoundary: RuleDefinition = {
  preflight: true,
  rule: 'DoomPi composition stays layer-driven and publishes only standard Pi extension surfaces',
  rationale:
    'Keeping feature activation in modes.yaml and package manifests prevents fixed feature inventories, compatibility ABIs, and host-owned lifecycle coupling from returning.',
  check(filePath, configRoot, context) {
    const relativePath = projectPath(filePath, configRoot);
    if (!relativePath) return null;
    const options = cleanArchitectureOptions(context?.options);
    const manifest = readPackageManifest(configRoot) as ArchitectureManifest | null;
    if (!manifest) return null;

    const violations: string[] = [];
    if (configRoot.includes(CAPABILITIES_PACKAGE_FRAGMENT) || relativePath.includes(CAPABILITIES_PACKAGE_FRAGMENT)) {
      violations.push('doompi-capabilities package paths are forbidden');
    }
    if (LEGACY_DOOM_ENTRY_PATTERN.test(relativePath)) {
      violations.push(`legacy extensions/doom file: ${relativePath}`);
    }
    if (relativePath === PACKAGE_MANIFEST_PATH) {
      violations.push(...packageManifestViolations(manifest, configRoot, options));
    }

    const sourceFile = readSource(filePath);
    if (sourceFile) {
      violations.push(...sourceArchitectureViolations(relativePath, sourceFile, manifest, options));
    }

    const unique = [...new Set(violations)];
    return unique.length > 0 ? `Clean architecture boundary violations: ${unique.join('; ')}` : null;
  },
};
