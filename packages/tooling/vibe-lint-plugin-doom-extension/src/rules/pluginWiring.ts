import * as fs from 'node:fs';
import ts from 'typescript';
import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import { projectPath, readPackageManifest } from './manifestEntries.js';

const ENTRIES = new Map([
  ['src/extensions/pi.ts', 'definePiExtension'],
  ['src/extensions/server.ts', 'defineServerPlugin'],
  ['src/adapters/pi/extension.ts', 'definePiExtension'],
  ['src/adapters/server/facet.ts', 'defineServerPlugin'],
]);
const REGISTRATIONS = new Set([
  'registerApi',
  'registerChannel',
  'registerMethod',
  'registerTool',
  'registerCommand',
  'registerResource',
  'registerHook',
  'registerMinorMode',
  'registerToolRestriction',
  'registerActivity',
]);
const HOST_RECEIVERS = new Set(['ctx', 'context', 'cordis', 'host', 'agent', 'pi', 'root', 'fiber', 'connection']);
const HOST_METHODS = new Set(['get', 'inject', 'plugin', 'on']);
const OLD_HOOKS = new Set(['setup', 'teardown', 'start', 'stop', 'dispose']);
const CONTRIBUTIONS = new Set([
  'services',
  'tools',
  'commands',
  'resources',
  'minorModes',
  'toolRestrictions',
  'toolOverrides',
  'activities',
  'methods',
  'channels',
  'api',
  'events',
  'hooks',
  'providers',
  'messageRenderers',
  'entryRenderers',
  'markdownTransformers',
  'shortcuts',
  'flags',
]);

function propertyName(node: ts.PropertyName | undefined): string | undefined {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : undefined;
}

/** Recognize generic and aliased calls without accepting comments or string literals. */
export function hasPluginHelperCall(source: ts.SourceFile, helper: string): boolean {
  const names = new Set([helper]);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements)
        if ((binding.propertyName?.text ?? binding.name.text) === helper) names.add(binding.name.text);
    }
  }
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text)) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export const pluginCompositionWiring: RuleDefinition = {
  preflight: true,
  rule: 'Plugin entries use definePiExtension or defineServerPlugin with declarations and on-prefixed lifecycle hooks',
  rationale:
    'The helper owns host initialization, contribution registration, and disposal. Explicit onStart, onStop, and onDispose hooks keep package work separate from that ownership.',
  check(filePath, configRoot) {
    const relative = projectPath(filePath, configRoot);
    if (!relative) return null;
    // The canonical host bootstrap must claim the composed generation before loading its host.
    // Its bootstrap-specific rules validate ordering; feature entries still require the HOC.
    if (relative === 'src/extensions/pi.ts' && readPackageManifest(configRoot)?.name === '@agimon-ai/doompi')
      return null;
    const helper = ENTRIES.get(relative);
    if (!helper || !fs.existsSync(filePath)) return null;
    const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
    const helpers = new Set([helper]);
    const connectors = new Set(['connectDoomCordisHost']);
    const contexts = new Set(['Context']);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements) {
        const imported = binding.propertyName?.text ?? binding.name.text;
        if (imported === helper) helpers.add(binding.name.text);
        if (imported === 'connectDoomCordisHost') connectors.add(binding.name.text);
        if (imported === 'Context') contexts.add(binding.name.text);
      }
    }
    const serviceFunctions = new Set<ts.Node>();
    const functionParameters = (node: ts.Node): readonly ts.ParameterDeclaration[] | undefined =>
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node)
        ? node.parameters
        : undefined;
    const ownsServiceContext = (name: string, site: ts.Node): boolean => {
      for (let ancestor: ts.Node | undefined = site.parent; ancestor; ancestor = ancestor.parent) {
        const parameters = functionParameters(ancestor);
        if (!parameters?.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name)) continue;
        if (serviceFunctions.has(ancestor)) return true;
        const call = ancestor.parent;
        return (
          ts.isCallExpression(call) &&
          ts.isPropertyAccessExpression(call.expression) &&
          call.expression.name.text === 'inject' &&
          ts.isIdentifier(call.expression.expression) &&
          ownsServiceContext(call.expression.expression.text, call)
        );
      }
      return false;
    };
    let composed = false;
    const violations = new Set<string>();
    const declaration = (node: ts.Node): void => {
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        if (!ts.isBlock(node.body)) declaration(node.body);
        else {
          for (const statement of node.body.statements)
            if (ts.isReturnStatement(statement) && statement.expression) declaration(statement.expression);
        }
        return;
      }
      if (ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) {
        declaration(node.expression);
        return;
      }
      if (!ts.isObjectLiteralExpression(node)) return;
      for (const property of node.properties) {
        const name = propertyName(property.name);
        if (!name) continue;
        if (
          name === 'services' &&
          ts.isPropertyAssignment(property) &&
          ts.isArrayLiteralExpression(property.initializer)
        ) {
          for (const plugin of property.initializer.elements)
            if (ts.isArrowFunction(plugin) || ts.isFunctionExpression(plugin)) serviceFunctions.add(plugin);
        }
        if (OLD_HOOKS.has(name)) violations.add(`legacy lifecycle ${name}`);
        if (
          CONTRIBUTIONS.has(name) &&
          (ts.isMethodDeclaration(property) ||
            (ts.isPropertyAssignment(property) &&
              (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer))))
        )
          violations.add(`imperative ${name} registration`);
        if (['global', 'workspace', 'session'].includes(name) && ts.isPropertyAssignment(property))
          declaration(property.initializer);
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && helpers.has(node.expression.text)) {
          composed = true;
          for (const argument of node.arguments) declaration(argument);
        }
        if (ts.isIdentifier(node.expression) && connectors.has(node.expression.text))
          violations.add('connectDoomCordisHost');
        if (ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          const receiver = node.expression.expression;
          if (
            REGISTRATIONS.has(method) ||
            (ts.isIdentifier(receiver) &&
              HOST_RECEIVERS.has(receiver.text) &&
              HOST_METHODS.has(method) &&
              !ownsServiceContext(receiver.text, node))
          )
            violations.add(`${receiver.getText(source)}.${method}`);
        }
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && contexts.has(node.expression.text))
        violations.add('new Context');
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (!composed) return `Use ${helper} in the extension entry; the helper owns host initialization and disposal.`;
    return violations.size
      ? `Use ${helper} declarations and onStart/onStop/onDispose hooks: ${[...violations].join(', ')}.`
      : null;
  },
};
