import * as fs from 'node:fs';
import * as path from 'node:path';

import type { RuleDefinition } from '@agimon-ai/vibe-lint';

const PACKAGE_MANIFEST_NAME = 'package.json';
const SOURCE_ROOT = 'src';
/** Files a package ships and an agent can read on demand, so never eager prompt text. */
const SHIPPED_FILE = /['"][\w./@-]+\.(?:md|txt)['"]/i;
const CONTEXT_KIND = /kind:\s*'context'/g;
/** A resource that declares a condition is absent from the default prompt. */
const GATED = /\bwhen:\s*\{/;
/** The placeholder families that used to be pasted into the prompt on a failed read. */
const PLACEHOLDER = /\(resource unavailable/;
/** A hand-rolled package-root walk, which is what resolved into dist/ and missed. */
const LOCAL_ROOT_WALK = /new URL\('(?:\.\.\/)+'\s*,\s*import\.meta\.url\)/;

function sourceFiles(directory: string, found: string[] = []): string[] {
  if (!fs.existsSync(directory)) return found;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '(frontend)') continue;
      sourceFiles(full, found);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** The object literal a match sits in, found by balancing braces back from the match. */
function enclosingLiteral(source: string, index: number): string {
  let depth = 0;
  let start = index;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (source[cursor] === '}') depth += 1;
    else if (source[cursor] === '{') {
      if (depth === 0) {
        start = cursor;
        break;
      }
      depth -= 1;
    }
  }
  depth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    if (source[cursor] === '{') depth += 1;
    else if (source[cursor] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, cursor + 1);
    }
  }
  return source.slice(start);
}

function violations(configRoot: string): string[] {
  const problems: string[] = [];
  for (const file of sourceFiles(path.join(configRoot, SOURCE_ROOT))) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(configRoot, file);
    for (const match of source.matchAll(CONTEXT_KIND)) {
      const literal = enclosingLiteral(source, match.index);
      // A `when` gate is the accepted answer as well as `skill`. The cost this rule
      // guards is the default prompt, and a gated resource contributes nothing until
      // its mode is active, which is how the Help catalog indexes are registered.
      if (SHIPPED_FILE.test(literal) && !GATED.test(literal)) {
        problems.push(
          `${relative}: kind 'context' reads a shipped file; ship it as kind 'skill', or gate it with a \`when\` clause so it stays out of the default prompt`,
        );
      }
    }
    if (PLACEHOLDER.test(source) || LOCAL_ROOT_WALK.test(source)) {
      problems.push(
        `${relative}: resolve shipped files with packageResourcePath/readPackageResource from @agimon-ai/doompi-core/server-facet`,
      );
    }
  }
  return problems;
}

export const doomResourceKind: RuleDefinition = {
  preflight: true,
  rule: 'Resource kinds match their prompt cost: context is live state, shipped files are skills',
  rationale:
    "kind 'context' is eager - its text is pasted into the system prompt on every build - while kind 'skill' sends only a name, description and path for the agent to read on demand. Registering a shipped file as context bills its full length every turn. A hand-rolled package-root walk resolves into dist/ at runtime and silently substitutes placeholder prose into the prompt.",
  check(filePath, configRoot) {
    if (path.resolve(filePath) !== path.join(path.resolve(configRoot), PACKAGE_MANIFEST_NAME)) return null;
    const problems = violations(configRoot);
    return problems.length > 0 ? `Invalid Doom resource kinds: ${problems.join('; ')}` : null;
  },
};
