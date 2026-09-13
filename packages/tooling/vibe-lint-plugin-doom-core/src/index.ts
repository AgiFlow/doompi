import fs from 'node:fs';
import path from 'node:path';

import type { RuleDefinition, VibeLintPlugin } from '@agimon-ai/vibe-lint';
import ts from 'typescript';
const folders = new Set([
  'systems',
  'services',
  'types',
  'schemas',
  'models',
  'constants',
  'extensions',
  'pi',
  'server',
  'web',
  'testing',
  'exports',
]);
const runtimeDependencies = new Set([
  '@agimon-ai/doompi-core',
  '@agimon-ai/doompi-telemetry',
  '@agimon-ai/doompi-web-security',
]);
export const architecture: RuleDefinition = {
  preflight: true,
  rule: 'Keep Doompi core ownership explicit in folders, imports, and package exports',
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
      const visit = (node: ts.Node): void => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteralLike(node.moduleSpecifier)
        ) {
          const reference = node.moduleSpecifier.text;
          const dependency = reference.match(/^@agimon-ai\/doompi(?:-[^/]+)?/)?.[0];
          if (dependency && !runtimeDependencies.has(dependency)) problems.push(`Downstream dependency: ${dependency}`);
          if (/doompi-(?:extension-contracts|web-contracts|kernel)(?:\/|$)/.test(reference))
            problems.push(`Removed package: ${reference}`);
          if (reference.includes('/src/')) problems.push(`Import a package capability export: ${reference}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    if (relative === 'package.json') {
      const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies'])
        for (const dependency of Object.keys((manifest[section] ?? {}) as object))
          if (dependency.startsWith('@agimon-ai/doompi') && !runtimeDependencies.has(dependency))
            problems.push(`Downstream dependency: ${dependency}`);
    }
    return problems.length ? [...new Set(problems)].join('\n') : null;
  },
};
const plugin: VibeLintPlugin = {
  name: 'doom-core',
  rules: { 'doom-core-architecture': architecture },
  patterns: { ownership: { description: architecture.rule, includes: ['src/**/*.ts', 'package.json'] } },
  configs: { recommended: { rules: { 'doom-core-architecture': 'error' } } },
};
export default plugin;
