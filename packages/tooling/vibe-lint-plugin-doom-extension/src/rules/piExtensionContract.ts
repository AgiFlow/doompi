import * as fs from 'node:fs';
import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import ts from 'typescript';
import { hostEntryStems, projectPath, sourceStem } from './manifestEntries.js';

const PI_CODING_AGENT_PACKAGE = '@earendil-works/pi-coding-agent';
const SOURCE_ENTRY_PATTERN = /^src\/exports\/(?:[^/]+\/)*[^/]+\.(?:cts|mts|ts|tsx)$/;
const SOURCE_EXTENSION_PATTERN = /\.(?:cts|mts|ts|tsx)$/;

interface FactoryBindings {
  aliases: Map<string, ts.Expression>;
  callable: Set<string>;
  imported: Set<string>;
}

function readSource(filePath: string): ts.SourceFile | null {
  if (!fs.existsSync(filePath) || !SOURCE_EXTENSION_PATTERN.test(filePath)) return null;
  return ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
}

function importsExtensionApi(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== PI_CODING_AGENT_PACKAGE
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((element) => (element.propertyName ?? element.name).text === 'ExtensionAPI')
    );
  });
}

function isHostLoadedEntry(relativePath: string, sourceFile: ts.SourceFile, declaredEntries: Set<string>): boolean {
  const stem = sourceStem(relativePath);
  if (stem && declaredEntries.has(stem)) return true;
  return SOURCE_ENTRY_PATTERN.test(relativePath) && importsExtensionApi(sourceFile);
}

function factoryBindings(sourceFile: ts.SourceFile): FactoryBindings {
  const bindings: FactoryBindings = { aliases: new Map(), callable: new Set(), imported: new Set() };
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) bindings.callable.add(statement.name.text);
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      if (statement.importClause.name) bindings.imported.add(statement.importClause.name.text);
      const namedBindings = statement.importClause.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) bindings.imported.add(element.name.text);
      }
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
        bindings.callable.add(declaration.name.text);
      } else {
        bindings.aliases.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return bindings;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isFactoryExpression(expression: ts.Expression, bindings: FactoryBindings, seen = new Set<string>()): boolean {
  const unwrapped = unwrapExpression(expression);
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped) || ts.isCallExpression(unwrapped)) {
    return true;
  }
  if (!ts.isIdentifier(unwrapped)) return false;
  const name = unwrapped.text;
  if (bindings.callable.has(name) || bindings.imported.has(name)) return true;
  if (seen.has(name)) return false;
  const alias = bindings.aliases.get(name);
  if (!alias) return false;
  seen.add(name);
  return isFactoryExpression(alias, bindings, seen);
}

function hasDefaultFactory(sourceFile: ts.SourceFile): boolean {
  const bindings = factoryBindings(sourceFile);
  return sourceFile.statements.some((statement) => {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      return true;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return isFactoryExpression(statement.expression, bindings);
    }
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      return false;
    }
    return statement.exportClause.elements.some((element) => {
      if (element.name.text !== 'default') return false;
      if (statement.moduleSpecifier) return true;
      const localName = (element.propertyName ?? element.name).text;
      return isFactoryExpression(ts.factory.createIdentifier(localName), bindings);
    });
  });
}

export const piExtensionDefaultFactory: RuleDefinition = {
  preflight: true,
  rule: 'Pi-loaded extension entries must expose a callable default factory export',
  rationale:
    'Pi and DoomPi loaders invoke module.default, so a named-only factory silently leaves the requested extension inactive.',
  passExamples: ['export function activate(pi: ExtensionAPI): void { /* ... */ }\nexport { activate as default };'],
  failExamples: ['export function activate(pi: ExtensionAPI): void { /* ... */ }'],
  check(filePath, configRoot) {
    const relativePath = projectPath(filePath, configRoot);
    const sourceFile = readSource(filePath);
    if (!relativePath || !sourceFile || !isHostLoadedEntry(relativePath, sourceFile, hostEntryStems(configRoot))) {
      return null;
    }
    return hasDefaultFactory(sourceFile)
      ? null
      : 'Pi-loaded extension entry must expose a callable default factory; named-only factories are not loaded.';
  },
};
