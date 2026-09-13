import * as fs from 'node:fs';
import * as path from 'node:path';

import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import ts from 'typescript';

import { projectPath } from './manifestEntries.js';
import { readManifest } from './webPlugin.js';

const CONTRACTS = '@agimon-ai/doompi-core';
const ALLOWED_DOOM_DEPENDENCIES = new Set([CONTRACTS, '@agimon-ai/doompi-core/kernel']);
// These feature names belong to their package owners, including type-only contracts.
const FEATURE_NAME =
  /(?:^|[^a-z])(?:author|voice|goal|loop|workflow|git|runner)(?=[^a-z]|$)|^(?:Author|Voice|Goal|Loop|Workflow|Git|Runner)(?=[A-Z])|^(?:AUTHOR|VOICE|GOAL|LOOP|WORKFLOW|GIT|RUNNER)(?:_|$)/u;
// A generic payload field such as `goal` or `runner` does not establish feature ownership.
const FEATURE_SYMBOL =
  /^(?:Author|Voice|Goal|Loop|Workflow|Git|Runner)(?=[A-Z])|^(?:AUTHOR|VOICE|GOAL|LOOP|WORKFLOW|GIT|RUNNER)_/u;

export const neutralExtensionContracts: RuleDefinition = {
  preflight: true,
  rule: 'Extension contracts contain neutral host protocols, never feature-owned schemas, tool names, or dependencies',
  rationale:
    'Moving feature constants or schemas into core reverses ownership even when imports are type-only. Feature packages publish their own contracts; core supplies generic registration and communication primitives.',
  check(filePath, configRoot) {
    if (readManifest(configRoot)?.name !== CONTRACTS || !fs.existsSync(filePath)) return null;
    const relative = projectPath(filePath, configRoot);
    if (!relative) return null;
    const problems = new Set<string>();
    const checkReference = (value: string) => {
      const name = value.match(/^@agimon-ai\/doompi(?:-[^/]+)?/u)?.[0];
      if (name && !ALLOWED_DOOM_DEPENDENCIES.has(name)) problems.add(`feature dependency ${name}`);
    };
    if (relative === 'package.json') {
      const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const dependency of Object.keys((manifest[key] ?? {}) as object)) checkReference(dependency);
      }
      for (const entry of Object.keys((manifest.exports ?? {}) as object)) {
        if (FEATURE_NAME.test(entry)) problems.add(`feature export ${entry}`);
      }
    } else if (relative.startsWith('src/') && /\.[cm]?tsx?$/u.test(relative)) {
      if (FEATURE_NAME.test(path.basename(relative))) problems.add(`feature file ${relative}`);
      const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteralLike(node.moduleSpecifier)
        )
          checkReference(node.moduleSpecifier.text);
        if (ts.isIdentifier(node) && FEATURE_SYMBOL.test(node.text)) problems.add(`feature symbol ${node.text}`);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    return problems.size
      ? `Keep extension-contracts neutral: ${[...problems].join(', ')}. Move these contracts to the owning feature package.`
      : null;
  },
};
