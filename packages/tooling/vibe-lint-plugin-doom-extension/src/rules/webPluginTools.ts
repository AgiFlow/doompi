import * as path from 'node:path';
import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import ts from 'typescript';
import { projectPath } from './manifestEntries.js';
import { pluginBlocks, readManifest, readSource, walkSources, WEB_ROOT } from './webPlugin.js';

/**
 * Every Pi tool a package registers gets a cockpit item. The rule reads the
 * tool definitions out of `src/**` (an object literal with `name`,
 * `parameters`, and `execute`), resolves each `name` as far as a literal or
 * a package-local const goes, and checks that `src/web/**` claims it in a
 * `toolRenderers` entry, or carries a `matches` renderer for a name only
 * known at runtime.
 */

const SRC_ROOT = 'src';
const PACKAGE_MANIFEST_NAME = 'package.json';
const TEST_FILE = /\.(?:test|spec)\.[cm]?tsx?$/;
const TEST_DIRECTORIES = new Set(['__tests__', 'fixtures']);
const IGNORE_MARKER = /web-plugin-tool-renderers:\s*ignore\s+([\w-]+)/g;
const MODULE_EXTENSIONS = ['.ts', '.mts', '.tsx'];
const REQUIRED_TOOL_MEMBERS = ['name', 'parameters', 'execute'];

type ResolvedName =
  | { kind: 'literal'; name: string }
  | { kind: 'dynamic'; text: string }
  | { kind: 'unresolvable'; text: string };

interface ToolDefinition {
  resolved: ResolvedName;
  /** Repo-relative path of the file holding the definition. */
  file: string;
}

function memberName(member: ts.ObjectLiteralElementLike): string | undefined {
  const name = member.name;
  if (name === undefined) return undefined;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

/** Strips the wrappers a literal hides behind: parentheses, `as const`, `satisfies`. */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function stringLiteralValue(expression: ts.Expression | undefined): string | undefined {
  if (expression === undefined) return undefined;
  const value = unwrap(expression);
  return ts.isStringLiteralLike(value) ? value.text : undefined;
}

function isExported(statement: ts.VariableStatement): boolean {
  return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function stringArrayValues(expression: ts.Expression | undefined): string[] | undefined {
  if (expression === undefined) return undefined;
  const value = unwrap(expression);
  if (!ts.isArrayLiteralExpression(value)) return undefined;
  const values: string[] = [];
  for (const element of value.elements) {
    const item = unwrap(element);
    if (!ts.isStringLiteralLike(item)) return undefined;
    values.push(item.text);
  }
  return values;
}

/** The top-level const declarations of a file, all of them or only the exported ones. */
function topLevelConsts(sourceFile: ts.SourceFile, exportedOnly: boolean): ts.VariableDeclaration[] {
  const declarations: ts.VariableDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    if (exportedOnly && !isExported(statement)) continue;
    declarations.push(...statement.declarationList.declarations);
  }
  return declarations;
}

/** The top-level `const NAMES = ['a', 'b']` bindings of a file. */
function arrayConstants(sourceFile: ts.SourceFile, exportedOnly: boolean): Map<string, string[]> {
  const arrays = new Map<string, string[]>();
  for (const declaration of topLevelConsts(sourceFile, exportedOnly)) {
    if (!ts.isIdentifier(declaration.name)) continue;
    const values = stringArrayValues(declaration.initializer);
    if (values !== undefined) arrays.set(declaration.name.text, values);
  }
  return arrays;
}

/**
 * The top-level `const NAME = 'literal'` bindings of a file, including the
 * names a `const [A, B] = NAMES` destructuring takes from a string array
 * declared in the file or, when the file's location is known, imported from
 * a relative src/ module.
 */
function stringConstants(
  sourceFile: ts.SourceFile,
  exportedOnly: boolean,
  location?: { filePath: string; configRoot: string },
): Map<string, string> {
  const constants = new Map<string, string>();
  const arrays = arrayConstants(sourceFile, exportedOnly);
  for (const declaration of topLevelConsts(sourceFile, exportedOnly)) {
    if (ts.isIdentifier(declaration.name)) {
      const value = stringLiteralValue(declaration.initializer);
      if (value !== undefined) constants.set(declaration.name.text, value);
      continue;
    }
    if (!ts.isArrayBindingPattern(declaration.name) || declaration.initializer === undefined) continue;
    const source = unwrap(declaration.initializer);
    let values = stringArrayValues(source);
    if (values === undefined && ts.isIdentifier(source)) {
      values =
        arrays.get(source.text) ??
        (location === undefined
          ? undefined
          : importedArray(source, sourceFile, location.filePath, location.configRoot));
    }
    if (values === undefined) continue;
    declaration.name.elements.forEach((element, index) => {
      const value = values[index];
      if (ts.isBindingElement(element) && ts.isIdentifier(element.name) && value !== undefined) {
        constants.set(element.name.text, value);
      }
    });
  }
  return constants;
}

/** The module a relative specifier names, tried with the extension spellings the repo uses. */
function resolveRelativeModule(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier).replace(/\.(?:js|mjs|cjs|ts|mts|tsx)$/, '');
  for (const extension of MODULE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    const source = readSource(candidate);
    if (source !== null) return candidate;
  }
  return undefined;
}

/** The named import binding `identifier`, with its source when that is a relative src/ module. */
function importedBinding(
  identifier: ts.Identifier,
  sourceFile: ts.SourceFile,
  filePath: string,
  configRoot: string,
): { exportedName: string; moduleSource: ts.SourceFile | null } | 'bare' | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const element = bindings.elements.find((entry) => entry.name.text === identifier.text);
    if (element === undefined) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) return 'bare';
    const exportedName = (element.propertyName ?? element.name).text;
    const modulePath = resolveRelativeModule(filePath, specifier);
    const relative = modulePath === undefined ? null : projectPath(modulePath, configRoot);
    if (modulePath === undefined || relative === null || !relative.startsWith(`${SRC_ROOT}/`)) {
      return { exportedName, moduleSource: null };
    }
    return { exportedName, moduleSource: readSource(modulePath) };
  }
  return undefined;
}

/** The string array `identifier` imports from a relative src/ module, one hop deep. */
function importedArray(
  identifier: ts.Identifier,
  sourceFile: ts.SourceFile,
  filePath: string,
  configRoot: string,
): string[] | undefined {
  const binding = importedBinding(identifier, sourceFile, filePath, configRoot);
  if (binding === undefined || binding === 'bare' || binding.moduleSource === null) return undefined;
  return arrayConstants(binding.moduleSource, true).get(binding.exportedName);
}

/** Resolves the identifier a `name` property points at, one import hop deep. */
function resolveIdentifier(
  identifier: ts.Identifier,
  sourceFile: ts.SourceFile,
  filePath: string,
  configRoot: string,
): ResolvedName {
  const local = stringConstants(sourceFile, false, { filePath, configRoot }).get(identifier.text);
  if (local !== undefined) return { kind: 'literal', name: local };
  const binding = importedBinding(identifier, sourceFile, filePath, configRoot);
  if (binding === undefined) return { kind: 'dynamic', text: identifier.text };
  if (binding === 'bare' || binding.moduleSource === null) return { kind: 'unresolvable', text: identifier.text };
  const value = stringConstants(binding.moduleSource, true).get(binding.exportedName);
  return value === undefined ? { kind: 'unresolvable', text: identifier.text } : { kind: 'literal', name: value };
}

function resolveName(
  node: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
  configRoot: string,
): ResolvedName {
  for (const member of node.properties) {
    if (memberName(member) !== 'name') continue;
    if (ts.isShorthandPropertyAssignment(member))
      return resolveIdentifier(member.name, sourceFile, filePath, configRoot);
    if (!ts.isPropertyAssignment(member)) break;
    const value = unwrap(member.initializer);
    if (ts.isStringLiteralLike(value)) return { kind: 'literal', name: value.text };
    if (ts.isIdentifier(value)) return resolveIdentifier(value, sourceFile, filePath, configRoot);
    return { kind: 'dynamic', text: value.getText(sourceFile) };
  }
  return { kind: 'dynamic', text: '(no name)' };
}

function isToolDefinition(node: ts.ObjectLiteralExpression): boolean {
  const names = new Set(node.properties.map(memberName));
  return REQUIRED_TOOL_MEMBERS.every((member) => names.has(member));
}

function isTestPath(filePath: string): boolean {
  return TEST_FILE.test(filePath) || filePath.split(path.sep).some((segment) => TEST_DIRECTORIES.has(segment));
}

/** The Pi tool definitions under src/** and the names the package marked as intentionally unrendered. */
function toolDefinitions(configRoot: string): { tools: ToolDefinition[]; ignored: Set<string> } {
  const tools: ToolDefinition[] = [];
  const ignored = new Set<string>();
  for (const filePath of walkSources(path.join(configRoot, SRC_ROOT))) {
    if (isTestPath(filePath)) continue;
    const sourceFile = readSource(filePath);
    if (sourceFile === null) continue;
    const text = sourceFile.getFullText();
    for (const match of text.matchAll(IGNORE_MARKER)) {
      if (match[1] !== undefined) ignored.add(match[1]);
    }
    if (!text.includes('execute') || !text.includes('parameters')) continue;
    const relative = projectPath(filePath, configRoot) ?? filePath;
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node) && isToolDefinition(node)) {
        tools.push({ resolved: resolveName(node, sourceFile, filePath, configRoot), file: relative });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { tools, ignored };
}

/** The tool names web/** claims in `tools: [...]` entries, and whether any renderer carries `matches`. */
function webClaims(configRoot: string): { claimed: Set<string>; hasMatcher: boolean } {
  const sources = walkSources(path.join(configRoot, WEB_ROOT))
    .map((filePath) => readSource(filePath))
    .filter((source): source is ts.SourceFile => source !== null);
  const strings = new Map<string, string>();
  for (const source of sources) for (const [name, value] of stringConstants(source, false)) strings.set(name, value);
  const arrays = new Map<string, string[]>();
  const arrayValues = (expression: ts.Expression): string[] | undefined => {
    const value = unwrap(expression);
    if (!ts.isArrayLiteralExpression(value)) return undefined;
    const names: string[] = [];
    for (const element of value.elements) {
      const item = unwrap(element);
      if (ts.isStringLiteralLike(item)) names.push(item.text);
      else if (ts.isIdentifier(item) && strings.has(item.text)) names.push(strings.get(item.text) ?? '');
      else if (ts.isSpreadElement(item) && ts.isIdentifier(item.expression))
        names.push(...(arrays.get(item.expression.text) ?? []));
    }
    return names;
  };
  for (const source of sources) {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
        const values = arrayValues(declaration.initializer);
        if (values !== undefined) arrays.set(declaration.name.text, values);
      }
    }
  }
  const claimed = new Set<string>();
  let hasMatcher = false;
  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const tools = node.properties.find((member) => memberName(member) === 'tools');
        if (tools !== undefined) {
          if (node.properties.some((member) => memberName(member) === 'matches')) hasMatcher = true;
          if (ts.isPropertyAssignment(tools)) {
            const value = unwrap(tools.initializer);
            const names = ts.isIdentifier(value) ? arrays.get(value.text) : arrayValues(value);
            for (const name of names ?? []) claimed.add(name);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { claimed, hasMatcher };
}

export const webPluginToolRenderers: RuleDefinition = {
  preflight: true,
  rule: 'Every Pi tool a package registers has a cockpit renderer: its name is claimed by a toolRenderers entry in web/, or a matches renderer covers a name only known at runtime',
  rationale:
    "A tool without a web renderer falls back to the cockpit's generic item, so the package's own view of its calls (the TUI's renderCall and renderResult) is missing from the browser. The name is read from the registerTool definition in src/ and matched against the toolRenderers claims in web/, so a renamed or newly added tool fails here rather than going unnoticed on a user machine.",
  check(filePath, configRoot) {
    if (projectPath(filePath, configRoot) !== PACKAGE_MANIFEST_NAME) return null;
    const manifest = readManifest(configRoot);
    if (manifest === null) return null;
    const { tools, ignored } = toolDefinitions(configRoot);
    if (tools.length === 0) return null;
    if (pluginBlocks(manifest).length === 0) {
      const named = tools.flatMap((tool) =>
        tool.resolved.kind === 'literal' ? [tool.resolved.name] : [tool.resolved.text],
      );
      return `This package registers Pi tools (${named.join(', ')}) but ships no doompiWeb plugin to render them; add one with scaffold-doom-web-plugin, then a toolRenderers entry per tool.`;
    }
    const { claimed, hasMatcher } = webClaims(configRoot);
    const missing: string[] = [];
    const unresolvable: string[] = [];
    for (const tool of tools) {
      if (tool.resolved.kind === 'literal') {
        if (!claimed.has(tool.resolved.name) && !ignored.has(tool.resolved.name)) {
          missing.push(`${tool.resolved.name} (${tool.file})`);
        }
      } else if (tool.resolved.kind === 'dynamic') {
        if (!hasMatcher) missing.push(`${tool.resolved.text} (${tool.file}, computed at runtime)`);
      } else {
        unresolvable.push(`${tool.resolved.text} (${tool.file})`);
      }
    }
    if (missing.length === 0) return null;
    const notChecked =
      unresolvable.length > 0 ? ` Not checked (name imported from a package): ${unresolvable.join(', ')}.` : '';
    return `src/web renders no item for: ${missing.join(', ')}. List each name in a toolRenderers entry of the doompiWeb client entry (tools: [...], or a const array in src/web/**), give a runtime-named tool a renderer with matches(...), or mark it '// web-plugin-tool-renderers: ignore <name>' beside its definition.${notChecked}`;
  },
};
