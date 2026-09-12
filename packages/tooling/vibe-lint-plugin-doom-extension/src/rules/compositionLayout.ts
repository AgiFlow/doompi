import * as fs from 'node:fs';
import ts from 'typescript';
import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import { projectPath } from './manifestEntries.js';

const FORBIDDEN_PATH = /^src\/(?:adapters|container|containers|commands|providers)(?:\/|$)/u;

export const compositionLayout: RuleDefinition = {
  preflight: true,
  rule: 'Composed packages use direct extension entries and flat public exports',
  rationale:
    'Extensions are host entries; public exports expose selected shared APIs. Old adapters and containers must not remain as alternate implementations.',
  check(filePath, configRoot) {
    const relative = projectPath(filePath, configRoot);
    if (!relative) return null;
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    if (FORBIDDEN_PATH.test(relative)) {
      return `Forbidden composition path ${relative}. Use controllers, services, models, tools, extensions, and flat public exports.`;
    }
    if (!relative.startsWith('src/exports/')) return null;
    if (relative.slice('src/exports/'.length).includes('/')) {
      return `Nested export path ${relative} is forbidden. Keep public entries directly under src/exports.`;
    }
    if (!/\.[cm]?tsx?$/u.test(relative)) return `Export entry ${relative} must be a TypeScript forwarding module.`;
    const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
    return source.statements.length > 0 &&
      source.statements.every(
        (statement) =>
          ts.isExportDeclaration(statement) &&
          !statement.moduleSpecifier?.getText(source).match(/^['"]\.\.\/extensions\//u),
      )
      ? null
      : 'src/exports entries forward shared public APIs only; move extension entries into src/extensions.';
  },
};
