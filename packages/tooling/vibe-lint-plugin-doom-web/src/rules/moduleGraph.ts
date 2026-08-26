import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

export type WebSide = 'client' | 'server';

export interface WebLocation {
  side: WebSide;
  layer: string | undefined;
  feature: string | undefined;
}

export function projectPath(filePath: string, configRoot: string): string | null {
  const root = path.resolve(configRoot);
  const target = path.resolve(filePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  return path.relative(root, target).split(path.sep).join('/');
}

/**
 * A web package has two source trees under one src: the browser bundle in
 * src/web and the server in the remaining roots. Which tree a path belongs to
 * decides both the layer vocabulary and whether the two may see each other.
 */
export function locate(filePath: string, configRoot: string): WebLocation | null {
  const relativePath = projectPath(filePath, configRoot);
  if (!relativePath) return null;
  const parts = relativePath.split('/');
  if (parts[0] !== 'src' || parts.length < 2) return null;
  if (parts[1] !== 'web') return { side: 'server', layer: parts[1], feature: undefined };
  return { side: 'client', layer: parts[2], feature: parts[2] === 'features' ? parts[3] : undefined };
}

export function relativeTarget(filePath: string, specifier: string, configRoot: string): WebLocation | null {
  if (!specifier.startsWith('.')) return null;
  return locate(path.resolve(path.dirname(filePath), specifier), configRoot);
}

export function readSource(filePath: string): ts.SourceFile | null {
  if (!fs.existsSync(filePath) || !SOURCE_EXTENSIONS.has(path.extname(filePath))) return null;
  return ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
}

export function collectSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}
