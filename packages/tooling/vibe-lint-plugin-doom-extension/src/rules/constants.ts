import * as fs from 'node:fs';
import * as path from 'node:path';

import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import ts from 'typescript';

import { projectPath } from './manifestEntries.js';

const METADATA_NAME =
  /^(?:COMMAND_NAME|COMMAND_DESCRIPTION|[A-Z][A-Z0-9_]*_COMMAND_NAME|[A-Z][A-Z0-9_]*_COMMAND_DESCRIPTION|[A-Z][A-Z0-9_]*_GUIDANCE)$/u;

function constantExpression(node: ts.Expression): boolean {
  if (ts.isLiteralExpression(node) || ts.isIdentifier(node)) return true;
  if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind))
    return true;
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node))
    return constantExpression(node.expression);
  if (ts.isPrefixUnaryExpression(node))
    return (
      [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator) && constantExpression(node.operand)
    );
  if (ts.isPropertyAccessExpression(node)) return constantExpression(node.expression);
  if (ts.isSpreadElement(node)) return constantExpression(node.expression);
  if (ts.isBinaryExpression(node))
    return (
      [
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken,
        ts.SyntaxKind.AsteriskAsteriskToken,
      ].includes(node.operatorToken.kind) &&
      constantExpression(node.left) &&
      constantExpression(node.right)
    );
  if (ts.isArrayLiteralExpression(node)) return node.elements.every((element) => constantExpression(element));
  if (ts.isObjectLiteralExpression(node))
    return node.properties.every(
      (property) =>
        ts.isShorthandPropertyAssignment(property) ||
        (ts.isPropertyAssignment(property) &&
          !ts.isComputedPropertyName(property.name) &&
          constantExpression(property.initializer)),
    );
  if (ts.isTemplateExpression(node)) return node.templateSpans.every((span) => constantExpression(span.expression));
  return false;
}

export const doomConstants: RuleDefinition = {
  preflight: true,
  rule: 'Command metadata and guidance live in src/constants, whose modules contain only constant data and constants imports',
  rationale:
    'One lowest dependency layer keeps shared metadata reusable by server and browser without importing implementations.',
  check(filePath, configRoot) {
    const relative = projectPath(filePath, configRoot);
    if (!relative?.startsWith('src/') || !/\.[cm]?tsx?$/u.test(relative) || !fs.existsSync(filePath)) return null;
    const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
    const constants = relative.startsWith('src/constants/');
    const problems: string[] = [];
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            !constants &&
            ts.isIdentifier(declaration.name) &&
            METADATA_NAME.test(declaration.name.text) &&
            !(declaration.initializer && ts.isRegularExpressionLiteral(declaration.initializer))
          )
            problems.push(`move ${declaration.name.text} to src/constants`);
          if (
            constants &&
            (!(statement.declarationList.flags & ts.NodeFlags.Const) ||
              !ts.isIdentifier(declaration.name) ||
              !declaration.initializer ||
              !constantExpression(declaration.initializer))
          )
            problems.push('constants must be const declarations initialized with data, without executable behavior');
        }
      } else if (constants && (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) {
        const specifier = statement.moduleSpecifier;
        if (!specifier) continue;
        const target =
          ts.isStringLiteral(specifier) && specifier.text.startsWith('.')
            ? projectPath(path.resolve(path.dirname(filePath), specifier.text), configRoot)
            : undefined;
        if (!target?.startsWith('src/constants/'))
          problems.push('constants may import or re-export only other src/constants modules');
      } else if (constants && !ts.isEmptyStatement(statement)) {
        problems.push('constants modules cannot contain implementations, types, or executable statements');
      }
    }
    return problems.length ? [...new Set(problems)].join('; ') : null;
  },
};
