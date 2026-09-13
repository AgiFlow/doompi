import fs from 'node:fs';
import path from 'node:path';

import type { RuleDefinition, VibeLintPlugin } from '@agimon-ai/vibe-lint';
import ts from 'typescript';
const folders = new Set(['bin', 'cli', 'composition', 'builders', 'compiler', 'extensions', 'exports', 'prompts']);
export const architecture: RuleDefinition = {
  preflight: true,
  rule: 'Keep Doompi cli ownership explicit in folders, imports, and package exports',
  rationale:
    'Core owns reusable runtime logic. CLI builders and composition select and wire features. Feature-specific policies remain in their owning packages.',
  check(filePath, configRoot) {
    if (!fs.existsSync(filePath)) return null;
    const relative = path.relative(configRoot, filePath).replaceAll(path.sep, '/');
    const problems: string[] = [];
    if (relative.startsWith('src/') && !folders.has(relative.split('/')[1]!))
      problems.push(`Unsupported source folder: ${relative}`);
    if (relative.startsWith('src/') && /\.[cm]?tsx?$/.test(relative)) {
      const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
      const checkReference = (reference: string): void => {
        const target = reference.startsWith('.')
          ? path
              .relative(configRoot, path.resolve(path.dirname(filePath), reference))
              .split(path.sep)
              .join('/')
          : undefined;
        if (
          (relative.startsWith('src/builders/') || relative.startsWith('src/composition/')) &&
          target?.startsWith('src/cli/')
        )
          problems.push(`Subsystem code cannot depend on command handling: ${reference}`);
        if (relative.startsWith('src/compiler/') && target && /^src\/(?:cli|builders|composition)\//.test(target))
          problems.push(`Compiler mechanics cannot depend on distribution policy: ${reference}`);
      };
      const visit = (node: ts.Node): void => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteralLike(node.moduleSpecifier)
        ) {
          const reference = node.moduleSpecifier.text;
          checkReference(reference);
          if (/doompi-(?:extension-contracts|web-contracts|kernel)(?:\/|$)/.test(reference))
            problems.push(`Removed package: ${reference}`);
          if (reference.includes('/src/')) problems.push(`Import a package capability export: ${reference}`);
        }
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments[0] &&
          ts.isStringLiteralLike(node.arguments[0])
        )
          checkReference(node.arguments[0].text);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    return problems.length ? [...new Set(problems)].join('\n') : null;
  },
};
const plugin: VibeLintPlugin = {
  name: 'doom-cli',
  rules: { 'doom-cli-architecture': architecture },
  patterns: { ownership: { description: architecture.rule, includes: ['src/**/*.ts', 'package.json'] } },
  configs: { recommended: { rules: { 'doom-cli-architecture': 'error' } } },
};
export default plugin;
