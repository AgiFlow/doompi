import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import ts from 'typescript';
import { piDiscoveryEntryStems, projectPath, sourceStem } from './manifestEntries.js';

const PACKAGE_MANIFEST_NAME = 'package.json';
const PI_VERSION = '0.84.4';
const PI_PACKAGES = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
] as const;

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
/**
 * Superseded by @deepseek-ai/cordis. reflect-metadata exists in these packages
 * only to satisfy inversify's decorators, so it leaves with it.
 */
const SUPERSEDED_CONTAINER_PACKAGES = ['inversify', 'reflect-metadata'] as const;
const SUPERSEDED_CONTAINER_IMPORT =
  /(?:^|\n)\s*import\s[^;]*?from\s*['"](inversify|reflect-metadata)['"]|(?:^|\n)\s*import\s*['"](inversify|reflect-metadata)['"]/;
const DOOM_PACKAGE_NAME = '@agimon-ai/doompi';
const DOOM_PACKAGE_PREFIX = `${DOOM_PACKAGE_NAME}-`;
const CORDIS_CONTRACTS_PACKAGE = '@agimon-ai/doompi-extension-contracts';
const CORDIS_HOST_ADAPTER_PATH = 'src/adapters/pi/cordisHost.ts';
const CORDIS_PROTOCOL_EXPORT = `${CORDIS_CONTRACTS_PACKAGE}/protocol`;
const CORDIS_HOST_QUERY_CHANNEL_IDENTIFIER = 'DOOM_CORDIS_HOST_QUERY_CHANNEL';
const CORDIS_HOST_QUERY_CHANNEL = 'doom:cordis:host:v1:query';
const PASSIVE_PROTOCOL_RUNTIME_EXPORTS = new Set(['DoomProtocolError', 'DoomProtocolValidationError']);

/**
 * Runtime exports from the former Pi EventBus collaboration layer. Type and
 * schema exports from these modules remain useful at process boundaries; these
 * values establish a live same-runner provider, client, or contribution and
 * therefore have to move to a provider-owned Cordis service.
 */
const SAME_RUNNER_PROTOCOL_EXPORTS = new Set([
  'DoomConfigRegistry',
  'DoomFooterStatusRegistry',
  'createDoomHelpSnapshotClient',
  'createFablePlanBrokerClient',
  'createNarrationRequester',
  'createProtocolRuntime',
  'createVoiceToolHost',
  'installDoomLeaderBootstrapHost',
  'provideBackgroundWorkRegistry',
  'provideDoomHelpHost',
  'publishAskUserBlocked',
  'publishAskUserPrompt',
  'registerBackgroundWorkProvider',
  'registerConfigProvider',
  'registerDoomConfigContribution',
  'registerDoomFooterContribution',
  'registerDoomHelpContribution',
  'registerDoomLeaderActionHandlers',
  'registerDoomLeaderContribution',
  'registerDoomSkillSource',
  'registerFablePlanBroker',
  'registerFooterStatusProvider',
  'registerSubagentPolicy',
  'registerVoiceAutoScopeContribution',
  'registerVoiceTool',
  'registerVoiceToolContribution',
  'subscribeToNarrationRequests',
  'subscribeToAskUserEvents',
]);

type ProcessGlobalBoundaryKind = 'claim' | 'reload';

const LEGITIMATE_PROCESS_GLOBAL_BOUNDARIES = new Map<string, ReadonlyMap<string, ProcessGlobalBoundaryKind>>([
  [
    CORDIS_CONTRACTS_PACKAGE,
    new Map([
      ['src/schemas/transitionContext.ts', 'reload'],
      ['src/schemas/voiceReloadHandoff.ts', 'reload'],
    ]),
  ],
  ['@agimon-ai/doompi-domain', new Map([['src/adapters/domainSwitchHandoff.ts', 'reload']])],
  [
    DOOM_PACKAGE_NAME,
    new Map([
      ['src/adapters/bootstrapClaim.ts', 'claim'],
      ['src/adapters/compositionState.ts', 'claim'],
    ]),
  ],
]);

interface PackageManifest {
  name?: string;
  private?: boolean;
  type?: string;
  files?: string[];
  exports?: Record<string, unknown>;
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readText(filePath: string): string | null {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

function readManifest(filePath: string): PackageManifest | null {
  const text = readText(filePath);
  return text ? (JSON.parse(text) as PackageManifest) : null;
}

function readSource(filePath: string): ts.SourceFile | null {
  const text = readText(filePath);
  return text && SOURCE_EXTENSIONS.includes(path.extname(filePath))
    ? ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true)
    : null;
}

function isDoomPackage(packageName: string | undefined): boolean {
  return packageName === DOOM_PACKAGE_NAME || packageName?.startsWith(DOOM_PACKAGE_PREFIX) === true;
}

function isDoomProductionSource(filePath: string, configRoot: string): boolean {
  const relativePath = projectPath(filePath, configRoot);
  if (!relativePath?.startsWith('src/')) return false;
  const manifest = readManifest(path.join(configRoot, PACKAGE_MANIFEST_NAME));
  // Unit-rule fixtures historically omit a package manifest. Installed rules
  // are scoped by the Doom preset, while an explicit non-Doom manifest opts out.
  return manifest?.name === undefined || isDoomPackage(manifest.name);
}

function isDoomModuleSpecifier(specifier: string): boolean {
  return (
    specifier === DOOM_PACKAGE_NAME ||
    specifier.startsWith(`${DOOM_PACKAGE_NAME}/`) ||
    specifier.startsWith(DOOM_PACKAGE_PREFIX)
  );
}

function importedRuntimeNames(sourceFile: ts.SourceFile, enforceContractDefinitions: boolean): string[] {
  const violations = new Set<string>();
  const doomNamespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue;
    }
    if (statement.importClause?.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    const importsProtocolRuntime =
      specifier === CORDIS_PROTOCOL_EXPORT ||
      (enforceContractDefinitions && /^\.\.?\/protocol(?:\.ts)?$/.test(specifier));
    if (!importsProtocolRuntime && !isDoomModuleSpecifier(specifier)) continue;
    if (importsProtocolRuntime && statement.importClause?.name) {
      violations.add(`${specifier} default`);
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      if (importsProtocolRuntime) violations.add(`${specifier} namespace`);
      else doomNamespaces.add(bindings.name.text);
      continue;
    }
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const importedName = (element.propertyName ?? element.name).text;
      if (importsProtocolRuntime) {
        if (!PASSIVE_PROTOCOL_RUNTIME_EXPORTS.has(importedName)) violations.add(importedName);
      } else if (SAME_RUNNER_PROTOCOL_EXPORTS.has(importedName)) {
        violations.add(importedName);
      }
    }
  }
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !isDoomModuleSpecifier(statement.moduleSpecifier.text) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const exportedName = (element.propertyName ?? element.name).text;
      if (SAME_RUNNER_PROTOCOL_EXPORTS.has(exportedName)) violations.add(exportedName);
    }
  }
  const visitNamespaceUse = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      doomNamespaces.has(node.expression.text) &&
      SAME_RUNNER_PROTOCOL_EXPORTS.has(node.name.text)
    ) {
      violations.add(node.name.text);
    }
    ts.forEachChild(node, visitNamespaceUse);
  };
  visitNamespaceUse(sourceFile);
  if (enforceContractDefinitions) {
    for (const statement of sourceFile.statements) {
      if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name &&
        SAME_RUNNER_PROTOCOL_EXPORTS.has(statement.name.text)
      ) {
        violations.add(statement.name.text);
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && SAME_RUNNER_PROTOCOL_EXPORTS.has(declaration.name.text)) {
            violations.add(declaration.name.text);
          }
        }
      }
    }
  }
  return [...violations].sort();
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isEventsProperty(node: ts.Expression): boolean {
  const expression = unwrapExpression(node);
  return (
    (ts.isPropertyAccessExpression(expression) && expression.name.text === 'events') ||
    (ts.isElementAccessExpression(expression) &&
      expression.argumentExpression !== undefined &&
      ts.isStringLiteralLike(expression.argumentExpression) &&
      expression.argumentExpression.text === 'events')
  );
}

interface EventBusAnalysis {
  readonly aliases: ReadonlySet<string>;
  readonly methods: ReadonlySet<string>;
}

function typeName(node: ts.TypeNode | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isTypeReferenceNode(node)) {
    if (ts.isIdentifier(node.typeName)) return node.typeName.text;
    if (ts.isQualifiedName(node.typeName)) return node.typeName.right.text;
  }
  return ts.isParenthesizedTypeNode(node) ? typeName(node.type) : undefined;
}

function eventBusAnalysis(sourceFile: ts.SourceFile): EventBusAnalysis {
  const aliases = new Set<string>(['events']);
  const methods = new Set<string>();
  const eventBusTypes = new Set(['EventBusLike']);
  const functions = new Map<string, ts.FunctionLikeDeclaration>();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === 'EventBusLike') eventBusTypes.add(element.name.text);
        }
      }
    }
  }
  const collectFunctions = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) functions.set(node.name.text, node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      functions.set(node.name.text, node.initializer);
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && eventBusTypes.has(typeName(node.type) ?? '')) {
      aliases.add(node.name.text);
    }
    ts.forEachChild(node, collectFunctions);
  };
  collectFunctions(sourceFile);
  const isKnownBus = (node: ts.Expression): boolean => {
    const expression = unwrapExpression(node);
    return isEventsProperty(expression) || (ts.isIdentifier(expression) && aliases.has(expression.text));
  };
  let changed = true;
  while (changed) {
    changed = false;
    const add = (name: string): void => {
      if (!aliases.has(name)) {
        aliases.add(name);
        changed = true;
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name) && isKnownBus(node.initializer)) add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) {
          const initializerIsBus = isKnownBus(node.initializer);
          for (const element of node.name.elements) {
            const property = element.propertyName ?? element.name;
            if (
              ts.isIdentifier(element.name) &&
              ((ts.isIdentifier(property) && property.text === 'events') ||
                (ts.isStringLiteralLike(property) && property.text === 'events'))
            ) {
              add(element.name.text);
            }
            if (
              initializerIsBus &&
              ts.isIdentifier(element.name) &&
              ((ts.isIdentifier(property) && ['emit', 'on'].includes(property.text)) ||
                (ts.isStringLiteralLike(property) && ['emit', 'on'].includes(property.text)))
            ) {
              methods.add(element.name.text);
            }
          }
        }
        if (
          ts.isIdentifier(node.name) &&
          ts.isPropertyAccessExpression(unwrapExpression(node.initializer)) &&
          ['emit', 'on'].includes((unwrapExpression(node.initializer) as ts.PropertyAccessExpression).name.text) &&
          isKnownBus((unwrapExpression(node.initializer) as ts.PropertyAccessExpression).expression)
        ) {
          methods.add(node.name.text);
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        isKnownBus(node.right)
      ) {
        add(node.left.text);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const target = functions.get(node.expression.text);
        if (target) {
          node.arguments.forEach((argument, index) => {
            const parameter = target.parameters[index];
            if (parameter && ts.isIdentifier(parameter.name) && ts.isExpression(argument) && isKnownBus(argument)) {
              add(parameter.name.text);
            }
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { aliases, methods };
}

function eventBusCallMethod(node: ts.CallExpression, analysis: EventBusAnalysis): string | undefined {
  if (ts.isIdentifier(node.expression) && analysis.methods.has(node.expression.text)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) {
    const method = ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : node.expression.argumentExpression && ts.isStringLiteralLike(node.expression.argumentExpression)
        ? node.expression.argumentExpression.text
        : undefined;
    if (!method || !['emit', 'on'].includes(method)) return undefined;
    const receiver = unwrapExpression(node.expression.expression);
    if (isEventsProperty(receiver) || (ts.isIdentifier(receiver) && analysis.aliases.has(receiver.text))) return method;
  }
  return undefined;
}

function hasExactHostQueryConstant(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === CORDIS_HOST_QUERY_CHANNEL_IDENTIFIER &&
          declaration.initializer !== undefined &&
          ts.isStringLiteralLike(declaration.initializer) &&
          declaration.initializer.text === CORDIS_HOST_QUERY_CHANNEL,
      ),
  );
}

function isCordisHostDiscoveryCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  analysis: EventBusAnalysis,
): boolean {
  const channel = node.arguments[0];
  return (
    eventBusCallMethod(node, analysis) !== undefined &&
    hasExactHostQueryConstant(sourceFile) &&
    channel !== undefined &&
    ts.isIdentifier(channel) &&
    channel.text === CORDIS_HOST_QUERY_CHANNEL_IDENTIFIER
  );
}

function containsEventBusCall(sourceFile: ts.SourceFile, allowCordisHostDiscovery: boolean): boolean {
  let found = false;
  const analysis = eventBusAnalysis(sourceFile);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      eventBusCallMethod(node, analysis) !== undefined &&
      !(allowCordisHostDiscovery && isCordisHostDiscoveryCall(node, sourceFile, analysis))
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function isInTypePosition(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isExpression(current) || ts.isStatement(current)) return false;
  }
  return false;
}

function containsUnsafeProcessGlobal(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && ['global', 'globalThis'].includes(node.text) && !isInTypePosition(node)) {
      const parent = node.parent;
      const isHostRuntime =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        ['crypto', 'fetch'].includes(parent.name.text);
      if (!isHostRuntime) found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function isFencedProcessGlobalBoundary(sourceFile: ts.SourceFile, kind: ProcessGlobalBoundaryKind): boolean {
  let hasSymbolFor = false;
  let hasIdentityComparison = false;
  let hasRelease = false;
  let hasTtl = false;
  let hasExpiry = false;
  let hasGeneration = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Symbol' &&
      node.expression.name.text === 'for'
    ) {
      hasSymbolFor = true;
    }
    if (
      (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['delete', 'deleteProperty'].includes(node.expression.name.text)) ||
      ts.isDeleteExpression(node)
    ) {
      hasRelease = true;
    }
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
        node.operatorToken.kind,
      )
    ) {
      hasIdentityComparison = true;
    }
    if (ts.isIdentifier(node) && node.text.endsWith('_TTL_MS')) hasTtl = true;
    if (
      (ts.isIdentifier(node) && node.text === 'expiresAt') ||
      (ts.isPropertyAccessExpression(node) && node.name.text === 'expiresAt')
    ) {
      hasExpiry = true;
    }
    if (
      (ts.isIdentifier(node) && node.text.endsWith('Generation')) ||
      (ts.isPropertyAccessExpression(node) && node.name.text.endsWith('Generation'))
    ) {
      hasGeneration = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return kind === 'reload'
    ? hasSymbolFor && hasRelease && hasTtl && hasExpiry && hasGeneration
    : hasSymbolFor && hasRelease && hasIdentityComparison;
}

export const doomPackageShape: RuleDefinition = {
  preflight: true,
  rule: 'Doom packages are public ESM packages with publish allowlists and closed, explicit exports',
  rationale:
    'A publishable, closed package surface prevents accidental deep-import contracts and keeps host loading predictable.',
  check(filePath) {
    if (path.basename(filePath) !== PACKAGE_MANIFEST_NAME) return null;
    const manifest = readManifest(filePath);
    if (!manifest) return null;
    const problems: string[] = [];
    if (manifest.private === true) problems.push('private: true is not allowed');
    if (manifest.type !== 'module') problems.push('type must be module');
    if (!manifest.files || manifest.files.length === 0) problems.push('files publish allowlist is required');
    if (manifest.publishConfig?.access !== 'public') problems.push('publishConfig.access must be public');
    if (!manifest.exports || Object.keys(manifest.exports).length === 0) problems.push('exports must be explicit');
    if (manifest.exports && Object.keys(manifest.exports).some((key) => key.includes('*'))) {
      problems.push('wildcard exports are not allowed');
    }
    return problems.length > 0 ? `Invalid Doom extension package: ${problems.join('; ')}` : null;
  },
};

export const preferCordisContainer: RuleDefinition = {
  preflight: true,
  rule: 'Composition and lifecycle use @deepseek-ai/cordis, never inversify or reflect-metadata',
  rationale:
    'Cordis is the distribution composition model: its Context service registry is shared across loaded extensions, so one package can contribute a service another consumes, and a fiber disposes everything it registered on unload. A per-package inversify Container cannot express cross-extension contribution, and running both leaves two competing lifecycles.',
  check(filePath, configRoot) {
    const packageManifest = readManifest(path.join(configRoot, PACKAGE_MANIFEST_NAME));
    if (
      packageManifest?.name !== '@agimon-ai/doompi' &&
      packageManifest?.name?.startsWith('@agimon-ai/doompi-') !== true
    ) {
      return null;
    }
    if (path.basename(filePath) === PACKAGE_MANIFEST_NAME) {
      const manifest = readManifest(filePath);
      if (!manifest) return null;
      const declared = SUPERSEDED_CONTAINER_PACKAGES.filter(
        (name) =>
          manifest.dependencies?.[name] !== undefined ||
          manifest.devDependencies?.[name] !== undefined ||
          manifest.peerDependencies?.[name] !== undefined,
      );
      return declared.length > 0
        ? `Replace ${declared.join(' and ')} with @deepseek-ai/cordis, then drop experimentalDecorators and emitDecoratorMetadata from tsconfig.json.`
        : null;
    }

    if (!SOURCE_EXTENSIONS.includes(path.extname(filePath))) return null;
    const relativePath = projectPath(filePath, configRoot);
    if (!relativePath?.startsWith('src/')) return null;
    const text = readText(filePath);
    if (!text || !SUPERSEDED_CONTAINER_IMPORT.test(text)) return null;
    return 'Register this on a cordis Context instead. Extend Service to publish a named service, or take dependencies as plain factory arguments.';
  },
};

export const piPeerVersion: RuleDefinition = {
  preflight: true,
  rule: `Doom extension Pi peer and development dependencies must use exactly ${PI_VERSION}`,
  rationale: 'Pi extension APIs are host-version-specific, so exact pins prevent runtime contract drift.',
  check(filePath) {
    if (path.basename(filePath) !== PACKAGE_MANIFEST_NAME) return null;
    const manifest = readManifest(filePath);
    if (!manifest) return null;
    const mismatches = PI_PACKAGES.flatMap((packageName) => {
      const peer = manifest.peerDependencies?.[packageName];
      const development = manifest.devDependencies?.[packageName];
      if (!peer && !development) return [];
      const peerMatches = peer === undefined || peer === PI_VERSION;
      const developmentMatches = development === undefined || development === PI_VERSION;
      return peerMatches && developmentMatches ? [] : [packageName];
    });
    return mismatches.length > 0 ? `Pi dependencies must be pinned to ${PI_VERSION}: ${mismatches.join(', ')}` : null;
  },
};

export const thinPiAdapter: RuleDefinition = {
  preflight: true,
  rule: 'Manifest-declared Pi entries remain thin host adapters and delegate implementation work',
  rationale: 'Thin adapters isolate Pi lifecycle wiring from testable extension behavior.',
  check(filePath, configRoot) {
    const relativePath = projectPath(filePath, configRoot);
    const stem = relativePath ? sourceStem(relativePath) : null;
    if (!stem || !piDiscoveryEntryStems(configRoot).has(stem)) return null;
    const text = readText(filePath);
    if (!text) return null;
    const lines = text.split('\n').length;
    const ownsImplementation = /\b(class|interface)\s+\w+|registerTool\s*\(\s*\{/.test(text);
    return lines > 80 || ownsImplementation
      ? 'Pi adapter is too broad. Move tools, services, schemas, and UI behavior into named implementation modules.'
      : null;
  },
};

export const noRawPiEvents: RuleDefinition = {
  preflight: true,
  rule: 'Only the versioned Cordis host discovery boundary may use Pi EventBus directly',
  rationale:
    'Pi EventBus is the bootstrap transport because a standard factory receives no Cordis Context. Once connected, same-runner packages share the host Context: direct EventBus calls bypass provider ownership, dependency injection, and fiber disposal.',
  check(filePath, configRoot) {
    if (!isDoomProductionSource(filePath, configRoot)) return null;
    const manifest = readManifest(path.join(configRoot, PACKAGE_MANIFEST_NAME));
    const relativePath = projectPath(filePath, configRoot);
    const isCordisHostAdapter =
      manifest?.name === CORDIS_CONTRACTS_PACKAGE && relativePath === CORDIS_HOST_ADAPTER_PATH;
    const sourceFile = readSource(filePath);
    return sourceFile && containsEventBusCall(sourceFile, isCordisHostAdapter)
      ? `Raw Pi EventBus access is reserved for ${CORDIS_CONTRACTS_PACKAGE}/cordis-host discovery. Publish or consume a provider-owned Cordis service instead.`
      : null;
  },
};

export const noSameRunnerProtocol: RuleDefinition = {
  preflight: true,
  rule: 'Same-runner Doom packages collaborate through Cordis services, not the legacy Pi protocol runtime',
  rationale:
    'Validated EventBus schemas are still appropriate at a real process transport, but an in-process protocol host/client pair creates a second service registry with no Cordis inject or fiber ownership. The versioned Cordis host query is the sole Pi EventBus bootstrap exception.',
  check(filePath, configRoot) {
    if (!isDoomProductionSource(filePath, configRoot)) return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile) return null;
    const manifest = readManifest(path.join(configRoot, PACKAGE_MANIFEST_NAME));
    const relativePath = projectPath(filePath, configRoot);
    const enforceContractDefinitions =
      manifest?.name === CORDIS_CONTRACTS_PACKAGE &&
      relativePath !== null &&
      relativePath.startsWith('src/') &&
      relativePath !== 'src/schemas/protocol.ts';
    const imports = importedRuntimeNames(sourceFile, enforceContractDefinitions);
    return imports.length > 0
      ? `Legacy same-runner Pi protocol runtime is forbidden: ${imports.join(', ')}. Replace it with a namespaced provider-owned Cordis service and inject consumers.`
      : null;
  },
};

export const noLiveGlobalRegistry: RuleDefinition = {
  preflight: true,
  rule: 'Live same-runner Doom capabilities must not be stored on globalThis',
  rationale:
    'A process-global registry survives provider disposal and has no dependency graph, so separately bundled copies can retain stale callbacks and mutable session state. Cordis owns live collaboration. Only exact generation- and TTL-fenced reload handoffs or short-lived Doom bootstrap claims may cross module replacement through globalThis.',
  check(filePath, configRoot) {
    if (!isDoomProductionSource(filePath, configRoot)) return null;
    const manifest = readManifest(path.join(configRoot, PACKAGE_MANIFEST_NAME));
    const relativePath = projectPath(filePath, configRoot);
    const sourceFile = readSource(filePath);
    if (!sourceFile || !containsUnsafeProcessGlobal(sourceFile)) return null;
    const boundary =
      manifest?.name && relativePath
        ? LEGITIMATE_PROCESS_GLOBAL_BOUNDARIES.get(manifest.name)?.get(relativePath)
        : undefined;
    if (boundary && isFencedProcessGlobalBoundary(sourceFile, boundary)) return null;
    return boundary
      ? 'This process-global exception no longer proves its required Symbol.for identity, release path, and generation/TTL or claim-identity fence.'
      : 'A live process-global registry is forbidden. Publish the capability from its Cordis plugin fiber; only the structurally fenced reload-handoff and bootstrap-claim modules may retain process-global state.';
  },
};

export const noProtocolChannelLiterals: RuleDefinition = {
  preflight: true,
  rule: 'Doom protocol channel literals may only be declared in doompi-extension-contracts',
  rationale: 'Central channel ownership makes versioning and cross-extension discovery type-safe.',
  check(filePath) {
    if (!['.ts', '.tsx', '.mts', '.cts'].includes(path.extname(filePath))) return null;
    const text = readText(filePath);
    if (!text || filePath.includes(`${path.sep}doompi-extension-contracts${path.sep}`)) return null;
    return /['"`]doom:[^'"`]+['"`]/.test(text)
      ? 'Move Doom protocol channel literals to @agimon-ai/doompi-extension-contracts.'
      : null;
  },
};

export const disposeExternalSubscriptions: RuleDefinition = {
  preflight: true,
  rule: 'External event subscriptions must retain and invoke their disposer during shutdown',
  rationale: 'Pi can reload extensions in-process, so leaked listeners duplicate work and retain stale session state.',
  check(filePath) {
    const text = readText(filePath);
    if (!text || !/\.events\.on\s*\(/.test(text)) return null;
    const retainsDisposer =
      /(?:(?:const|let)\s+)?\w*(?:dispose|unsubscribe|cleanup)\w*\s*=\s*[^;]*\.events\.on\s*\(/i.test(text);
    const hasShutdown = /['"]session_shutdown['"]/.test(text);
    return retainsDisposer && hasShutdown
      ? null
      : 'Retain the external subscription disposer and invoke it from session_shutdown.';
  },
};

export const providerOwnedPolicy: RuleDefinition = {
  preflight: true,
  rule: 'Consumers register semantic subagent policy and must not mutate foreign tool calls',
  rationale:
    'The Team provider owns tool shapes and policy merging so consumers remain decoupled from implementation details.',
  check(filePath) {
    const text = readText(filePath);
    if (!text) return null;
    return /['"]tool_call['"]/.test(text) &&
      /(?:event|input)\.(?:input|params)\s*=|Object\.assign\s*\(\s*(?:event|input)/.test(text)
      ? 'Do not mutate foreign tool calls. Register typed subagent policy with the Team provider.'
      : null;
  },
};
